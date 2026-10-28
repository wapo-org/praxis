import Foundation
import Testing
import AgentCore
import AgentSkills
import AgentJS
import AgentMCP
import AgentTestSupport
@testable import AgentRuntime

@Suite struct FreezeTests {
    private func onePrompt(_ runtime: AgentRuntime, _ setup: ConversationSetup) async -> ProviderRequest? {
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("ok")])
        _ = await runtime.run(request(setup), provider: provider).collect()
        return provider.requests.first
    }

    @Test func prefixSurvivesServerSkillAndRestartDrift() async throws {
        let skills = SkillFolder(["alpha": "Alpha things.", "beta": "Beta things."])
        let server = FakeMCPServer(tools: [FakeMCPServer.tool("search", readOnly: true), FakeMCPServer.tool("delete_thing")])
        let connectors = Connectors([server.client()])
        let runtime = makeRuntime(skills: skills.store, connectors: connectors)

        let prepared = await runtime.prepare(mcpServerIDs: ["s1"], instructions: "Be brief.")
        let setup = prepared.setup
        #expect(prepared.failures.isEmpty)
        #expect(setup.skillNames == ["alpha", "beta"])
        #expect(setup.mcpServers.map(\.tools.count) == [2])
        #expect(setup.systemPrompt.contains("- alpha: Alpha things."))
        #expect(setup.systemPrompt.contains("Acme (MCP connector): 2 tools."))
        #expect(setup.systemPrompt.contains("Be brief."))
        #expect(setup.toolSpecs.map(\.name) == ["delete_skill", "load_skill", "mcp__acme__delete_thing", "mcp__acme__search",
                                                "read_skill_file", "read_tool_output", "run_javascript", "save_skill"])

        let first = try #require(await onePrompt(runtime, setup))
        #expect(first.tools == setup.toolSpecs)
        #expect(first.system == setup.systemPrompt)

        // The server changes its tools; a skill is deleted, another imported.
        server.setTools([FakeMCPServer.tool("brand_new")])
        try await skills.store.remove(named: "alpha")
        skills.write("gamma", "Gamma things.")
        await skills.store.reload()
        let drifted = try #require(await onePrompt(runtime, setup))
        #expect(drifted.tools == first.tools)
        #expect(drifted.system == first.system)

        // Relaunch: setup decoded from disk, connector removed, a runner
        // whose memory cap (quoted in run_javascript's description) differs.
        let restored = try JSONDecoder().decode(ConversationSetup.self, from: JSONEncoder().encode(setup))
        #expect(restored == setup)
        connectors.remove("s1")
        let relaunched = makeRuntime(skills: skills.store, connectors: connectors,
                                     jsRunner: QuickJSRunner(configuration: .init(memoryLimit: 24 << 20)))
        let frozenJS = try #require(setup.toolSpecs.first { $0.name == RunJavaScriptTool.name })
        let live = RunJavaScriptTool(runner: relaunched.jsRunner, hostTools: setup.toolSpecs.filter { $0.name.hasPrefix("mcp__") })
        #expect(live.spec != frozenJS) // the live description really drifted
        let later = try #require(await onePrompt(relaunched, restored))
        #expect(later.tools == first.tools)
        #expect(later.system == first.system)
    }

    @Test func renamedServerKeepsFrozenNamesButCallsLiveClient() async throws {
        let server = FakeMCPServer(tools: [FakeMCPServer.tool("search", readOnly: true)])
        let connectors = Connectors([server.client()])
        let runtime = makeRuntime(connectors: connectors)
        let setup = await runtime.prepare(mcpServerIDs: ["s1"], includeJavaScript: false).setup

        var renamed = server.config
        renamed.name = "Acme Prod"
        connectors.set(server.client(config: renamed))
        let tools = await runtime.tools(for: setup, conversationID: "c1")
        #expect(tools.specs == setup.toolSpecs)

        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("t1", "mcp__acme__search", #"{"q":"x"}"#)]),
            ScriptedProvider.text("done"),
        ])
        let events = await runtime.run(request(setup), provider: provider).collect()
        #expect(server.calls.map(\.name) == ["search"])
        #expect(events.toolResults.first?.isError == false)
    }

    @Test func gatewayThreshold() async throws {
        let server = FakeMCPServer(tools: ["a", "b", "c"].map { FakeMCPServer.tool($0) })
        let runtime = makeRuntime(connectors: Connectors([server.client()]))

        let direct = await runtime.prepare(mcpServerIDs: ["s1"], gatewayThreshold: 3).setup
        #expect(direct.toolSpecs.map(\.name) == ["mcp__acme__a", "mcp__acme__b", "mcp__acme__c", "read_tool_output", "run_javascript"])

        let gateway = await runtime.prepare(mcpServerIDs: ["s1"], gatewayThreshold: 2).setup
        #expect(gateway.toolSpecs.map(\.name) == ["mcp_call_tool", "mcp_describe_tool", "mcp_search_tools", "read_tool_output", "run_javascript"])
        #expect(gateway.systemPrompt.contains("mcp_search_tools"))
        let js = try #require(gateway.toolSpecs.first { $0.name == RunJavaScriptTool.name })
        #expect(js.description.contains("tools.acme.a("))
        let tools = await runtime.tools(for: gateway, conversationID: "c1")
        #expect(tools.tool(named: "mcp__acme__a") == nil)
        #expect(tools.nestedTool(named: "mcp__acme__a") != nil) // reachable from code
    }

    @Test func prepareToleratesFailingServers() async throws {
        let good = FakeMCPServer(id: "s1", tools: [FakeMCPServer.tool("search")])
        let locked = MCPClient(config: MCPServerConfig(id: "s2", name: "Locked", url: URL(string: "https://locked.test/mcp")!),
                               transport: ScriptedTransport { _, _ in .json("{}", status: 401) }, secrets: InMemorySecretStore())
        let off = FakeMCPServer(id: "s3", name: "Off", tools: [FakeMCPServer.tool("x")], enabled: false)
        let runtime = makeRuntime(connectors: Connectors([good.client(), locked, off.client()]))

        let prepared = await runtime.prepare(mcpServerIDs: ["s1", "s2", "s3", "unknown"])
        #expect(prepared.setup.mcpServers.map(\.id) == ["s1"])
        let failure = try #require(prepared.failures.first)
        #expect(prepared.failures.count == 1)
        #expect(failure.serverID == "s2")
        #expect(failure.authRequirement != nil) // the app offers "Sign in"
    }

    @Test func newerSetupVersionIsRejected() async throws {
        let setup = await makeRuntime().prepare().setup
        #expect(setup.version == ConversationSetup.currentVersion)
        var json = try #require(try JSONValue(parsing: JSONEncoder().encode(setup)).objectValue)
        json["version"] = 99
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(ConversationSetup.self, from: Data(JSONValue.object(json).encodedString().utf8))
        }
    }
}
