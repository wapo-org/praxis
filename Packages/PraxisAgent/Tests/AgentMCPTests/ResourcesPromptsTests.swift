import Foundation
import Testing
import Synchronization
import AgentCore
import AgentTestSupport
@testable import AgentMCP

/// A modern server with resources (+ templates, paging) and prompts.
enum Library {
    static let png = Data([0x89, 0x50, 0x4E, 0x47])

    static func capabilities(subscribe: Bool = false, listChanged: Bool = false) -> JSONValue {
        ["tools": ["listChanged": .bool(listChanged)],
         "resources": ["subscribe": .bool(subscribe), "listChanged": .bool(listChanged)],
         "prompts": ["listChanged": .bool(listChanged)]]
    }

    static func handler(capabilities: JSONValue = capabilities(), ttlMs: Double? = nil) -> @Sendable (URLRequest, Int) throws -> Reply {
        { request, _ in
            switch request.rpcMethod {
            case "server/discover"?:
                var discover = Fake.discover.objectValue ?? [:]
                discover["capabilities"] = capabilities
                return Fake.result(request, .object(discover))
            case "tools/list"?:
                return Fake.result(request, ["tools": [Fake.tool("search", readOnly: true)]])
            case "resources/list"?:
                if request.params["cursor"]?.stringValue == "p2" {
                    return Fake.result(request, ["resources": [["uri": "file:///c.txt", "name": "c.txt"]]])
                }
                return Fake.result(request, [
                    "resources": [
                        ["uri": "file:///a.md", "name": "a.md", "title": "Read me", "mimeType": "text/markdown", "description": "Project notes"],
                        ["uri": "file:///logo.png", "name": "logo.png", "mimeType": "image/png", "size": 4],
                    ],
                    "nextCursor": "p2",
                ])
            case "resources/templates/list"?:
                return Fake.result(request, ["resourceTemplates": [["uriTemplate": "file:///{path}", "name": "Files", "description": "Any file"]]])
            case "resources/read"?:
                let uri = request.params["uri"]?.stringValue ?? ""
                var result: [String: JSONValue]
                switch uri {
                case "file:///logo.png":
                    result = ["contents": [["uri": .string(uri), "mimeType": "image/png", "blob": .string(png.base64EncodedString())]]]
                case "file:///blob.bin":
                    result = ["contents": [["uri": .string(uri), "mimeType": "application/octet-stream", "blob": "AAEC"]]]
                default:
                    result = ["contents": [["uri": .string(uri), "mimeType": "text/markdown", "text": "# Notes"]]]
                }
                if let ttlMs { result["ttlMs"] = .number(ttlMs) }
                return Fake.result(request, .object(result))
            case "prompts/list"?:
                if request.params["cursor"]?.stringValue == "next" {
                    return Fake.result(request, ["prompts": [["name": "standup"]]])
                }
                return Fake.result(request, [
                    "prompts": [["name": "review", "title": "Review code", "description": "Ask for a review",
                                 "arguments": [["name": "code", "description": "The code", "required": true], ["name": "focus"]]]],
                    "nextCursor": "next",
                ])
            case "prompts/get"?:
                let code = request.params["arguments"]?["code"]?.stringValue ?? "?"
                if request.params["name"] == "standup" {
                    return Fake.result(request, ["messages": [
                        ["role": "user", "content": ["type": "text", "text": "What did I do?"]],
                        ["role": "assistant", "content": ["type": "text", "text": "Let me check."]],
                    ]])
                }
                return Fake.result(request, ["description": "Review", "messages": [
                    ["role": "user", "content": ["type": "text", "text": .string("Please review:\n\(code)")]],
                ]])
            default:
                return Fake.error(request, code: -32601, message: "Method not found")
            }
        }
    }
}

@Suite struct ResourcesPromptsTests {
    private func tools(_ client: MCPClient) -> (list: any AgentTool, read: any AgentTool) {
        let set = MCPResourceTools(servers: [MCPResourceTools.Server(id: "s1", name: "Acme", target: .live(client))]).tools
        return (set[0], set[1])
    }

    private let ctx = ToolContext(conversationID: "c", mode: .auto)

    @Test func listAndReadResourcesThroughTheTools() async throws {
        let transport = ScriptedTransport(handler: Library.handler())
        let client = makeClient(transport)
        let (list, read) = tools(client)
        #expect(list.spec.name == "mcp_list_resources")
        #expect(read.spec.name == "mcp_read_resource")
        // One server: `server` may be omitted.
        #expect(read.spec.inputSchema["required"] == ["uri"])

        let page = try await list.execute(ToolInvocation(id: "1", name: list.spec.name, arguments: [:]), context: ctx)
        #expect(!page.isError)
        #expect(page.text.contains("Read me — file:///a.md (text/markdown)"))
        #expect(page.text.contains("file:///{path} — Files: Any file"))
        #expect(page.text.contains(#"cursor "p2""#))
        let next = try await list.execute(ToolInvocation(id: "2", name: list.spec.name, arguments: ["cursor": "p2"]), context: ctx)
        #expect(next.text.contains("file:///c.txt"))
        #expect(!next.text.contains("Files")) // templates only on the first page

        let text = try await read.execute(ToolInvocation(id: "3", name: read.spec.name, arguments: ["uri": "file:///a.md"]), context: ctx)
        #expect(text.content == [.text("[resource file:///a.md, text/markdown]\n# Notes")])
        let image = try await read.execute(ToolInvocation(id: "4", name: read.spec.name, arguments: ["uri": "file:///logo.png"]), context: ctx)
        #expect(image.content == [.image(MediaData(mediaType: "image/png", data: Library.png, name: "file:///logo.png"))])
        let blob = try await read.execute(ToolInvocation(id: "5", name: read.spec.name, arguments: ["uri": "file:///blob.bin"]), context: ctx)
        #expect(blob.text.contains("3 bytes — not shown"))

        let call = try #require(transport.requests.first { $0.rpcMethod == "resources/read" })
        #expect(call.header("Mcp-Name") == "file:///a.md")
        #expect(call.header("Mcp-Method") == "resources/read")
    }

    @Test func policyFollowsTheServerAndUnknownServersAreRefused() async throws {
        let a = makeClient(ScriptedTransport(handler: Library.handler()))
        let b = makeClient(ScriptedTransport(handler: Library.handler()), config: MCPServerConfig(id: "s2", name: "Docs", url: acmeURL))
        let set = MCPResourceTools(servers: [
            .init(id: "s1", name: "Acme", target: .live(a)),
            .init(id: "s2", name: "Docs", target: .live(b)),
            .init(id: "s3", name: "Gone", target: .unavailable("The Gone connector was removed from the app.")),
        ]).tools
        let read = set[1]
        #expect(read.spec.inputSchema["required"] == ["server", "uri"])
        #expect(read.spec.inputSchema["properties"]?["server"]?["enum"] == ["acme", "docs", "gone"])

        let subject = try #require(read.subject(for: ["server": "docs", "uri": "x"]))
        #expect(subject.source == .mcp(serverID: "s2", serverName: "Docs"))
        #expect(subject.traits == [.readOnly, .idempotent])
        // Untrusted → asks in Build like any untrusted MCP read; trusted → runs.
        #expect(ToolPolicy().decide(subject, mode: .build) != .allow)
        #expect(ToolPolicy(trustedSources: ["mcp:s2"]).decide(subject, mode: .plan) == .allow)

        #expect(read.subject(for: ["uri": "x"]) == nil) // ambiguous
        #expect(read.unavailableReason(for: ["uri": "x"]).contains("acme, docs, gone"))
        #expect(read.subject(for: ["server": "gone", "uri": "x"]) == nil)
        #expect(read.unavailableReason(for: ["server": "Gone", "uri": "x"]) == "The Gone connector was removed from the app.")
    }

    @Test func readsAreCachedForTheServersTTLOnly() async throws {
        let cached = ScriptedTransport(handler: Library.handler(ttlMs: 60_000))
        let client = makeClient(cached)
        _ = try await client.readResource("file:///a.md")
        _ = try await client.readResource("file:///a.md")
        #expect(cached.requests.filter { $0.rpcMethod == "resources/read" }.count == 1)
        #expect(await client.isCached(resource: "file:///a.md"))

        let fresh = ScriptedTransport(handler: Library.handler())
        let other = makeClient(fresh)
        _ = try await other.readResource("file:///a.md")
        _ = try await other.readResource("file:///a.md")
        #expect(fresh.requests.filter { $0.rpcMethod == "resources/read" }.count == 2)
    }

    @Test func promptsListAllPagesAndGetFillsArguments() async throws {
        let transport = ScriptedTransport(handler: Library.handler())
        let client = makeClient(transport)
        let prompts = try await client.listPrompts()
        #expect(prompts.map(\.name) == ["review", "standup"])
        #expect(prompts[0].displayTitle == "Review code")
        #expect(prompts[0].arguments == [.init(name: "code", description: "The code", required: true), .init(name: "focus")])
        _ = try await client.listPrompts() // cached
        #expect(transport.requests.filter { $0.rpcMethod == "prompts/list" }.count == 2)

        let review = try await client.getPrompt("review", arguments: ["code": "let x = 1"])
        #expect(review.composerText == "Please review:\nlet x = 1")
        let get = try #require(transport.requests.first { $0.rpcMethod == "prompts/get" })
        #expect(get.json?["params"]?["arguments"] == ["code": "let x = 1"])
        #expect(get.header("Mcp-Name") == "review")

        let standup = try await client.getPrompt("standup")
        #expect(standup.composerText == "User: What did I do?\n\nAssistant: Let me check.")
    }

    @Test func featuresComeFromTheServersCapabilities() async throws {
        let client = makeClient(ScriptedTransport(handler: Library.handler(capabilities: Library.capabilities(subscribe: true))))
        let set = await MCPToolset.build(servers: [client])
        let features = try #require(set.features["s1"])
        #expect(features.resources && features.resourcesSubscribe && features.prompts)
        #expect(!features.toolsListChanged)
        let plain = makeClient(ScriptedTransport(handler: Fake.modern()))
        #expect(await MCPToolset.build(servers: [plain]).features["s1"]?.resources == false)
    }
}

// MARK: - Notifications

/// A modern server whose `subscriptions/listen` stream the test drives.
final class ListenServer: Sendable {
    let capabilities: JSONValue
    private let streams = Mutex<[AsyncThrowingStream<Data, Error>.Continuation]>([])
    let listens = Box<JSONValue>()
    /// How `subscriptions/listen` answers: "stream" or "unsupported".
    let mode: String
    init(capabilities: JSONValue, mode: String = "stream") {
        self.capabilities = capabilities
        self.mode = mode
    }

    func push(_ method: String, _ params: JSONValue = [:]) {
        let note: JSONValue = ["jsonrpc": "2.0", "method": .string(method), "params": params]
        let data = Data("event: message\ndata: \(note.encodedString())\n\n".utf8)
        streams.withLock { for s in $0 { s.yield(data) } }
    }

    /// Ends every open stream abruptly (no final response).
    func drop() { streams.withLock { for s in $0 { s.finish() }; $0.removeAll() } }

    func handle(_ request: URLRequest) async throws -> HTTPStreamResponse {
        if request.rpcMethod == "subscriptions/listen" {
            listens.append(request.params)
            if mode == "unsupported" { return LiveTransport.respond(Fake.error(request, code: -32601, message: "Method not found")) }
            let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
            streams.withLock { $0.append(continuation) }
            let id = request.rpc?["id"] ?? .null
            let ack: JSONValue = ["jsonrpc": "2.0", "method": "notifications/subscriptions/acknowledged",
                                  "params": ["_meta": ["io.modelcontextprotocol/subscriptionId": id],
                                             "notifications": request.params["notifications"] ?? [:]]]
            continuation.yield(Data(": keep-alive\n\nevent: message\ndata: \(ack.encodedString())\n\n".utf8))
            return HTTPStreamResponse(head: HTTPResponseHead(status: 200, headers: ["content-type": "text/event-stream"]), body: body)
        }
        return LiveTransport.respond(try Library.handler(capabilities: capabilities)(request, 0))
    }
}

@Suite struct NotificationTests {
    private func listeningClient(_ transport: any HTTPTransport, events: Box<MCPClientEvent>, maxFailures: Int = 5) -> MCPClient {
        MCPClient(config: acmeConfig(), transport: transport, secrets: InMemorySecretStore(),
                  options: MCPClientOptions(requestTimeout: .seconds(5), callTimeout: .seconds(5), listensForChanges: true,
                                            listenBackoff: { _ in .milliseconds(5) }, maxListenFailures: maxFailures),
                  onEvent: { event in events.append(event) })
    }

    @Test func toolsListChangedOnTheListenStreamDropsTheCacheAndTellsTheApp() async throws {
        let server = ListenServer(capabilities: Library.capabilities(listChanged: true))
        let transport = LiveTransport { try await server.handle($0) }
        let events = Box<MCPClientEvent>()
        let client = listeningClient(transport, events: events)

        _ = try await client.listTools()
        #expect(await eventually { server.listens.all.count == 1 })
        let filter = try #require(server.listens.all.first?["notifications"])
        #expect(filter == ["toolsListChanged": true, "promptsListChanged": true, "resourcesListChanged": true])
        let listen = try #require(transport.requests.first { $0.rpcMethod == "subscriptions/listen" })
        #expect(listen.headers["Mcp-Method"] == "subscriptions/listen")

        server.push("notifications/tools/list_changed")
        server.push("notifications/prompts/list_changed")
        #expect(await eventually { events.all.contains(.toolsListChanged) && events.all.contains(.promptsListChanged) })
        _ = try await client.listTools()
        #expect(transport.requests.filter { $0.rpcMethod == "tools/list" }.count == 2) // cache dropped
        await client.close()
        #expect(await client.isListening == false)
    }

    @Test func resourceUpdatesInvalidateTheWatchedRead() async throws {
        let server = ListenServer(capabilities: Library.capabilities(subscribe: true))
        let transport = LiveTransport { try await server.handle($0) }
        let events = Box<MCPClientEvent>()
        let client = listeningClient(transport, events: events)

        // Nothing to listen for until a resource is read.
        _ = try await client.listTools()
        #expect(await client.isListening == false)
        _ = try await client.readResource("file:///a.md")
        #expect(await client.isCached(resource: "file:///a.md")) // watched: cached without ttlMs
        #expect(await eventually { server.listens.all.last?["notifications"]?["resourceSubscriptions"] == ["file:///a.md"] })

        server.push("notifications/resources/updated", ["uri": "file:///a.md"])
        #expect(await eventually { events.all.contains(.resourceUpdated(uri: "file:///a.md")) })
        #expect(await client.isCached(resource: "file:///a.md") == false)
        await client.close()
    }

    @Test func aServerWithoutListenStopsQuietly() async throws {
        let server = ListenServer(capabilities: Library.capabilities(listChanged: true), mode: "unsupported")
        let transport = LiveTransport { try await server.handle($0) }
        let client = listeningClient(transport, events: Box())
        _ = try await client.listTools()
        #expect(await eventually { server.listens.all.count == 1 })
        #expect(await eventually { true })
        try await Task.sleep(for: .milliseconds(50))
        #expect(await client.isListening == false)
        _ = try await client.listTools(refresh: true) // doesn't re-arm on the same connection
        try await Task.sleep(for: .milliseconds(50))
        #expect(server.listens.all.count == 1)
    }

    @Test func droppedStreamsReconnectThenGiveUp() async throws {
        let server = ListenServer(capabilities: Library.capabilities(listChanged: true))
        let transport = LiveTransport { request in
            if request.rpcMethod == "subscriptions/listen" {
                server.listens.append(request.params)
                throw ProviderError.network("offline") // never comes up
            }
            return try await server.handle(request)
        }
        let client = listeningClient(transport, events: Box(), maxFailures: 3)
        _ = try await client.listTools()
        #expect(await eventually { server.listens.all.count == 4 }) // first try + 3 retries
        #expect(await eventually { true })
        try await Task.sleep(for: .milliseconds(80))
        #expect(server.listens.all.count == 4)
        #expect(await client.isListening == false)
        // A later request re-arms it.
        _ = try await client.listTools(refresh: true)
        #expect(await eventually { server.listens.all.count > 4 })
        await client.close()
    }

    @Test func legacyGetStreamDeliversNotificationsAnd405MeansNone() async throws {
        let events = Box<MCPClientEvent>()
        let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream(of: Data.self)
        let gets = Box<String>()
        let legacy = LiveTransport { request in
            if request.httpMethod == "GET" {
                gets.append("GET")
                return HTTPStreamResponse(head: HTTPResponseHead(status: 200, headers: ["content-type": "text/event-stream"]), body: body)
            }
            switch request.rpcMethod {
            case "server/discover"?: return LiveTransport.respond(Reply(status: 405, headers: [:], body: Data()))
            case "initialize"?:
                return LiveTransport.respond(Fake.result(request, ["protocolVersion": "2025-06-18",
                                                                   "capabilities": ["tools": ["listChanged": true]],
                                                                   "serverInfo": ["name": "old", "version": "1"]],
                                                         headers: ["Mcp-Session-Id": "sess-1"]))
            case "tools/list"?: return LiveTransport.respond(Fake.result(request, ["tools": [Fake.tool("search")]]))
            default: return LiveTransport.respond(Fake.accepted)
            }
        }
        let client = listeningClient(legacy, events: events)
        _ = try await client.listTools()
        #expect(await eventually { gets.all.count == 1 })
        let get = try #require(legacy.requests.first { $0.method == "GET" })
        #expect(get.headers["Mcp-Session-Id"] == "sess-1")
        continuation.yield(Data("data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n".utf8))
        #expect(await eventually { events.all == [.toolsListChanged] })
        await client.close()

        // 405 on GET: no stream, no retries.
        let noStream = LiveTransport { request in
            if request.httpMethod == "GET" { gets.append("405"); return LiveTransport.respond(Reply(status: 405, headers: [:], body: Data())) }
            return try await legacy.stream(request)
        }
        let other = listeningClient(noStream, events: Box())
        _ = try await other.listTools()
        try await Task.sleep(for: .milliseconds(60))
        #expect(gets.all.filter { $0 == "405" }.count == 1)
        #expect(await other.isListening == false)
    }
}
