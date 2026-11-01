import Foundation
import AgentCore

/// Protocol revisions this client speaks. Modern (2026-07-28) is stateless:
/// every request carries `_meta`, there is no `initialize` and no session.
/// Legacy revisions use the `initialize` handshake and `Mcp-Session-Id`.
public enum MCPProtocol {
    public static let modern = "2026-07-28"
    /// Streamable HTTP legacy revisions, newest first.
    public static let legacy = ["2025-11-25", "2025-06-18", "2025-03-26"]
    /// The deprecated HTTP+SSE transport's revision.
    public static let httpSSE = "2024-11-05"

    static let acceptedLegacy = Set(legacy + [httpSSE])
}

/// Which generation of MCP a server speaks. Detected once per origin and
/// cached — it is a property of the server, not of a request.
public enum MCPEra: String, Sendable, Codable, Hashable, CaseIterable {
    /// 2026-07-28+: stateless POSTs, `server/discover`, per-request `_meta`.
    case modern
    /// 2025-03-26 … 2025-11-25: `initialize` + optional `Mcp-Session-Id`.
    case legacyStreamableHTTP
    /// 2024-11-05: GET event stream + `endpoint` event + POSTed messages.
    case legacySSE
}

/// Name/version sent as `clientInfo`.
public struct MCPClientInfo: Sendable, Codable, Hashable {
    public var name: String
    public var version: String
    public init(name: String, version: String) {
        self.name = name
        self.version = version
    }

    var json: JSONValue { ["name": .string(name), "version": .string(version)] }
}

/// What the server reported about itself.
public struct MCPServerInfo: Sendable, Hashable {
    public var name: String?
    public var version: String?
    public var protocolVersion: String
    public var era: MCPEra
    public var instructions: String?
    public var capabilities: JSONValue
}

/// A progress notification for an in-flight call.
public struct MCPProgress: Sendable, Hashable {
    public var progress: Double
    public var total: Double?
    public var message: String?

    public init(progress: Double, total: Double? = nil, message: String? = nil) {
        self.progress = progress
        self.total = total
        self.message = message
    }

    /// Short human label, e.g. "Indexing… (3/10)".
    public var label: String {
        let count: String?
        if let total, total > 0 {
            count = total == total.rounded() && progress == progress.rounded()
                ? "\(Int(progress))/\(Int(total))"
                : "\(Int((progress / total * 100).rounded()))%"
        } else {
            count = nil
        }
        switch (message, count) {
        case let (m?, c?): return "\(m) (\(c))"
        case let (m?, nil): return m
        case let (nil, c?): return c
        case (nil, nil): return "Working…"
        }
    }
}

// MARK: - Errors

/// Errors surfaced by the MCP client. `errorDescription` is written for
/// the model and the user: it ends up in tool error results verbatim.
public enum MCPError: Error, Sendable, Hashable, LocalizedError {
    /// A JSON-RPC error from the server.
    case server(code: Int, message: String, data: JSONValue?)
    case http(status: Int, message: String)
    /// The server broke the protocol (bad JSON, stream ended early…).
    case protocolViolation(String)
    /// None of the supported protocol generations worked.
    case unsupportedServer(String)
    /// The server needs credentials the client can't obtain on its own.
    case authorizationRequired(MCPAuthRequirement)
    case auth(MCPAuthError)
    /// A header references a secret that isn't in the `SecretStore`.
    case missingSecret(String)
    case timeout(Duration)
    /// The server asked for input the client can't provide.
    case inputUnavailable(String)

    public var errorDescription: String? {
        switch self {
        case .server(let code, let message, _): return "MCP server error \(code): \(message)"
        case .http(let status, let message): return message.isEmpty ? "MCP server returned HTTP \(status)." : "MCP server returned HTTP \(status): \(message)"
        case .protocolViolation(let m): return "Unexpected MCP response: \(m)"
        case .unsupportedServer(let m): return m
        case .authorizationRequired(let r): return r.message
        case .auth(let e): return e.errorDescription
        case .missingSecret(let name): return "The credential for “\(name)” is missing. Re-enter it in the connector settings."
        case .timeout(let d): return "The MCP server didn't answer within \(d.components.seconds) s."
        case .inputUnavailable(let m): return m
        }
    }

    static let methodNotFound = -32601
    static let invalidParams = -32602
    static let headerMismatch = -32020
    static let missingClientCapability = -32021
    static let unsupportedProtocolVersion = -32022
    static let urlElicitationRequired = -32042
}

/// Internal: the connection is gone (legacy session expired, SSE stream
/// closed). The client re-establishes and replays the request once.
struct SessionLost: Error {}

// MARK: - JSON-RPC

enum RPC {
    static func request(id: Int, method: String, params: JSONValue) -> JSONValue {
        ["jsonrpc": "2.0", "id": .number(Double(id)), "method": .string(method), "params": params]
    }

    static func notification(_ method: String, params: JSONValue? = nil) -> JSONValue {
        var o: [String: JSONValue] = ["jsonrpc": "2.0", "method": .string(method)]
        if let params { o["params"] = params }
        return .object(o)
    }

    static func result(id: JSONValue, _ result: JSONValue) -> JSONValue {
        ["jsonrpc": "2.0", "id": id, "result": result]
    }

    static func error(id: JSONValue, code: Int, message: String) -> JSONValue {
        ["jsonrpc": "2.0", "id": id, "error": ["code": .number(Double(code)), "message": .string(message)]]
    }

    static func matches(_ value: JSONValue?, _ id: Int) -> Bool {
        guard let value else { return false }
        return value.intValue == id || value.stringValue == String(id)
    }
}

enum RPCMessage: Sendable {
    case response(id: JSONValue, result: JSONValue)
    case failure(id: JSONValue?, MCPError)
    case request(id: JSONValue, method: String, params: JSONValue)
    case notification(method: String, params: JSONValue)

    /// Parses one message or a (2025-03-26) batch.
    static func parse(_ value: JSONValue) -> [RPCMessage] {
        if case .array(let items) = value { return items.flatMap(parse) }
        guard case .object(let o) = value else { return [] }
        if let method = o["method"]?.stringValue {
            let params = o["params"] ?? .object([:])
            if let id = o["id"], !id.isNull { return [.request(id: id, method: method, params: params)] }
            return [.notification(method: method, params: params)]
        }
        if let err = o["error"] {
            let error = MCPError.server(code: err["code"]?.intValue ?? -32603,
                                        message: err["message"]?.stringValue ?? "Unknown error",
                                        data: err["data"])
            return [.failure(id: o["id"].flatMap { $0.isNull ? nil : $0 }, error)]
        }
        if let id = o["id"] { return [.response(id: id, result: o["result"] ?? .object([:]))] }
        return []
    }
}
