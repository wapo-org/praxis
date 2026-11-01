import Foundation
import AgentCore

/// Callbacks for messages that arrive on a response stream before the
/// final response: request-scoped notifications (progress), and — legacy
/// only — server→client requests (elicitation, ping).
struct StreamHandlers: Sendable {
    var notification: @Sendable (_ method: String, _ params: JSONValue) async -> Void = { _, _ in }
    var request: @Sendable (_ id: JSONValue, _ method: String, _ params: JSONValue) async -> Void = { _, _, _ in }

    static let ignoring = StreamHandlers()
}

/// What a non-2xx reply said, for era detection and error reporting.
struct FailedReply: Sendable {
    var status: Int
    /// The JSON-RPC error in the body, if the body was one.
    var rpc: MCPError?
    var snippet: String

    var error: MCPError { rpc ?? .http(status: status, message: snippet) }

    /// Codes only a modern (2026-07-28+) server sends. Anything else in a
    /// 4xx means "not modern" and the client falls back.
    var isModernRejection: Bool {
        guard case .server(let code, _, _)? = rpc else { return false }
        return [MCPError.headerMismatch, MCPError.missingClientCapability, MCPError.unsupportedProtocolVersion].contains(code)
    }
}

enum MCPWire {
    static let maxBody = 32 << 20

    /// Reads the reply to request `id` — a JSON object or an SSE stream —
    /// handing interim messages to `handlers`. Throws `MCPError.server` for
    /// JSON-RPC errors.
    static func readReply(_ response: HTTPStreamResponse, id: Int, handlers: StreamHandlers) async throws -> JSONValue {
        let contentType = response.head.header("content-type")?.lowercased() ?? ""
        if contentType.contains("text/event-stream") {
            var parser = SSEParser()
            for try await chunk in response.body {
                for event in parser.feed(chunk) {
                    if let result = try await handle(event, id: id, handlers: handlers) { return result }
                }
            }
            for event in parser.finish() {
                if let result = try await handle(event, id: id, handlers: handlers) { return result }
            }
            try Task.checkCancellation()
            throw MCPError.protocolViolation("the server closed the stream before answering")
        }

        let data = try await response.collect(limit: maxBody)
        try Task.checkCancellation()
        guard let value = try? JSONValue(parsing: data) else {
            throw MCPError.protocolViolation("the reply wasn't JSON (\(snippet(data)))")
        }
        for message in RPCMessage.parse(value) {
            if let result = try await dispatch(message, id: id, handlers: handlers) { return result }
        }
        throw MCPError.protocolViolation("the reply had no response for request \(id)")
    }

    private static func handle(_ event: SSEEvent, id: Int, handlers: StreamHandlers) async throws -> JSONValue? {
        guard event.event == nil || event.event == "message" else { return nil }
        let text = event.data.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let value = try? JSONValue(parsing: text) else { return nil } // priming / keep-alive
        for message in RPCMessage.parse(value) {
            if let result = try await dispatch(message, id: id, handlers: handlers) { return result }
        }
        return nil
    }

    private static func dispatch(_ message: RPCMessage, id: Int, handlers: StreamHandlers) async throws -> JSONValue? {
        switch message {
        case .response(let rid, let result):
            return RPC.matches(rid, id) ? result : nil
        case .failure(let rid, let error):
            // `id: null` errors (e.g. "server not initialized") answer the
            // request this POST carried.
            if rid == nil || RPC.matches(rid, id) { throw error }
            return nil
        case .notification(let method, let params):
            await handlers.notification(method, params)
            return nil
        case .request(let rid, let method, let params):
            await handlers.request(rid, method, params)
            return nil
        }
    }

    static func failure(_ response: HTTPStreamResponse) async -> FailedReply {
        let data = (try? await response.collect(limit: 64 << 10)) ?? Data()
        var rpc: MCPError?
        if let value = try? JSONValue(parsing: data) {
            for case .failure(_, let error) in RPCMessage.parse(value) { rpc = error; break }
        }
        return FailedReply(status: response.head.status, rpc: rpc, snippet: snippet(data))
    }

    static func snippet(_ data: Data) -> String {
        String(decoding: data.prefix(300), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Header values (2026-07-28 "Value Encoding")

    /// Plain if it is visible ASCII without edge whitespace, else the
    /// `=?base64?…?=` sentinel form (also used for values that look like
    /// the sentinel, to keep decoding unambiguous).
    static func headerValue(_ raw: String) -> String {
        let plain = raw.unicodeScalars.allSatisfy { (s: Unicode.Scalar) -> Bool in s.value == 0x09 || (0x20...0x7E).contains(s.value) }
        let first: Character? = raw.first
        let last: Character? = raw.last
        let edgeSpace = first == " " || first == "\t" || last == " " || last == "\t"
        let looksEncoded = raw.hasPrefix("=?base64?") && raw.hasSuffix("?=")
        if plain && !edgeSpace && !looksEncoded { return raw }
        return "=?base64?" + Data(raw.utf8).base64EncodedString() + "?="
    }

    // MARK: x-mcp-header

    struct HeaderBinding: Sendable, Hashable {
        var path: [String]
        var header: String
    }

    /// Collects `x-mcp-header` annotations, enforcing the spec's
    /// constraints. Returns a reason string when the tool must be dropped.
    static func headerBindings(in schema: JSONValue) -> Result<[HeaderBinding], HeaderSchemaError> {
        var bindings: [HeaderBinding] = []
        var problem: String?
        func walk(_ node: JSONValue, path: [String]?) {
            guard problem == nil else { return }
            switch node {
            case .object(let o):
                if let annotation = o["x-mcp-header"] {
                    guard let path, !path.isEmpty else { problem = "x-mcp-header is only allowed on properties reachable from the root"; return }
                    guard let name = annotation.stringValue, isToken(name) else { problem = "x-mcp-header must be a non-empty HTTP token"; return }
                    guard let type = o["type"]?.stringValue, ["string", "integer", "boolean"].contains(type) else {
                        problem = "x-mcp-header must annotate a string, integer or boolean"; return
                    }
                    guard !bindings.contains(where: { $0.header.lowercased() == name.lowercased() }) else {
                        problem = "duplicate x-mcp-header \(name)"; return
                    }
                    bindings.append(HeaderBinding(path: path, header: name))
                }
                for (key, value) in o.sorted(by: { $0.key < $1.key }) {
                    switch key {
                    case "x-mcp-header", "const", "default", "enum", "examples":
                        continue // annotation itself / literal data, not schemas
                    case "properties":
                        if case .object(let props) = value {
                            for (name, sub) in props.sorted(by: { $0.key < $1.key }) { walk(sub, path: path.map { $0 + [name] }) }
                        }
                    default:
                        walk(value, path: nil)
                    }
                }
            case .array(let items):
                for item in items { walk(item, path: nil) }
            default:
                break
            }
        }
        walk(schema, path: [])
        if let problem { return .failure(HeaderSchemaError(reason: problem)) }
        return .success(bindings)
    }

    struct HeaderSchemaError: Error, Sendable { var reason: String }

    /// `Mcp-Param-*` headers for a `tools/call` with these arguments.
    static func paramHeaders(schema: JSONValue?, arguments: JSONValue) -> [String: String] {
        guard let schema, case .success(let bindings) = headerBindings(in: schema) else { return [:] }
        var headers: [String: String] = [:]
        for binding in bindings {
            var value: JSONValue? = arguments
            for key in binding.path { value = value?[key] }
            let text: String?
            switch value {
            case .string(let s)?: text = s
            case .bool(let b)?: text = b ? "true" : "false"
            case .number(let n)? where n.rounded() == n && abs(n) < 9_007_199_254_740_992: text = String(Int64(n))
            default: text = nil // absent / null / not primitive → omit
            }
            if let text { headers["Mcp-Param-\(binding.header)"] = headerValue(text) }
        }
        return headers
    }

    private static func isToken(_ s: String) -> Bool {
        guard !s.isEmpty else { return false }
        let extra = Set("!#$%&'*+-.^_`|~".unicodeScalars)
        return s.unicodeScalars.allSatisfy { c in
            (48...57).contains(c.value) || (65...90).contains(c.value) || (97...122).contains(c.value) || extra.contains(c)
        }
    }
}
