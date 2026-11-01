import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentMCP

private func definition(_ name: String, readOnly: Bool? = nil, destructive: Bool? = nil, idempotent: Bool? = nil,
                        openWorld: Bool? = nil, title: String? = nil, schema: JSONValue = ["type": "object", "properties": ["q": ["type": "string"]]]) -> MCPToolDefinition {
    MCPToolDefinition(name: name, title: title, description: "Does \(name)", inputSchema: schema,
                      annotations: MCPToolAnnotations(readOnlyHint: readOnly, destructiveHint: destructive,
                                                      idempotentHint: idempotent, openWorldHint: openWorld))
}

private let idle = ScriptedTransport(replies: [])

@Suite struct ToolAdapterTests {
    @Test func traitsFromAnnotations() {
        #expect(MCPToolAnnotations(readOnlyHint: true).traits == [.readOnly, .openWorld])
        #expect(MCPToolAnnotations().traits == [.destructive, .openWorld]) // spec defaults
        #expect(MCPToolAnnotations(destructiveHint: false, openWorldHint: false).traits == [])
        #expect(MCPToolAnnotations(readOnlyHint: true, destructiveHint: true, idempotentHint: true).traits == [.readOnly, .idempotent, .openWorld])
    }

    @Test func namingSchemaAndPresentation() throws {
        let client = makeClient(idle, config: MCPServerConfig(id: "s1", name: "Acme Corp!", url: acmeURL))
        let toolset = MCPToolset(listings: [(client, [
            definition("create.issue", title: "Create issue", schema: ["$schema": "https://json-schema.org/draft/2020-12/schema", "title": "Args",
                                                                     "type": "object", "properties": ["t": ["type": "string", "title": "T"]]]),
            definition("create_issue"),
            definition(String(repeating: "very_long_tool_name_", count: 5)),
            definition("no_schema", schema: ["type": "object"]),
        ])])
        let names = toolset.tools.map(\.spec.name)
        #expect(!toolset.isGateway)
        #expect(Set(names).count == 4)
        #expect(names.allSatisfy { $0.count <= 64 && $0.range(of: "^[a-zA-Z0-9_-]+$", options: .regularExpression) != nil })
        #expect(names.contains("mcp__acme_corp__create_issue"))
        #expect(names.filter { $0.hasPrefix("mcp__acme_corp__create_issue_") }.count == 1) // the collision got a suffix

        let create = try #require(toolset.catalog.first { $0.definition.name == "create.issue" })
        #expect(create.spec.description == "Acme Corp!: Does create.issue")
        #expect(create.spec.inputSchema["$schema"] == nil)
        #expect(create.spec.inputSchema["title"] == nil)
        #expect(create.spec.inputSchema["properties"]?["t"]?["title"] == "T") // nested kept
        #expect(create.source == .mcp(serverID: "s1", serverName: "Acme Corp!"))
        #expect(create.traits == [.destructive, .openWorld])
        let p = create.presentation(for: [:])
        #expect(p.category == .integration)
        #expect(p.runningTitle == "Acme Corp!: Create issue…")

        let bare = try #require(toolset.catalog.first { $0.definition.name == "no_schema" })
        #expect(bare.spec.inputSchema == ["type": "object", "properties": [:]])

        // Naming is deterministic across builds.
        let again = MCPToolset(listings: [(client, toolset.catalog.map(\.definition).reversed())])
        #expect(Set(again.tools.map(\.spec.name)) == Set(names))
    }

    @Test func sameSlugOnTwoServersStaysUnique() {
        let a = makeClient(idle, config: MCPServerConfig(id: "a", name: "GitHub", url: acmeURL))
        let b = makeClient(idle, config: MCPServerConfig(id: "b", name: "github", url: acmeURL))
        let toolset = MCPToolset(listings: [(a, [definition("search")]), (b, [definition("search")])])
        let names = toolset.tools.map(\.spec.name)
        #expect(names.count == 2)
        #expect(Set(names).count == 2)
        #expect(names[0] == "mcp__github__search")
    }

    @Test func executeMapsResultAndReportsProgress() async throws {
        let png = Data([1, 2, 3])
        let transport = ScriptedTransport(handler: Fake.modern(tools: [Fake.tool("snap", readOnly: true)]) { request in
            let token = request.params["_meta"]?["progressToken"] ?? .null
            return Fake.sse([
                ["jsonrpc": "2.0", "method": "notifications/progress", "params": ["progressToken": token, "progress": 50, "total": 100]],
                Fake.message(id: request.rpc!["id"]!, result: [
                    "content": [["type": "image", "data": .string(png.base64EncodedString()), "mimeType": "image/png"]],
                    "structuredContent": ["w": 1],
                ]),
            ])
        })
        let client = makeClient(transport)
        let toolset = await MCPToolset.build(servers: [client])
        let tool = try #require(toolset.tools.first)
        let progress = Box<ToolProgress>()
        let output = try await tool.execute(ToolInvocation(id: "c1", name: tool.spec.name, arguments: ["q": "x"]),
                                            context: ToolContext(conversationID: "c", mode: .auto, emit: { progress.append($0) }))
        #expect(output.content == [.image(MediaData(mediaType: "image/png", data: png)), .text(#"{"w":1}"#)])
        #expect(progress.all.first == .trace(.api, #"acme.snap({"q":"x"})"#))
        #expect(progress.all.contains(.status("50/100")))
    }

    @Test func serverErrorsBecomeErrorOutputs() async throws {
        let transport = ScriptedTransport(handler: Fake.modern { request in
            Fake.error(request, code: -32602, message: "Unknown tool: search")
        })
        let toolset = await MCPToolset.build(servers: [makeClient(transport)])
        let tool = try #require(toolset.tools.first)
        let output = try await tool.execute(ToolInvocation(id: "c1", name: tool.spec.name, arguments: [:]),
                                            context: ToolContext(conversationID: "c", mode: .auto))
        #expect(output.isError)
        #expect(output.text.contains("Unknown tool: search"))
    }

    @Test func buildReportsFailingServersAndSkipsDisabled() async throws {
        let failing = ScriptedTransport { _, _ in Reply(status: 401, headers: ["WWW-Authenticate": "Bearer"], body: Data()) }
        let ok = ScriptedTransport(handler: Fake.modern())
        var disabled = acmeConfig()
        disabled.id = "off"
        disabled.enabled = false
        let toolset = await MCPToolset.build(servers: [
            makeClient(failing, config: MCPServerConfig(id: "bad", name: "Bad", url: URL(string: "https://bad.test/mcp")!)),
            makeClient(ok),
            makeClient(ScriptedTransport(replies: []), config: disabled),
        ])
        #expect(toolset.tools.map(\.spec.name) == ["mcp__acme__search"])
        #expect(toolset.failures.map(\.serverID) == ["bad"])
        #expect(toolset.failures.first?.authRequirement == .tokenHeader)
    }
}

@Suite struct GatewayTests {
    private func toolset(trusted: Bool = false, threshold: Int = 1, transport: ScriptedTransport = idle) -> MCPToolset {
        let client = makeClient(transport, config: acmeConfig(trusted: trusted))
        return MCPToolset(listings: [(client, [definition("search", readOnly: true), definition("delete_repo", destructive: true)])],
                          threshold: threshold)
    }

    @Test func exposesTrioAboveThreshold() {
        let set = toolset(threshold: 1)
        #expect(set.isGateway)
        #expect(set.tools.map(\.spec.name) == ["mcp_search_tools", "mcp_describe_tool", "mcp_call_tool"])
        #expect(set.specs.map(\.name).sorted() == ["mcp__acme__delete_repo", "mcp__acme__search"])
        #expect(!toolset(threshold: 30).isGateway)
        // Direct tools stay callable from code (JS code mode) without being offered.
        #expect(set.hiddenTools.map(\.spec.name).sorted() == ["mcp__acme__delete_repo", "mcp__acme__search"])
        #expect(toolset(threshold: 30).hiddenTools.isEmpty)
    }

    @Test func callToolSubjectIsTheTarget() throws {
        let set = toolset()
        let call = try #require(set.tools.first { $0.spec.name == "mcp_call_tool" })
        let target = try #require(set.catalog.first { $0.definition.name == "delete_repo" })
        let subject = try #require(call.subject(for: ["tool": "mcp__acme__delete_repo", "arguments": ["repo": "x"]]))
        #expect(subject == ToolSubject(spec: target.spec, source: target.source, traits: target.traits))
        #expect(subject.name == "mcp__acme__delete_repo")
        #expect(subject.source == .mcp(serverID: "s1", serverName: "Acme"))
        #expect(ToolPolicy.alwaysAllowKey(for: subject) == ToolPolicy.alwaysAllowKey(for: target))
        // Bare MCP name resolves when unambiguous.
        #expect(call.subject(for: ["tool": "delete_repo"]) == subject)
        #expect(call.subject(for: ["tool": "nope"]) == nil)
        #expect(call.subject(for: [:]) == nil)
        #expect(ToolPolicy().decide(call, arguments: ["tool": "nope"], mode: .auto)
                == .refuse(reason: "Unknown tool “nope”. Use mcp_search_tools to find tool names."))
        #expect(call.presentation(for: ["tool": "mcp__acme__delete_repo"]).runningTitle == "Acme: delete_repo…")
    }

    @Test func searchAndDescribe() async throws {
        let set = toolset()
        let search = try #require(set.tools.first { $0.spec.name == "mcp_search_tools" })
        let describe = try #require(set.tools.first { $0.spec.name == "mcp_describe_tool" })
        let ctx = ToolContext(conversationID: "c", mode: .ask)
        #expect(ToolPolicy().decide(search, mode: .ask) == .allow) // local lookup, allowed even in Ask

        let found = try await search.execute(ToolInvocation(id: "1", name: search.spec.name, arguments: ["query": "delete repository"]), context: ctx)
        #expect(found.text.hasPrefix("- mcp__acme__delete_repo"))
        let none = try await search.execute(ToolInvocation(id: "2", name: search.spec.name, arguments: ["query": "x", "server": "Other"]), context: ctx)
        #expect(none.text.contains("No matching tools"))

        let described = try await describe.execute(ToolInvocation(id: "3", name: describe.spec.name, arguments: ["tool": "mcp__acme__search"]), context: ctx)
        #expect(described.text.contains("\"properties\""))
        let unknown = try await describe.execute(ToolInvocation(id: "4", name: describe.spec.name, arguments: ["tool": "zzz"]), context: ctx)
        #expect(unknown.isError)
    }

    @Test func untrustedDestructiveTargetAsksForApprovalThroughTheLoop() async throws {
        let transport = ScriptedTransport(handler: Fake.modern(tools: []) { request in
            Fake.result(request, Fake.text("deleted \(request.params["arguments"]?["repo"]?.stringValue ?? "?")"))
        })
        let set = toolset(transport: transport)
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("t1", "mcp_call_tool", #"{"tool": "mcp__acme__delete_repo", "arguments": {"repo": "web"}}"#)]),
            ScriptedProvider.text("Done"),
        ])
        let approver = RecordingApprover(.allowOnce)
        let loop = AgentLoop(provider: provider, tools: ToolRegistry(set.tools), policy: ToolPolicy(), approvals: approver)
        let events = await loop.run(transcript: [.user("delete it")],
                                    configuration: AgentRunConfiguration(conversationID: "c", model: "m", system: "s", mode: .auto)).collect()

        let request = try #require(approver.requests.first)
        #expect(request.toolName == "mcp__acme__delete_repo")
        #expect(request.source == .mcp(serverID: "s1", serverName: "Acme"))
        #expect(request.title == "Acme: delete_repo…")
        let result = try #require(provider.requests.last?.messages.last?.toolResults.first)
        #expect(result.content == [.text("deleted web")])
        #expect(!result.isError)
        #expect(events.contains { if case .finished(.completed) = $0 { return true }; return false })
        let call = try #require(transport.requests.first { $0.rpcMethod == "tools/call" })
        #expect(call.json?["params"]?["name"] == "delete_repo")
        #expect(call.header("Mcp-Name") == "delete_repo")
    }

    @Test func trustedReadOnlyTargetRunsWithoutApprovalAndDeniedOnesDont() async throws {
        let transport = ScriptedTransport(handler: Fake.modern(tools: []))
        let set = toolset(trusted: true, transport: transport)
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([
                ("t1", "mcp_call_tool", #"{"tool": "mcp__acme__search", "arguments": "{\"q\": \"x\"}"}"#),
                ("t2", "mcp_call_tool", #"{"tool": "mcp__acme__delete_repo", "arguments": {}}"#),
            ]),
            ScriptedProvider.text("Done"),
        ])
        let approver = RecordingApprover(.deny)
        let policy = ToolPolicy(trustedSources: MCPToolset.trustedSources([acmeConfig(trusted: true)]))
        let loop = AgentLoop(provider: provider, tools: ToolRegistry(set.tools), policy: policy, approvals: approver)
        _ = await loop.run(transcript: [.user("go")],
                           configuration: AgentRunConfiguration(conversationID: "c", model: "m", system: "s", mode: .build)).collect()
        #expect(approver.requests.map(\.toolName) == ["mcp__acme__delete_repo"])
        let results = try #require(provider.requests.last?.messages.last?.toolResults)
        #expect(results.map(\.isError) == [false, true])
        let calls = transport.requests.filter { $0.rpcMethod == "tools/call" }
        #expect(calls.count == 1)
        #expect(calls.first?.json?["params"]?["arguments"] == ["q": "x"]) // stringified arguments parsed
    }
}
