import Foundation
import Synchronization
import AgentCore
import AgentTestSupport
@testable import AgentMCP

typealias Reply = ScriptedTransport.Reply

let acmeURL = URL(string: "https://mcp.acme.test/mcp")!

func acmeConfig(auth: MCPAuthKind = .none, trusted: Bool = false, headers: [MCPHeader] = [], hint: MCPEra? = nil,
                url: URL = acmeURL) -> MCPServerConfig {
    MCPServerConfig(id: "s1", name: "Acme", url: url, headers: headers, auth: auth, trusted: trusted, transportHint: hint)
}

func makeClient(_ transport: any HTTPTransport, config: MCPServerConfig = acmeConfig(), secrets: any SecretStore = InMemorySecretStore(),
                eraCache: MCPEraCache = MCPEraCache(), auth: MCPAuthEnvironment? = nil,
                elicitation: (any MCPElicitationHandler)? = nil,
                options: MCPClientOptions = MCPClientOptions(requestTimeout: .seconds(5), callTimeout: .seconds(5))) -> MCPClient {
    MCPClient(config: config, transport: transport, secrets: secrets, eraCache: eraCache, auth: auth,
              elicitation: elicitation, options: options)
}

extension URLRequest {
    var rpc: JSONValue? { httpBody.flatMap { try? JSONValue(parsing: $0) } }
    var rpcMethod: String? { rpc?["method"]?.stringValue }
    var params: JSONValue { rpc?["params"] ?? [:] }
    func header(_ name: String) -> String? { value(forHTTPHeaderField: name) }
    /// `application/x-www-form-urlencoded` body as a dictionary.
    var form: [String: String] {
        let text = String(decoding: httpBody ?? Data(), as: UTF8.self)
        var out: [String: String] = [:]
        for pair in text.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1).map { String($0).removingPercentEncoding ?? String($0) }
            if kv.count == 2 { out[kv[0]] = kv[1] }
        }
        return out
    }
}

extension ScriptedTransport.RecordedRequest {
    func header(_ name: String) -> String? { headers.first { $0.key.lowercased() == name.lowercased() }?.value }
    var rpcMethod: String? { json?["method"]?.stringValue }
}

enum Fake {
    static func message(id: JSONValue, result: JSONValue) -> JSONValue { ["jsonrpc": "2.0", "id": id, "result": result] }

    static func result(_ request: URLRequest, _ result: JSONValue, headers: [String: String] = [:]) -> Reply {
        .json(message(id: request.rpc?["id"] ?? .null, result: result).encodedString(), headers: headers)
    }

    static func error(_ request: URLRequest, code: Int, message: String, status: Int = 200) -> Reply {
        let body: JSONValue = ["jsonrpc": "2.0", "id": request.rpc?["id"] ?? .null,
                               "error": ["code": .number(Double(code)), "message": .string(message)]]
        return .json(body.encodedString(), status: status)
    }

    /// SSE body: one `message` event per JSON-RPC message.
    static func sse(_ messages: [JSONValue], chunkSize: Int = 5) -> Reply {
        .sse(messages.map { "event: message\ndata: \($0.encodedString())\n\n" }.joined(), chunkSize: chunkSize)
    }

    static let accepted = Reply(status: 202, headers: [:], body: Data())

    static let discover: JSONValue = [
        "resultType": "complete",
        "supportedVersions": ["2026-07-28"],
        "capabilities": ["tools": [:]],
        "_meta": ["io.modelcontextprotocol/serverInfo": ["name": "acme-mcp", "version": "2.0.0"]],
        "instructions": "Use search first.",
    ]

    static func tool(_ name: String, readOnly: Bool? = nil, destructive: Bool? = nil,
                     schema: JSONValue = ["type": "object", "properties": ["q": ["type": "string"]]]) -> JSONValue {
        var annotations: [String: JSONValue] = [:]
        if let readOnly { annotations["readOnlyHint"] = .bool(readOnly) }
        if let destructive { annotations["destructiveHint"] = .bool(destructive) }
        return ["name": .string(name), "description": .string("Does \(name)"), "inputSchema": schema, "annotations": .object(annotations)]
    }

    static func text(_ s: String) -> JSONValue { ["content": [["type": "text", "text": .string(s)]], "isError": false] }

    /// A modern (2026-07-28) server.
    static func modern(tools: [JSONValue] = [tool("search", readOnly: true)],
                       call: @escaping @Sendable (URLRequest) -> Reply = { r in result(r, text("ok")) })
        -> @Sendable (URLRequest, Int) throws -> Reply {
        { request, _ in
            switch request.rpcMethod {
            case "server/discover"?: return result(request, discover)
            case "tools/list"?: return result(request, ["tools": .array(tools)])
            case "tools/call"?: return call(request)
            default: return error(request, code: -32601, message: "Method not found")
            }
        }
    }
}

/// Collects values from `@Sendable` callbacks.
final class Box<T: Sendable>: Sendable {
    private let items = Mutex<[T]>([])
    func append(_ item: T) { items.withLock { $0.append(item) } }
    var all: [T] { items.withLock { $0 } }
}

final class StubElicitation: MCPElicitationHandler {
    let answer: MCPElicitationResult
    let seen = Box<MCPElicitation>()
    init(_ answer: MCPElicitationResult) { self.answer = answer }
    func elicit(_ request: MCPElicitation) async -> MCPElicitationResult {
        seen.append(request)
        return answer
    }
}

struct StubPresenter: OAuthPresenter {
    let body: @Sendable (URL, String) async throws -> URL
    func authorize(url: URL, callbackScheme: String) async throws -> URL { try await body(url, callbackScheme) }
}

/// Polls until `condition` holds (for effects of unstructured tasks).
func eventually(_ timeout: Duration = .seconds(3), _ condition: @Sendable () -> Bool) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

/// Transport whose handler returns live responses (long-lived event
/// streams, bodies that never finish) — what `ScriptedTransport` can't do.
final class LiveTransport: HTTPTransport {
    struct Seen: Sendable {
        var method: String
        var url: URL
        var headers: [String: String]
        var json: JSONValue?
        var rpcMethod: String? { json?["method"]?.stringValue }
    }

    private let handler: @Sendable (URLRequest) async throws -> HTTPStreamResponse
    private let seen = Box<Seen>()
    init(_ handler: @escaping @Sendable (URLRequest) async throws -> HTTPStreamResponse) { self.handler = handler }

    var requests: [Seen] { seen.all }

    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        seen.append(Seen(method: request.httpMethod ?? "GET", url: request.url!, headers: request.allHTTPHeaderFields ?? [:],
                         json: request.rpc))
        return try await handler(request)
    }

    static func respond(_ reply: Reply) -> HTTPStreamResponse {
        HTTPStreamResponse(head: HTTPResponseHead(status: reply.status, headers: reply.headers),
                           body: AsyncThrowingStream { c in
                               if !reply.body.isEmpty { c.yield(reply.body) }
                               c.finish()
                           })
    }
}

/// A 2024-11-05 HTTP+SSE server: GET /sse opens the event stream and
/// announces `/messages?sessionId=…`; POSTed requests are answered on the
/// stream. The Streamable HTTP probes (POST /sse) get 405.
final class LegacySSEServer: Sendable {
    private let stream = Mutex<AsyncThrowingStream<Data, Error>.Continuation?>(nil)
    let tools: [JSONValue]
    init(tools: [JSONValue]) { self.tools = tools }

    /// The server and a transport routed to it.
    static func make(tools: [JSONValue]) -> (LegacySSEServer, LiveTransport) {
        let server = LegacySSEServer(tools: tools)
        return (server, LiveTransport { try await server.handle($0) })
    }

    private func push(_ text: String) { _ = stream.withLock { $0?.yield(Data(text.utf8)) } }

    func handle(_ request: URLRequest) async throws -> HTTPStreamResponse {
        let path = request.url!.path()
        if request.httpMethod == "GET", path == "/sse" {
            let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
            stream.withLock { $0 = continuation }
            continuation.yield(Data(": keep-alive\n\nevent: endpoint\ndata: /messages?sessionId=abc\n\n".utf8))
            return HTTPStreamResponse(head: HTTPResponseHead(status: 200, headers: ["content-type": "text/event-stream"]), body: body)
        }
        guard request.httpMethod == "POST", path == "/messages" else {
            return LiveTransport.respond(Reply(status: 405, headers: [:], body: Data("Method Not Allowed".utf8)))
        }
        if let id = request.rpc?["id"], let method = request.rpcMethod {
            let result: JSONValue
            switch method {
            case "initialize":
                result = ["protocolVersion": "2024-11-05", "capabilities": ["tools": [:]], "serverInfo": ["name": "old", "version": "0.1"]]
            case "tools/list":
                result = ["tools": .array(tools)]
            case "tools/call":
                result = Fake.text("sse:\(request.params["name"]?.stringValue ?? "")")
            default:
                result = [:]
            }
            push("event: message\ndata: \(Fake.message(id: id, result: result).encodedString())\n\n")
        }
        return LiveTransport.respond(Fake.accepted)
    }
}
