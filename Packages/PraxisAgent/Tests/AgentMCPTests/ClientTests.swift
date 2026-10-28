import Foundation
import Testing
import Synchronization
import AgentCore
import AgentTestSupport
@testable import AgentMCP

@Suite struct ModernClientTests {
    @Test func discoverListAndCall() async throws {
        let transport = ScriptedTransport(handler: Fake.modern(tools: [Fake.tool("search", readOnly: true)]) { r in
            Fake.result(r, Fake.text("found \(r.params["arguments"]?["q"]?.stringValue ?? "")"))
        })
        let cache = MCPEraCache()
        let client = makeClient(transport, eraCache: cache)

        let info = try await client.connect()
        #expect(info.era == .modern)
        #expect(info.name == "acme-mcp")
        #expect(info.instructions == "Use search first.")

        let tools = try await client.listTools()
        #expect(tools.map(\.name) == ["search"])
        let result = try await client.callTool("search", arguments: ["q": "bugs"])
        #expect(result.content == [.text("found bugs")])
        #expect(await cache.era(for: acmeURL) == .modern)

        let requests = transport.requests
        #expect(requests.map(\.rpcMethod) == ["server/discover", "tools/list", "tools/call"])
        for r in requests {
            #expect(r.method == "POST")
            #expect(r.header("MCP-Protocol-Version") == "2026-07-28")
            #expect(r.header("Accept") == "application/json, text/event-stream")
            #expect(r.header("Mcp-Session-Id") == nil)
            let meta = r.json?["params"]?["_meta"]
            #expect(meta?["io.modelcontextprotocol/protocolVersion"] == "2026-07-28")
            #expect(meta?["io.modelcontextprotocol/clientInfo"]?["name"] == "Praxis Chat")
        }
        #expect(requests[1].header("Mcp-Method") == "tools/list")
        #expect(requests[2].header("Mcp-Method") == "tools/call")
        #expect(requests[2].header("Mcp-Name") == "search")
    }

    @Test func paginatesAndCachesWithTTL() async throws {
        let transport = ScriptedTransport { request, _ in
            switch request.rpcMethod {
            case "server/discover"?: return Fake.result(request, Fake.discover)
            case "tools/list"?:
                if request.params["cursor"]?.stringValue == "p2" {
                    return Fake.result(request, ["tools": [Fake.tool("b"), Fake.tool("a")], "ttlMs": 60000])
                }
                return Fake.result(request, ["tools": [Fake.tool("a")], "nextCursor": "p2", "ttlMs": 120000])
            default: return Fake.error(request, code: -32601, message: "nope")
            }
        }
        let client = makeClient(transport)
        let tools = try await client.listTools()
        #expect(tools.map(\.name) == ["a", "b"]) // duplicate "a" dropped
        _ = try await client.listTools()
        #expect(transport.requests.filter { $0.rpcMethod == "tools/list" }.count == 2) // served from cache
        _ = try await client.listTools(refresh: true)
        #expect(transport.requests.filter { $0.rpcMethod == "tools/list" }.count == 4)
    }

    @Test func toolListExpiresAfterTTL() async throws {
        let clock = Mutex(Date(timeIntervalSince1970: 1000))
        let transport = ScriptedTransport { request, _ in
            request.rpcMethod == "tools/list"
                ? Fake.result(request, ["tools": [Fake.tool("a")], "ttlMs": 1000])
                : Fake.result(request, Fake.discover)
        }
        let client = makeClient(transport, options: MCPClientOptions(now: { clock.withLock { $0 } }))
        _ = try await client.listTools()
        _ = try await client.listTools()
        #expect(transport.requests.filter { $0.rpcMethod == "tools/list" }.count == 1)
        clock.withLock { $0 = $0.addingTimeInterval(2) }
        _ = try await client.listTools()
        #expect(transport.requests.filter { $0.rpcMethod == "tools/list" }.count == 2)
    }

    @Test func sseReplyDeliversProgressThenResult() async throws {
        let transport = ScriptedTransport(handler: Fake.modern { request in
            let token = request.params["_meta"]?["progressToken"] ?? .null
            return Fake.sse([
                ["jsonrpc": "2.0", "method": "notifications/progress", "params": ["progressToken": token, "progress": 1, "total": 4, "message": "Indexing"]],
                ["jsonrpc": "2.0", "method": "notifications/progress", "params": ["progressToken": "someone-else", "progress": 9]],
                Fake.message(id: request.rpc!["id"]!, result: Fake.text("indexed")),
            ])
        })
        let client = makeClient(transport)
        let seen = Box<MCPProgress>()
        let result = try await client.callTool("search", arguments: [:]) { seen.append($0) }
        #expect(result.content == [.text("indexed")])
        #expect(seen.all == [MCPProgress(progress: 1, total: 4, message: "Indexing")])
        #expect(seen.all.first?.label == "Indexing (1/4)")
    }

    @Test func mcpParamHeadersFromSchema() async throws {
        let schema: JSONValue = ["type": "object", "properties": [
            "region": ["type": "string", "x-mcp-header": "Region"],
            "query": ["type": "string"],
        ]]
        let bad: JSONValue = ["type": "object", "properties": ["n": ["type": "object", "x-mcp-header": "N"]]]
        let transport = ScriptedTransport(handler: Fake.modern(tools: [Fake.tool("geo", schema: schema), Fake.tool("broken", schema: bad)]))
        let client = makeClient(transport)
        let tools = try await client.listTools()
        #expect(tools.map(\.name) == ["geo"])
        #expect(await client.rejectedTools["broken"] != nil)
        _ = try await client.callTool("geo", arguments: ["region": "eu-west", "query": "x"])
        let call = try #require(transport.requests.last)
        #expect(call.header("Mcp-Param-Region") == "eu-west")
    }

    @Test func headerValuesUseBase64SentinelWhenNeeded() {
        #expect(MCPWire.headerValue("plain-value") == "plain-value")
        #expect(MCPWire.headerValue(" padded") == "=?base64?" + Data(" padded".utf8).base64EncodedString() + "?=")
        #expect(MCPWire.headerValue("café").hasPrefix("=?base64?"))
    }

    @Test func inputRequiredRoundTrip() async throws {
        let handler = StubElicitation(.accept(["name": "octocat"]))
        let transport = ScriptedTransport(handler: Fake.modern { request in
            if let responses = request.params["inputResponses"] {
                #expect(request.params["requestState"] == "opaque-1")
                let name = responses["login"]?["content"]?["name"]?.stringValue ?? "?"
                return Fake.result(request, Fake.text("hello \(name)"))
            }
            return Fake.result(request, [
                "resultType": "input_required",
                "inputRequests": ["login": ["method": "elicitation/create", "params": [
                    "mode": "form", "message": "Your GitHub username?",
                    "requestedSchema": ["type": "object", "properties": ["name": ["type": "string"]], "required": ["name"]],
                ]]],
                "requestState": "opaque-1",
            ])
        })
        let client = makeClient(transport, elicitation: handler)
        let result = try await client.callTool("search", arguments: [:])
        #expect(result.content == [.text("hello octocat")])
        let asked = try #require(handler.seen.all.first)
        #expect(asked.serverName == "Acme")
        #expect(asked.message == "Your GitHub username?")
        guard case .form(let schema) = asked.kind else { Issue.record("expected form"); return }
        #expect(schema["required"] == ["name"])
        // The discover request declared the capability.
        let caps = transport.requests[0].json?["params"]?["_meta"]?["io.modelcontextprotocol/clientCapabilities"]
        #expect(caps?["elicitation"] != nil)
        // Retry used a fresh JSON-RPC id.
        let ids = transport.requests.filter { $0.rpcMethod == "tools/call" }.compactMap { $0.json?["id"] }
        #expect(Set(ids).count == 2)
    }

    @Test func inputRequiredWithoutHandlerFails() async throws {
        let transport = ScriptedTransport(handler: Fake.modern { request in
            Fake.result(request, ["resultType": "input_required", "inputRequests": ["x": ["method": "elicitation/create", "params": ["message": "?"]]]])
        })
        let client = makeClient(transport)
        await #expect(throws: MCPError.self) { try await client.callTool("search") }
    }
}

@Suite struct LegacyClientTests {
    /// 2025-11-25 server with sessions; `expireFirstCall` answers the first
    /// tools/call with 404 to simulate an expired session.
    final class Server: Sendable {
        let sessions = Mutex(0)
        let expired = Mutex(false)
        let expireFirstCall: Bool
        init(expireFirstCall: Bool = false) { self.expireFirstCall = expireFirstCall }

        func handle(_ request: URLRequest, extraCallReply: (@Sendable (URLRequest) -> Reply)? = nil) -> Reply {
            if request.httpMethod == "DELETE" { return Reply(status: 200, body: Data()) }
            switch request.rpcMethod {
            case "server/discover"?:
                // What the TypeScript SDK's legacy transport says.
                return .json(#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: No valid session ID provided"},"id":null}"#, status: 400)
            case "initialize"?:
                let n = sessions.withLock { $0 += 1; return $0 }
                return Fake.result(request, ["protocolVersion": "2025-11-25", "capabilities": ["tools": ["listChanged": true]],
                                             "serverInfo": ["name": "legacy", "version": "1"]],
                                   headers: ["Mcp-Session-Id": "sess-\(n)"])
            case "notifications/initialized"?, "notifications/cancelled"?:
                return Fake.accepted
            case "tools/list"?:
                return Fake.result(request, ["tools": [Fake.tool("deploy")]])
            case "tools/call"?:
                if expireFirstCall, request.header("Mcp-Session-Id") == "sess-1" {
                    expired.withLock { $0 = true }
                    return Reply(status: 404, body: Data())
                }
                return extraCallReply?(request) ?? Fake.result(request, Fake.text("deployed via \(request.header("Mcp-Session-Id") ?? "-")"))
            default:
                if request.rpc?["method"] == nil { return Fake.accepted } // client's reply to a server request
                return Fake.error(request, code: -32601, message: "Method not found")
            }
        }
    }

    @Test func initializeWithSessionThen404ReinitializesAndReplays() async throws {
        let server = Server(expireFirstCall: true)
        let transport = ScriptedTransport { r, _ in server.handle(r) }
        let cache = MCPEraCache()
        let client = makeClient(transport, eraCache: cache)

        let tools = try await client.listTools()
        #expect(tools.map(\.name) == ["deploy"])
        #expect(await client.serverInfo?.era == .legacyStreamableHTTP)
        #expect(await client.serverInfo?.protocolVersion == "2025-11-25")

        let result = try await client.callTool("deploy")
        #expect(result.content == [.text("deployed via sess-2")])
        #expect(server.expired.withLock { $0 })

        let methods = transport.requests.map { $0.rpcMethod ?? $0.method }
        #expect(methods == ["server/discover", "initialize", "notifications/initialized", "tools/list",
                            "tools/call", "initialize", "notifications/initialized", "tools/call"])
        let initialize = try #require(transport.requests.first { $0.rpcMethod == "initialize" })
        #expect(initialize.json?["params"]?["protocolVersion"] == "2025-11-25")
        #expect(initialize.json?["params"]?["clientInfo"]?["name"] == "Praxis Chat")
        #expect(initialize.header("Mcp-Session-Id") == nil)
        let list = try #require(transport.requests.first { $0.rpcMethod == "tools/list" })
        #expect(list.header("Mcp-Session-Id") == "sess-1")
        #expect(list.header("MCP-Protocol-Version") == "2025-11-25")
        #expect(list.json?["params"]?["_meta"] == nil)
        #expect(await cache.era(for: acmeURL) == .legacyStreamableHTTP)

        await client.close()
        let last = try #require(transport.requests.last)
        #expect(last.method == "DELETE")
        #expect(last.header("Mcp-Session-Id") == "sess-2")
    }

    @Test func cachedEraSkipsTheModernProbe() async throws {
        let server = Server()
        let transport = ScriptedTransport { r, _ in server.handle(r) }
        let snapshot = MCPEraCache.Snapshot(eras: ["https://mcp.acme.test": .legacyStreamableHTTP])
        let decoded = try JSONDecoder().decode(MCPEraCache.Snapshot.self, from: JSONEncoder().encode(snapshot))
        let client = makeClient(transport, eraCache: MCPEraCache(snapshot: decoded))
        _ = try await client.listTools()
        #expect(transport.requests.first?.rpcMethod == "initialize")
    }

    @Test func serverRequestsOnTheResponseStream() async throws {
        let server = Server()
        let handler = StubElicitation(.accept(["approve": true]))
        let transport = ScriptedTransport { r, _ in
            server.handle(r) { request in
                Fake.sse([
                    ["jsonrpc": "2.0", "id": "p1", "method": "ping"],
                    ["jsonrpc": "2.0", "id": "e1", "method": "elicitation/create", "params": [
                        "mode": "form", "message": "Approve the deploy?",
                        "requestedSchema": ["type": "object", "properties": ["approve": ["type": "boolean"]]],
                    ]],
                    ["jsonrpc": "2.0", "id": "x1", "method": "sampling/createMessage", "params": [:]],
                    Fake.message(id: request.rpc!["id"]!, result: Fake.text("done")),
                ])
            }
        }
        let client = makeClient(transport, elicitation: handler)
        let result = try await client.callTool("deploy")
        #expect(result.content == [.text("done")])
        #expect(handler.seen.all.map(\.message) == ["Approve the deploy?"])

        let replies = transport.requests.compactMap(\.json).filter { $0["method"] == nil && $0["id"] != nil }
        let byID = Dictionary(uniqueKeysWithValues: replies.compactMap { r in r["id"]?.stringValue.map { ($0, r) } })
        #expect(byID["p1"]?["result"] == [:])
        #expect(byID["e1"]?["result"] == ["action": "accept", "content": ["approve": true]])
        #expect(byID["x1"]?["error"]?["code"] == -32601)
        // Replies carry the session.
        #expect(transport.requests.filter { $0.json?["id"] == "e1" }.first?.header("Mcp-Session-Id") == "sess-1")
        let initialize = try #require(transport.requests.first { $0.rpcMethod == "initialize" })
        #expect(initialize.json?["params"]?["capabilities"]?["elicitation"] != nil)
    }

    @Test func cancellationSendsNotificationsCancelled() async throws {
        let server = Server()
        let transport = LiveTransport { request in
            if request.rpcMethod == "tools/call" {
                // Never answers until the client goes away.
                let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
                continuation.yield(Data(": waiting\n\n".utf8))
                return HTTPStreamResponse(head: HTTPResponseHead(status: 200, headers: ["content-type": "text/event-stream"]), body: body)
            }
            return LiveTransport.respond(server.handle(request))
        }
        let client = makeClient(transport)
        _ = try await client.listTools()
        let task = Task { try await client.callTool("deploy") }
        #expect(await eventually { transport.requests.contains { $0.rpcMethod == "tools/call" } })
        task.cancel()
        let outcome = await task.result
        #expect(throws: (any Error).self) { try outcome.get() }

        #expect(await eventually { transport.requests.contains { $0.rpcMethod == "notifications/cancelled" } })
        let call = try #require(transport.requests.first { $0.rpcMethod == "tools/call" })
        let cancel = try #require(transport.requests.first { $0.rpcMethod == "notifications/cancelled" })
        #expect(cancel.json?["params"]?["requestId"] == call.json?["id"])
        #expect(cancel.headers["Mcp-Session-Id"] == "sess-1")
    }

    @Test func callTimeoutIsReported() async throws {
        let server = Server()
        let transport = LiveTransport { request in
            if request.rpcMethod == "tools/call" {
                let (body, _) = AsyncThrowingStream<Data, Error>.makeStream()
                return HTTPStreamResponse(head: HTTPResponseHead(status: 200, headers: ["content-type": "text/event-stream"]), body: body)
            }
            return LiveTransport.respond(server.handle(request))
        }
        let client = makeClient(transport)
        await #expect(throws: MCPError.timeout(.milliseconds(100))) {
            try await client.callTool("deploy", timeout: .milliseconds(100))
        }
    }
}

@Suite struct LegacySSETransportTests {
    @Test func fallsBackToHTTPPlusSSE() async throws {
        let (_, transport) = LegacySSEServer.make(tools: [Fake.tool("old_tool")])
        let url = URL(string: "https://mcp.acme.test/sse")!
        let cache = MCPEraCache()
        let client = makeClient(transport, config: acmeConfig(url: url), eraCache: cache)

        let tools = try await client.listTools()
        #expect(tools.map(\.name) == ["old_tool"])
        #expect(await client.serverInfo?.era == .legacySSE)
        let result = try await client.callTool("old_tool", arguments: ["q": "x"])
        #expect(result.content == [.text("sse:old_tool")])
        #expect(await cache.era(for: url) == .legacySSE)

        let seen = transport.requests
        // modern probe → legacy initialize probe → GET stream → messages
        #expect(seen[0].rpcMethod == "server/discover")
        #expect(seen[1].rpcMethod == "initialize")
        #expect(seen[2].method == "GET")
        let posted = seen.dropFirst(3).map { "\($0.url.path())?\($0.url.query() ?? "") \($0.rpcMethod ?? "")" }
        #expect(posted == ["/messages?sessionId=abc initialize", "/messages?sessionId=abc notifications/initialized",
                           "/messages?sessionId=abc tools/list", "/messages?sessionId=abc tools/call"])
        #expect(seen[3].json?["params"]?["protocolVersion"] == "2024-11-05")
        await client.close()
    }

    @Test func endpointOnAnotherOriginIsRejected() async throws {
        let transport = LiveTransport { request in
            if request.httpMethod == "GET" {
                let (body, c) = AsyncThrowingStream<Data, Error>.makeStream()
                c.yield(Data("event: endpoint\ndata: https://evil.test/messages\n\n".utf8))
                return HTTPStreamResponse(head: HTTPResponseHead(status: 200, headers: ["content-type": "text/event-stream"]), body: body)
            }
            return LiveTransport.respond(Reply(status: 405, body: Data()))
        }
        let client = makeClient(transport, config: acmeConfig(url: URL(string: "https://mcp.acme.test/sse")!))
        await #expect(throws: MCPError.self) { try await client.connect() }
        #expect(!transport.requests.contains { $0.url.host() == "evil.test" })
    }
}

@Suite struct ContentMappingTests {
    @Test func mapsAllContentKinds() {
        let png = Data([0x89, 0x50, 0x4E, 0x47])
        let result = MCPCallResult(json: [
            "content": [
                ["type": "text", "text": "hello"],
                ["type": "image", "data": .string(png.base64EncodedString()), "mimeType": "image/png"],
                ["type": "audio", "data": .string(Data(count: 10).base64EncodedString()), "mimeType": "audio/wav"],
                ["type": "resource_link", "uri": "file:///a.txt", "name": "a.txt", "description": "A file"],
                ["type": "resource", "resource": ["uri": "mem://note", "text": "note body"]],
                ["type": "hologram"],
            ],
            "structuredContent": ["temp": 21],
            "isError": true,
        ])
        let output = result.toolOutput()
        #expect(output.isError)
        #expect(output.content.count == 6)
        #expect(output.content[0] == .text("hello"))
        #expect(output.content[1] == .image(MediaData(mediaType: "image/png", data: png)))
        #expect(output.content[2].text?.contains("audio/wav, 10 bytes") == true)
        #expect(output.content[3].text?.contains("file:///a.txt") == true)
        #expect(output.content[4] == .text("[resource mem://note]\nnote body"))
        #expect(output.content[5].text?.contains("hologram") == true)
        // Text present → structuredContent not duplicated.
        #expect(!output.text.contains("temp"))
    }

    @Test func structuredContentBecomesJSONWithoutText() {
        let output = MCPCallResult(json: ["content": [], "structuredContent": ["temp": 21, "unit": "C"]]).toolOutput()
        #expect(output.content == [.text(#"{"temp":21,"unit":"C"}"#)])
        #expect(!output.isError)
    }

    @Test func emptyErrorGetsAMessage() {
        let output = MCPCallResult(json: ["isError": true]).toolOutput()
        #expect(output.isError)
        #expect(output.text.isEmpty == false)
    }
}
