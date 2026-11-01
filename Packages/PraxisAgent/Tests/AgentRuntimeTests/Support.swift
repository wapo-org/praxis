import Foundation
import Synchronization
import AgentCore
import AgentSkills
import AgentJS
import AgentMCP
import AgentTestSupport
@testable import AgentRuntime

/// A modern (2026-07-28) MCP server answering JSON-RPC over a
/// `ScriptedTransport`. Its tool list can change between listings.
final class FakeMCPServer: Sendable {
    private final class State: Sendable {
        let value: Mutex<(tools: [JSONValue], calls: [(name: String, arguments: JSONValue)])>
        init(_ tools: [JSONValue]) { value = Mutex((tools, [])) }
    }

    let config: MCPServerConfig
    private let state: State
    let transport: ScriptedTransport

    init(id: String = "s1", name: String = "Acme", tools: [JSONValue], trusted: Bool = false, enabled: Bool = true) {
        config = MCPServerConfig(id: id, name: name, url: URL(string: "https://\(id).mcp.test/mcp")!,
                                 trusted: trusted, enabled: enabled)
        let state = State(tools)
        self.state = state
        transport = ScriptedTransport { request, _ in
            let rpc = request.httpBody.flatMap { try? JSONValue(parsing: $0) } ?? [:]
            let id = rpc["id"] ?? .null
            func reply(_ result: JSONValue) -> ScriptedTransport.Reply {
                .json(JSONValue.object(["jsonrpc": "2.0", "id": id, "result": result]).encodedString())
            }
            switch rpc["method"]?.stringValue {
            case "server/discover"?:
                return reply(["resultType": "complete", "supportedVersions": ["2026-07-28"], "capabilities": ["tools": [:]],
                              "_meta": ["io.modelcontextprotocol/serverInfo": ["name": "fake", "version": "1.0"]]])
            case "tools/list"?:
                return reply(["tools": .array(state.value.withLock { $0.tools })])
            case "tools/call"?:
                let name = rpc["params"]?["name"]?.stringValue ?? ""
                state.value.withLock { $0.calls.append((name, rpc["params"]?["arguments"] ?? [:])) }
                return reply(["content": [["type": "text", "text": .string("\(name) ok")]], "isError": false])
            default:
                return .json(JSONValue.object(["jsonrpc": "2.0", "id": id,
                                               "error": ["code": -32601, "message": "Method not found"]]).encodedString())
            }
        }
    }

    func setTools(_ tools: [JSONValue]) { state.value.withLock { $0.tools = tools } }
    var calls: [(name: String, arguments: JSONValue)] { state.value.withLock { $0.calls } }

    func client(config override: MCPServerConfig? = nil) -> MCPClient {
        MCPClient(config: override ?? config, transport: transport, secrets: InMemorySecretStore(),
                  options: MCPClientOptions(requestTimeout: .seconds(5), callTimeout: .seconds(5)))
    }

    static func tool(_ name: String, readOnly: Bool? = nil) -> JSONValue {
        var annotations: [String: JSONValue] = [:]
        if let readOnly { annotations["readOnlyHint"] = .bool(readOnly) }
        return ["name": .string(name), "description": .string("Does \(name)"),
                "inputSchema": ["type": "object", "properties": ["q": ["type": "string"]]],
                "annotations": .object(annotations)]
    }
}

/// The app's installed connectors, mutable to simulate removal.
final class Connectors: Sendable {
    private let clients: Mutex<[String: MCPClient]>
    init(_ clients: [MCPClient]) { self.clients = Mutex(Dictionary(uniqueKeysWithValues: clients.map { ($0.config.id, $0) })) }
    func remove(_ id: String) { _ = clients.withLock { $0.removeValue(forKey: id) } }
    func set(_ client: MCPClient) { clients.withLock { $0[client.config.id] = client } }
    func client(_ id: String) -> MCPClient? { clients.withLock { $0[id] } }
}

/// A skill store over a temp directory, removed on deinit.
final class SkillFolder {
    let url: URL
    let store: SkillStore

    init(_ skills: [String: String] = [:]) {
        url = FileManager.default.temporaryDirectory.appending(path: "runtime-skills-\(UUID().uuidString)", directoryHint: .isDirectory)
        try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        store = SkillStore(bundledDirectory: nil, importedDirectory: url)
        for (name, description) in skills { write(name, description) }
    }

    deinit { try? FileManager.default.removeItem(at: url) }

    /// Places a skill by hand; call `store.reload()` afterwards.
    func write(_ name: String, _ description: String) {
        let dir = url.appending(path: name, directoryHint: .isDirectory)
        try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try! Data("---\nname: \(name)\ndescription: \(description)\n---\n\n# \(name)\n\nDo the \(name) thing.\n".utf8)
            .write(to: dir.appending(path: "SKILL.md"))
    }
}

func makeRuntime(skills: SkillStore? = nil, connectors: Connectors = Connectors([]),
                 jsRunner: QuickJSRunner = QuickJSRunner()) -> AgentRuntime {
    AgentRuntime(skillStore: skills, jsRunner: jsRunner, providerTransport: ScriptedTransport(replies: []),
                 mcpClient: { connectors.client($0) })
}

func request(_ setup: ConversationSetup, _ text: String = "hi", mode: AgentMode = .auto, effort: Effort = .high,
             webSearch: Bool = false, approvals: any ApprovalHandler = AutoApprove(),
             maxOutputTokens: Int? = nil) -> RunRequest {
    RunRequest(conversationID: "c1", model: "m", setup: setup, transcript: [.user(text)], mode: mode, effort: effort,
               webSearch: webSearch, approvals: approvals, maxOutputTokens: maxOutputTokens)
}

extension [AgentEvent] {
    var committed: [Message] { flatMap { if case .committed(let m) = $0 { return m }; return [] } }
    var toolResults: [ToolResult] { committed.flatMap(\.toolResults) }
    var outcome: RunOutcome? { compactMap { if case .finished(let o) = $0 { return o }; return nil }.last }
}
