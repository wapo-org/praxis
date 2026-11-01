import Foundation
import AgentCore
import Security
import Synchronization

/// An installed remote MCP server. Persisted by the app; contains no
/// secrets — header values that are credentials are `SecretStore` keys.
public struct MCPServerConfig: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var name: String
    /// The MCP endpoint (Streamable HTTP) or the event-stream URL of a
    /// 2024-11-05 server.
    public var url: URL
    /// Sent on every request (API keys, PATs, routing headers).
    public var headers: [MCPHeader]
    public var auth: MCPAuthKind
    /// Trusted servers' tool annotations (`readOnlyHint` …) are believed;
    /// untrusted ones are treated as destructive by `ToolPolicy`.
    public var trusted: Bool
    public var enabled: Bool
    /// Skips probing when the config already said `"type": "sse"`.
    public var transportHint: MCPEra?
    /// Redirect URI registered with a user-supplied OAuth client
    /// (`.manualOAuth`), e.g. Google's reversed client ID
    /// `com.googleusercontent.apps.123-abc:/oauthredirect`. Its scheme is
    /// the callback scheme the sign-in sheet waits for. Nil: the app's
    /// `MCPAuthEnvironment.redirectURI`.
    public var oauthRedirectURI: String?
    /// Scopes to request at sign-in instead of the least-privilege
    /// defaults (`MCPScopeSelection`). Challenged scopes (step-up) are
    /// still added.
    public var oauthScopes: [String]?

    public init(id: String = UUID().uuidString, name: String, url: URL, headers: [MCPHeader] = [],
                auth: MCPAuthKind = .none, trusted: Bool = false, enabled: Bool = true, transportHint: MCPEra? = nil,
                oauthRedirectURI: String? = nil, oauthScopes: [String]? = nil) {
        self.id = id
        self.name = name
        self.url = url
        self.headers = headers
        self.auth = auth
        self.trusted = trusted
        self.enabled = enabled
        self.transportHint = transportHint
        self.oauthRedirectURI = oauthRedirectURI
        self.oauthScopes = oauthScopes
    }

    public var source: ToolSource { .mcp(serverID: id, serverName: name) }

    /// Insert into `ToolPolicy.trustedSources` when `trusted`.
    public var trustKey: String { source.key }
}

public struct MCPHeader: Codable, Sendable, Hashable {
    public enum Value: Codable, Sendable, Hashable {
        case plain(String)
        /// Key in the app's `SecretStore` (Keychain).
        case secret(key: String)
    }

    public var name: String
    public var value: Value
    public init(name: String, value: Value) {
        self.name = name
        self.value = value
    }
}

public enum MCPAuthKind: Codable, Sendable, Hashable {
    case none
    /// Credentials travel in `MCPServerConfig.headers` (bearer PAT, API key).
    case headers
    /// OAuth 2.1 with discovery + Dynamic Client Registration.
    case oauth
    /// OAuth with a client the user registered with the provider
    /// themselves (servers without DCR). The secret, if any, is a
    /// `SecretStore` key.
    case manualOAuth(clientID: String, clientSecretKey: String?)
}

/// What the UI should ask the user for, derived from the server's 401.
public enum MCPAuthRequirement: Sendable, Hashable {
    case none
    /// Paste a token / API key as a header.
    case tokenHeader
    /// "Sign in" — discovery and registration work without user input.
    case oauthAutomatic(issuer: String)
    /// The authorization server has no Dynamic Client Registration: the
    /// user must register an OAuth app and paste its client ID (+ secret).
    case oauthNeedsClientCredentials(issuer: String)
    /// OAuth is required but can't be done safely (e.g. no PKCE S256).
    case unsupported(String)

    public var message: String {
        switch self {
        case .none: return "No sign-in needed."
        case .tokenHeader: return "This MCP server needs an access token or API key. Add it in the connector settings."
        case .oauthAutomatic: return "This MCP server needs you to sign in. Open the connector settings and tap Sign In."
        case .oauthNeedsClientCredentials(let issuer):
            return "This MCP server's sign-in (\(Self.host(issuer))) needs an OAuth client ID you register yourself. Add it in the connector settings."
        case .unsupported(let reason): return "This MCP server's sign-in isn't supported: \(reason)"
        }
    }

    /// Whether signing in (any OAuth flavour) is what's needed.
    public var isOAuth: Bool {
        switch self {
        case .oauthAutomatic, .oauthNeedsClientCredentials: return true
        case .none, .tokenHeader, .unsupported: return false
        }
    }

    static func host(_ issuer: String) -> String { URL(string: issuer)?.host() ?? issuer }
}

// MARK: - Secrets

/// Where credentials live. The app uses `KeychainSecretStore`; tests use
/// `InMemorySecretStore`. Calls are synchronous and cheap enough to make
/// from an actor.
public protocol SecretStore: Sendable {
    func secret(for key: String) throws -> String?
    func setSecret(_ value: String, for key: String) throws
    func removeSecret(for key: String) throws
}

public final class InMemorySecretStore: SecretStore {
    private let values: Mutex<[String: String]>
    public init(_ values: [String: String] = [:]) { self.values = Mutex(values) }
    public func secret(for key: String) throws -> String? { values.withLock { $0[key] } }
    public func setSecret(_ value: String, for key: String) throws { values.withLock { $0[key] = value } }
    public func removeSecret(for key: String) throws { _ = values.withLock { $0.removeValue(forKey: key) } }
    public var allKeys: [String] { values.withLock { Array($0.keys).sorted() } }
}

/// Generic-password Keychain items, readable after first unlock and never
/// synced or migrated to another device (tokens are bound to this install).
public struct KeychainSecretStore: SecretStore {
    public var service: String
    public var accessGroup: String?

    public init(service: String = "PraxisAgent.MCP", accessGroup: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public struct KeychainError: Error, LocalizedError, Sendable {
        public var status: OSStatus
        public var errorDescription: String? { "Keychain error \(status)" }
    }

    private func query(_ key: String) -> [CFString: Any] {
        var q: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: key]
        if let accessGroup { q[kSecAttrAccessGroup] = accessGroup }
        return q
    }

    public func secret(for key: String) throws -> String? {
        var q = query(key)
        q[kSecReturnData] = true
        q[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError(status: status) }
        return String(decoding: data, as: UTF8.self)
    }

    public func setSecret(_ value: String, for key: String) throws {
        let data = Data(value.utf8)
        let update: [CFString: Any] = [kSecValueData: data, kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query(key) as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var add = query(key)
            add[kSecValueData] = data
            add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let added = SecItemAdd(add as CFDictionary, nil)
            guard added == errSecSuccess else { throw KeychainError(status: added) }
        } else if status != errSecSuccess {
            throw KeychainError(status: status)
        }
    }

    public func removeSecret(for key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}

// MARK: - Era cache

/// Detected protocol era per origin. Shared by all clients; the app
/// persists `snapshot()` so relaunches skip the probe. A stale entry is
/// harmless: the cached era is only tried first, the others still follow.
public actor MCPEraCache {
    public struct Snapshot: Codable, Sendable, Hashable {
        public var eras: [String: MCPEra]
        public init(eras: [String: MCPEra] = [:]) { self.eras = eras }
    }

    private var eras: [String: MCPEra]

    public init(snapshot: Snapshot = Snapshot()) { self.eras = snapshot.eras }

    public func snapshot() -> Snapshot { Snapshot(eras: eras) }

    public func era(for url: URL) -> MCPEra? { eras[Self.origin(of: url)] }

    func record(_ era: MCPEra, for url: URL) { eras[Self.origin(of: url)] = era }

    /// Probe order: cached era (or the config's hint) first, then
    /// modern → legacy Streamable HTTP → HTTP+SSE.
    func order(for url: URL, hint: MCPEra?) -> [MCPEra] {
        let first = eras[Self.origin(of: url)] ?? hint
        let all: [MCPEra] = [.modern, .legacyStreamableHTTP, .legacySSE]
        guard let first else { return all }
        return [first] + all.filter { $0 != first }
    }

    static func origin(of url: URL) -> String {
        let scheme = url.scheme?.lowercased() ?? "https"
        let host = url.host()?.lowercased() ?? ""
        let port = url.port.map { ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }
}
