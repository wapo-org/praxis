import Foundation
import Testing
import AgentCore
import AgentProviders
import AgentSkills
import AgentMCP
import AgentJS
import AgentTestSupport
@testable import AgentRuntime

@Suite struct RunTests {
    private func runCall(_ runtime: AgentRuntime, _ setup: ConversationSetup, tool: String, arguments: String,
                         approvals: any ApprovalHandler = AutoApprove()) async -> [AgentEvent] {
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("t1", tool, arguments)]),
            ScriptedProvider.text("done"),
        ])
        return await runtime.run(request(setup, approvals: approvals), provider: provider).collect()
    }

    // MARK: Frozen tools whose backing is gone

    @Test(arguments: [false, true])
    func removedConnectorToolReportsError(gateway: Bool) async throws {
        let server = FakeMCPServer(tools: [FakeMCPServer.tool("search", readOnly: true)])
        let connectors = Connectors([server.client()])
        let runtime = makeRuntime(connectors: connectors)
        let setup = await runtime.prepare(mcpServerIDs: ["s1"], gatewayThreshold: gateway ? 0 : 30).setup
        connectors.remove("s1")

        let approver = RecordingApprover(.allowOnce)
        let events = gateway
            ? await runCall(runtime, setup, tool: "mcp_call_tool", arguments: #"{"tool":"mcp__acme__search","arguments":{"q":"x"}}"#, approvals: approver)
            : await runCall(runtime, setup, tool: "mcp__acme__search", arguments: #"{"q":"x"}"#, approvals: approver)
        let result = try #require(events.toolResults.first)
        #expect(result.isError)
        #expect(result.content.first?.text?.contains("Acme connector was removed") == true)
        #expect(approver.requests.isEmpty) // no approval card for a call that can't run
        #expect(server.calls.isEmpty)
        #expect(events.outcome == .completed)
    }

    @Test func disabledConnectorToolSaysItIsOff() async throws {
        let server = FakeMCPServer(tools: [FakeMCPServer.tool("search", readOnly: true)])
        let connectors = Connectors([server.client()])
        let runtime = makeRuntime(connectors: connectors)
        let setup = await runtime.prepare(mcpServerIDs: ["s1"]).setup
        var off = server.config
        off.enabled = false
        connectors.set(server.client(config: off))

        let events = await runCall(runtime, setup, tool: "mcp__acme__search", arguments: #"{"q":"x"}"#)
        let result = try #require(events.toolResults.first)
        #expect(result.isError)
        #expect(result.content.first?.text?.contains("turned off") == true)
        #expect(server.calls.isEmpty)
    }

    @Test func connectorTurnedOffForTheConversationRefusesButStaysOffered() async throws {
        let server = FakeMCPServer(tools: [FakeMCPServer.tool("search", readOnly: true)])
        let runtime = makeRuntime(connectors: Connectors([server.client()]))
        let setup = await runtime.prepare(mcpServerIDs: ["s1"]).setup
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("t1", "mcp__acme__search", #"{"q":"x"}"#)]),
            ScriptedProvider.text("done"),
        ])
        var run = request(setup)
        run.disabledServerIDs = ["s1"]
        let events = await runtime.run(run, provider: provider).collect()
        let result = try #require(events.toolResults.first)
        #expect(result.isError)
        #expect(result.content.first?.text?.contains("for this conversation") == true)
        #expect(server.calls.isEmpty)
        #expect(provider.requests[0].tools.map(\.name) == setup.toolSpecs.map(\.name))
    }

    @Test func deletedSkillMakesLoadSkillFail() async throws {
        let skills = SkillFolder(["alpha": "Alpha things."])
        let runtime = makeRuntime(skills: skills.store)
        let setup = await runtime.prepare().setup

        let loaded = await runCall(runtime, setup, tool: "load_skill", arguments: #"{"name":"alpha"}"#)
        #expect(loaded.toolResults.first?.isError == false)

        try await skills.store.remove(named: "alpha")
        let events = await runCall(runtime, setup, tool: "load_skill", arguments: #"{"name":"alpha"}"#)
        let result = try #require(events.toolResults.first)
        #expect(result.isError)
        #expect(result.content.first?.text?.contains("no skill named “alpha”") == true)
    }

    @Test func toolMissingFromThisBuildStaysOfferedButRefuses() async throws {
        let skills = SkillFolder(["alpha": "Alpha things."])
        let setup = await makeRuntime(skills: skills.store).prepare().setup
        let withoutStore = makeRuntime() // the app stopped passing a skill store
        let tools = await withoutStore.tools(for: setup, conversationID: "c1")
        #expect(tools.specs == setup.toolSpecs)

        let events = await runCall(withoutStore, setup, tool: "load_skill", arguments: #"{"name":"alpha"}"#)
        #expect(events.toolResults.first?.isError == true)
    }

    // MARK: Code mode

    private func codeModeRun(trusted: Bool = false, tool: String, readOnly: Bool? = nil,
                             approval: ApprovalDecision) async throws -> (FakeMCPServer, RecordingApprover, [AgentEvent]) {
        let server = FakeMCPServer(tools: [FakeMCPServer.tool(tool, readOnly: readOnly), FakeMCPServer.tool("other")], trusted: trusted)
        let runtime = makeRuntime(connectors: Connectors([server.client()]))
        let setup = await runtime.prepare(mcpServerIDs: ["s1"], gatewayThreshold: 1).setup
        #expect(setup.toolSpecs.contains { $0.name == MCPGateway.callName })

        let code = "const r = await tools.acme.\(tool)({ q: 'x' }); return r;"
        let arguments = JSONValue.object(["code": .string(code)]).encodedString()
        let approver = RecordingApprover(approval)
        let events = await runCall(runtime, setup, tool: RunJavaScriptTool.name, arguments: arguments, approvals: approver)
        return (server, approver, events)
    }

    @Test func codeModeReachesGatewayHiddenToolThroughPolicy() async throws {
        let (server, approver, events) = try await codeModeRun(tool: "delete_thing", approval: .allowOnce)
        #expect(server.calls.map(\.name) == ["delete_thing"])
        #expect(server.calls.first?.arguments == ["q": "x"])
        // Untrusted server: treated as destructive, so auto mode asks.
        #expect(approver.requests.map(\.toolName) == ["mcp__acme__delete_thing"])
        let result = try #require(events.toolResults.first)
        #expect(!result.isError)
        #expect(result.content.first?.text?.contains("delete_thing ok") == true)
    }

    @Test func declinedNestedCallNeverReachesTheServer() async throws {
        let (server, approver, events) = try await codeModeRun(tool: "delete_thing", approval: .deny)
        #expect(approver.requests.count == 1)
        #expect(server.calls.isEmpty)
        #expect(events.toolResults.first?.isError == true)
    }

    @Test func trustedServerFromConfigSkipsApprovalForReadOnly() async throws {
        let (server, approver, _) = try await codeModeRun(trusted: true, tool: "search", readOnly: true, approval: .deny)
        #expect(approver.requests.isEmpty)
        #expect(server.calls.map(\.name) == ["search"])
    }

    // MARK: Provider capabilities

    @Test func plainChatWhenProviderHasNoTools() async throws {
        let server = FakeMCPServer(tools: [FakeMCPServer.tool("search")])
        let runtime = makeRuntime(connectors: Connectors([server.client()]))
        let setup = await runtime.prepare(mcpServerIDs: ["s1"]).setup

        let provider = ScriptedProvider(capabilities: Capabilities(tools: false), steps: [
            ScriptedProvider.toolCalls([("t1", "mcp__acme__search", "{}")]),
            ScriptedProvider.text("done"),
        ])
        let events = await runtime.run(request(setup), provider: provider).collect()
        let sent = try #require(provider.requests.first)
        #expect(sent.tools.isEmpty)
        #expect(sent.system == setup.systemPrompt)
        #expect(events.toolResults.first?.content.first?.text == "Unknown tool mcp__acme__search.")
        #expect(server.calls.isEmpty)
        #expect(setup.toolSpecs.count > 1) // still frozen for a tool-capable model later
    }

    @Test func webSearchGating() async throws {
        #expect(AgentRuntime.isWebSearchAvailable(on: try #require(ProviderPreset.anthropic.endpoint())))
        #expect(!AgentRuntime.isWebSearchAvailable(on: try #require(ProviderPreset.openAI.endpoint())))
        #expect(!AgentRuntime.isWebSearchAvailable(on: try #require(ProviderPreset.openRouterAnthropic.endpoint())))
        #expect(!AgentRuntime.isWebSearchAvailable(on: Capabilities(tools: false, serverWebSearch: true)))

        let runtime = makeRuntime()
        let setup = await runtime.prepare().setup
        for (capable, toggle, expected) in [(true, true, true), (true, false, false), (false, true, false)] {
            let provider = ScriptedProvider(capabilities: Capabilities(serverWebSearch: capable), steps: [ScriptedProvider.text("ok")])
            _ = await runtime.run(request(setup, webSearch: toggle), provider: provider).collect()
            #expect(provider.requests.first?.serverWebSearch == expected)
        }
    }

    @Test func effortSetsBudgets() async throws {
        let setup = await makeRuntime().prepare().setup
        for effort in Effort.allCases {
            let config = AgentRuntime.configuration(request(setup, effort: effort), capabilities: Capabilities())
            #expect(config.maxTokens == effort.defaultMaxTokens)
            #expect(config.maxIterations == effort.defaultMaxIterations)
            #expect(config.effort == effort)
        }
        let clamped = AgentRuntime.configuration(request(setup, effort: .max, maxOutputTokens: 20_000), capabilities: Capabilities())
        #expect(clamped.maxTokens == 20_000)

        let provider = ScriptedProvider(steps: [ScriptedProvider.text("ok")])
        _ = await makeRuntime().run(request(setup, effort: .low), provider: provider).collect()
        #expect(provider.requests.first?.maxTokens == Effort.low.defaultMaxTokens)
        #expect(provider.requests.first?.effort == .low)
    }

    @Test func truncatedOutputIsReadableInTheNextRun() async throws {
        let runtime = makeRuntime()
        let setup = await runtime.prepare(includeJavaScript: false).setup
        let spill = runtime.spills.spill(for: "c1")
        await spill.store(id: "old", text: String(repeating: "x", count: 100))

        let events = await runCall(runtime, setup, tool: "read_tool_output", arguments: #"{"id":"old","offset":90}"#)
        #expect(events.toolResults.first?.content.first?.text == "[characters 90–100 of 100]\nxxxxxxxxxx")
    }
}
