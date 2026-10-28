import Foundation
import Testing
import AgentCore
import AgentMCP
import AgentTestSupport
@testable import AgentRuntime

/// Resource tools are decided at prepare time from the server's
/// capabilities and frozen with the conversation.
@Suite struct ResourceFreezeTests {
    /// A modern server that offers resources.
    private func resourceServer(id: String = "r1", name: String = "Docs") -> MCPClient {
        let transport = ScriptedTransport { request, _ in
            let rpc = request.httpBody.flatMap { try? JSONValue(parsing: $0) } ?? [:]
            let rid = rpc["id"] ?? .null
            func reply(_ result: JSONValue) -> ScriptedTransport.Reply {
                .json(JSONValue.object(["jsonrpc": "2.0", "id": rid, "result": result]).encodedString())
            }
            switch rpc["method"]?.stringValue {
            case "server/discover"?:
                return reply(["resultType": "complete", "supportedVersions": ["2026-07-28"],
                              "capabilities": ["tools": [:], "resources": [:]]])
            case "tools/list"?:
                return reply(["tools": [FakeMCPServer.tool("find", readOnly: true)]])
            case "resources/read"?:
                return reply(["contents": [["uri": rpc["params"]?["uri"] ?? "", "text": "hello"]]])
            default:
                return reply([:])
            }
        }
        return MCPClient(config: MCPServerConfig(id: id, name: name, url: URL(string: "https://\(id).mcp.test/mcp")!),
                         transport: transport, secrets: InMemorySecretStore(),
                         options: MCPClientOptions(requestTimeout: .seconds(5), callTimeout: .seconds(5)))
    }

    @Test func resourceToolsAreFrozenOnlyForServersThatOfferThem() async throws {
        let plain = FakeMCPServer(tools: [FakeMCPServer.tool("search")])
        let connectors = Connectors([plain.client(), resourceServer()])
        let runtime = makeRuntime(connectors: connectors)

        let setup = await runtime.prepare(mcpServerIDs: ["s1", "r1"], includeJavaScript: false, includeSkills: false).setup
        #expect(setup.mcpServers.map(\.offersResources) == [true, nil]) // sorted by id: r1, s1
        let names = setup.toolSpecs.map(\.name)
        #expect(names.contains(MCPResourceTools.listName))
        #expect(names.contains(MCPResourceTools.readName))
        let read = try #require(setup.toolSpecs.first { $0.name == MCPResourceTools.readName })
        #expect(read.inputSchema["properties"]?["server"]?["enum"] == ["docs"])

        // Round trip keeps it; the tools execute against the live client.
        let restored = try JSONDecoder().decode(ConversationSetup.self, from: JSONEncoder().encode(setup))
        #expect(restored == setup)
        let registry = await runtime.tools(for: restored, conversationID: "c")
        let tool = try #require(registry.tool(named: MCPResourceTools.readName))
        let output = try await tool.execute(ToolInvocation(id: "1", name: tool.spec.name, arguments: ["uri": "note://1"]),
                                            context: ToolContext(conversationID: "c", mode: .auto))
        #expect(output.text.contains("hello"))

        // Removed later: the spec stays, calls are refused.
        connectors.remove("r1")
        let after = await runtime.tools(for: restored, conversationID: "c")
        let gone = try #require(after.tool(named: MCPResourceTools.readName))
        #expect(gone.spec == read)
        #expect(gone.subject(for: ["uri": "note://1"]) == nil)
        #expect(gone.unavailableReason(for: ["uri": "note://1"]).contains("removed"))
    }

    @Test func noResourceServersNoResourceTools() async throws {
        let runtime = makeRuntime(connectors: Connectors([FakeMCPServer(tools: [FakeMCPServer.tool("search")]).client()]))
        let setup = await runtime.prepare(mcpServerIDs: ["s1"], includeJavaScript: false, includeSkills: false).setup
        #expect(!setup.toolSpecs.contains { $0.name.hasPrefix("mcp_") && $0.name.contains("resource") })
        // Older setups (no offersResources key) decode the same.
        let data = try JSONEncoder().encode(setup)
        #expect(!String(decoding: data, as: UTF8.self).contains("offersResources"))
    }
}
