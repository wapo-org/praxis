import Foundation
import AgentCore
import CryptoKit
import Security

/// Opens the authorization page. The app implements it with
/// `ASWebAuthenticationSession` (ephemeral session recommended).
public protocol OAuthPresenter: Sendable {
    /// Shows `url` and returns the redirect URL the authorization server
    /// sent back to `callbackScheme`. Throw when the user cancels; stop
    /// promptly when the task is cancelled (the loopback flow ends the
    /// sheet that way). `callbackScheme == "http"` means the redirect goes
    /// to an in-app loopback listener instead — just keep the sheet open
    /// until cancelled.
    func authorize(url: URL, callbackScheme: String) async throws -> URL
}

/// One-shot `http://127.0.0.1:<port>/callback` receiver used when an
/// authorization server's registration rejects the custom-scheme
/// redirect. `LoopbackRedirect` is the NWListener implementation.
public protocol OAuthLoopbackServer: Sendable {
    /// Starts listening; returns the redirect URI to register.
    func start(preferredPort: UInt16?) async throws -> URL
    /// The first request to the callback path.
    func waitForCallback() async throws -> URL
    func stop() async
}

/// App-level OAuth settings shared by all MCP clients.
public struct MCPAuthEnvironment: Sendable {
    /// Nil in contexts that can't show UI: a 401 then surfaces as
    /// `MCPError.authorizationRequired`.
    public var presenter: (any OAuthPresenter)?
    /// Private-use scheme redirect registered via DCR (RFC 8252 §7.1).
    public var redirectURI: URL
    public var clientName: String
    /// Fallback when DCR rejects `redirectURI`. Nil disables it.
    public var loopback: (@Sendable () -> any OAuthLoopbackServer)?
    public var now: @Sendable () -> Date

    public init(presenter: (any OAuthPresenter)?,
                redirectURI: URL = URL(string: "praxischat://oauth/callback")!,
                clientName: String = "Praxis Chat",
                loopback: (@Sendable () -> any OAuthLoopbackServer)? = { LoopbackRedirect() },
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.presenter = presenter
        self.redirectURI = redirectURI
        self.clientName = clientName
        self.loopback = loopback
        self.now = now
    }
}

public enum MCPAuthError: Error, Sendable, Hashable, LocalizedError {
    case metadataNotFound(String)
    case issuerMismatch(expected: String, received: String)
    case missingIssuer
    case pkceUnsupported(issuer: String)
    case resourceMismatch(String)
    case registrationFailed(String)
    case stateMismatch
    case authorizationDenied(String)
    case missingCode
    case tokenRequestFailed(String)

    public var errorDescription: String? {
        switch self {
        case .metadataNotFound(let m): return "Couldn't find the server's sign-in configuration (\(m))."
        case .issuerMismatch(let e, let r): return "Sign-in was rejected: the response came from \(r), expected \(e)."
        case .missingIssuer: return "Sign-in was rejected: the authorization server didn't identify itself."
        case .pkceUnsupported(let issuer): return "\(issuer) doesn't support PKCE (S256), so signing in isn't safe."
        case .resourceMismatch(let m): return "The server's sign-in metadata is for a different server (\(m))."
        case .registrationFailed(let m): return "Couldn't register Praxis with the sign-in server: \(m)"
        case .stateMismatch: return "Sign-in was rejected: the response didn't match the request."
        case .authorizationDenied(let m): return "Sign-in failed: \(m)"
        case .missingCode: return "Sign-in failed: no authorization code was returned."
        case .tokenRequestFailed(let m): return "Sign-in failed while getting a token: \(m)"
        }
    }
}

// MARK: - WWW-Authenticate

struct AuthChallenge: Sendable, Hashable {
    var scheme: String
    /// Parameter names lowercased.
    var params: [String: String]

    var scopes: [String]? {
        params["scope"].map { $0.split(separator: " ").map(String.init) }.flatMap { $0.isEmpty ? nil : $0 }
    }
    var isInsufficientScope: Bool { params["error"] == "insufficient_scope" }
}

enum WWWAuthenticate {
    /// RFC 9110 challenges: `Bearer realm="x", scope="a b", resource_metadata="…"`,
    /// possibly several comma-joined challenges.
    static func parse(_ header: String) -> [AuthChallenge] {
        let chars = Array(header.unicodeScalars)
        let delimiters = Set(" \t,=\"".unicodeScalars)
        var i = 0
        var out: [AuthChallenge] = []

        func skipSpace() { while i < chars.count, chars[i] == " " || chars[i] == "\t" { i += 1 } }
        func token() -> String {
            var s = String.UnicodeScalarView()
            while i < chars.count, !delimiters.contains(chars[i]) { s.append(chars[i]); i += 1 }
            return String(s)
        }
        func value() -> String {
            var s = String.UnicodeScalarView()
            if i < chars.count, chars[i] == "\"" {
                i += 1
                while i < chars.count, chars[i] != "\"" {
                    if chars[i] == "\\", i + 1 < chars.count { i += 1 }
                    s.append(chars[i]); i += 1
                }
                i += 1
            } else {
                while i < chars.count, chars[i] != ",", chars[i] != " ", chars[i] != "\t" { s.append(chars[i]); i += 1 }
            }
            return String(s)
        }

        while i < chars.count {
            skipSpace()
            while i < chars.count, chars[i] == "," { i += 1; skipSpace() }
            guard i < chars.count else { break }
            let name = token()
            guard !name.isEmpty else { i += 1; continue }
            skipSpace()
            if i < chars.count, chars[i] == "=" {
                i += 1
                skipSpace()
                let v = value()
                if !out.isEmpty { out[out.count - 1].params[name.lowercased()] = v }
            } else {
                out.append(AuthChallenge(scheme: name, params: [:]))
            }
        }
        return out
    }

    static func bearer(in head: HTTPResponseHead) -> AuthChallenge? {
        guard let header = head.header("www-authenticate") else { return nil }
        return parse(header).first { $0.scheme.lowercased() == "bearer" }
    }
}

// MARK: - Discovery

struct ProtectedResourceMetadata: Sendable, Hashable {
    var resource: String?
    var authorizationServers: [String]
    var scopesSupported: [String]?
}

struct AuthorizationServerMetadata: Sendable, Hashable, Codable {
    var issuer: String
    var authorizationEndpoint: URL
    var tokenEndpoint: URL
    var registrationEndpoint: URL?
    var codeChallengeMethods: [String]
    var scopesSupported: [String]?
    var issParameterSupported: Bool
    var tokenEndpointAuthMethods: [String]?
}

struct OAuthDiscovery: Sendable {
    let transport: any HTTPTransport
    let serverURL: URL

    struct Result: Sendable {
        var protectedResource: ProtectedResourceMetadata?
        var authServer: AuthorizationServerMetadata
        /// RFC 8707 `resource` for authorize + token requests.
        var resource: String
    }

    func discover(challenge: AuthChallenge?) async throws -> Result {
        if let prm = try await protectedResource(challenge: challenge) {
            guard let issuer = prm.authorizationServers.first else {
                throw MCPError.auth(.metadataNotFound("no authorization_servers"))
            }
            return Result(protectedResource: prm, authServer: try await authorizationServer(issuer: issuer),
                          resource: try resource(for: prm))
        }
        // 2025-03-26 servers predate RFC 9728: their origin is the AS.
        let origin = MCPEraCache.origin(of: serverURL)
        return Result(protectedResource: nil, authServer: try await authorizationServer(issuer: origin),
                      resource: Self.canonical(serverURL))
    }

    /// What a 401 from a server without OAuth configured means for the UI.
    func requirement(challenge: AuthChallenge?) async -> MCPAuthRequirement {
        guard let found = try? await discover(challenge: challenge) else { return .tokenHeader }
        let meta = found.authServer
        guard meta.codeChallengeMethods.contains("S256") else { return .unsupported("the sign-in server doesn't support PKCE") }
        return meta.registrationEndpoint != nil ? .oauthAutomatic(issuer: meta.issuer) : .oauthNeedsClientCredentials(issuer: meta.issuer)
    }

    /// Sign-in the server advertises through RFC 9728 metadata, whether
    /// or not it has demanded credentials yet (some servers list tools
    /// anonymously and only answer 401 to `tools/call`). Nil when the
    /// server publishes no protected-resource metadata, or metadata for a
    /// different resource. Unlike `discover`, never falls back to treating
    /// the server's origin as the authorization server: that guess is only
    /// sound after a 401.
    func offer() async -> MCPSignInOffer? {
        guard let prm = try? await protectedResource(challenge: nil), let issuer = prm.authorizationServers.first,
              (try? resource(for: prm)) != nil else { return nil }
        let scopes = prm.scopesSupported ?? []
        guard let meta = try? await authorizationServer(issuer: issuer) else {
            return MCPSignInOffer(requirement: .unsupported("its sign-in server (\(MCPAuthRequirement.host(issuer))) publishes no usable metadata"),
                                  issuer: issuer, scopes: scopes)
        }
        let requirement: MCPAuthRequirement = !meta.codeChallengeMethods.contains("S256")
            ? .unsupported("the sign-in server doesn't support PKCE")
            : meta.registrationEndpoint != nil ? .oauthAutomatic(issuer: meta.issuer) : .oauthNeedsClientCredentials(issuer: meta.issuer)
        return MCPSignInOffer(requirement: requirement, issuer: meta.issuer, scopes: scopes,
                              recommendedScopes: MCPScopeSelection.defaults(supported: scopes, issuer: meta.issuer))
    }

    /// The challenge points at metadata for something narrower than the
    /// server (e.g. one tool: Gmail's `/.well-known/oauth-protected-resource/search_threads`),
    /// whose `scopes_supported` are then that request's alternatives.
    func isToolSpecific(_ challenge: AuthChallenge?) -> Bool {
        guard let raw = challenge?.params["resource_metadata"],
              let url = URL(string: raw, relativeTo: serverURL)?.absoluteURL else { return false }
        let standard = Set(Self.protectedResourceCandidates(for: serverURL).map { Self.trimSlash($0.absoluteString) })
        return !standard.contains(Self.trimSlash(url.absoluteString))
    }

    /// Discovered OAuth URLs must meet the same bar as installed server
    /// URLs: https, or http only for loopback. Failing closed here keeps
    /// DCR/token secrets off the cleartext wire and discovery fetches out
    /// of the local network (a malicious server names these URLs).
    static func allowsOAuthURL(_ url: URL) -> Bool {
        (try? MCPInstaller.validate(url)) != nil
    }

    func protectedResource(challenge: AuthChallenge?) async throws -> ProtectedResourceMetadata? {
        var candidates: [URL] = []
        if let raw = challenge?.params["resource_metadata"], let url = URL(string: raw, relativeTo: serverURL)?.absoluteURL,
           Self.allowsOAuthURL(url) {
            candidates.append(url)
        }
        candidates += Self.protectedResourceCandidates(for: serverURL)
        for url in candidates {
            guard let json = try await fetchJSON(url),
                  let servers = json["authorization_servers"]?.arrayValue?.compactMap(\.stringValue), !servers.isEmpty
            else { continue }
            return ProtectedResourceMetadata(resource: json["resource"]?.stringValue, authorizationServers: servers,
                                             scopesSupported: json["scopes_supported"]?.arrayValue?.compactMap(\.stringValue))
        }
        return nil
    }

    func authorizationServer(issuer: String) async throws -> AuthorizationServerMetadata {
        for url in Self.authorizationServerCandidates(issuer: issuer) {
            guard Self.allowsOAuthURL(url), let json = try await fetchJSON(url) else { continue }
            guard let docIssuer = json["issuer"]?.stringValue else { continue }
            // RFC 8414 §3.3: the document must name the issuer we asked for.
            guard Self.trimSlash(docIssuer) == Self.trimSlash(issuer) else {
                throw MCPError.auth(.issuerMismatch(expected: issuer, received: docIssuer))
            }
            guard let authorize = json["authorization_endpoint"]?.stringValue.flatMap(URL.init(string:)),
                  let token = json["token_endpoint"]?.stringValue.flatMap(URL.init(string:)),
                  Self.allowsOAuthURL(authorize), Self.allowsOAuthURL(token) else { continue }
            let registration = json["registration_endpoint"]?.stringValue.flatMap(URL.init(string:))
            if let registration, !Self.allowsOAuthURL(registration) { continue }
            return AuthorizationServerMetadata(
                issuer: docIssuer, authorizationEndpoint: authorize, tokenEndpoint: token,
                registrationEndpoint: registration,
                codeChallengeMethods: json["code_challenge_methods_supported"]?.arrayValue?.compactMap(\.stringValue) ?? [],
                scopesSupported: json["scopes_supported"]?.arrayValue?.compactMap(\.stringValue),
                issParameterSupported: json["authorization_response_iss_parameter_supported"]?.boolValue ?? false,
                tokenEndpointAuthMethods: json["token_endpoint_auth_methods_supported"]?.arrayValue?.compactMap(\.stringValue))
        }
        throw MCPError.auth(.metadataNotFound(issuer))
    }

    /// The PRM `resource` must identify this server (same origin, path
    /// prefix); otherwise a token minted for it could leak elsewhere.
    func resource(for prm: ProtectedResourceMetadata) throws -> String {
        let canonical = Self.canonical(serverURL)
        guard let declared = prm.resource else { return canonical }
        guard let url = URL(string: declared), MCPEraCache.origin(of: url) == MCPEraCache.origin(of: serverURL) else {
            throw MCPError.auth(.resourceMismatch(declared))
        }
        let declaredPath = Self.trimSlash(url.path())
        let serverPath = Self.trimSlash(serverURL.path())
        guard declaredPath.isEmpty || serverPath == declaredPath || serverPath.hasPrefix(declaredPath + "/") else {
            throw MCPError.auth(.resourceMismatch(declared))
        }
        return Self.trimSlash(declared)
    }

    private func fetchJSON(_ url: URL) async throws -> JSONValue? {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, head) = try await transport.data(request, limit: 1 << 20)
        guard head.isSuccess, let json = try? JSONValue(parsing: data), json.objectValue != nil else { return nil }
        // A redirect off the validated URL (downgrade, another host) voids the doc.
        if let final = head.url, !Self.allowsOAuthURL(final) { return nil }
        return json
    }

    // MARK: URL construction

    /// RFC 9728 §3.1: path-inserted well-known first, then the root.
    static func protectedResourceCandidates(for url: URL) -> [URL] {
        let origin = MCPEraCache.origin(of: url)
        let path = trimSlash(url.path(percentEncoded: true))
        var out: [String] = []
        if !path.isEmpty { out.append(origin + "/.well-known/oauth-protected-resource" + path) }
        out.append(origin + "/.well-known/oauth-protected-resource")
        return out.compactMap(URL.init(string:))
    }

    /// RFC 8414 path insertion, OIDC path insertion, OIDC path appending.
    static func authorizationServerCandidates(issuer: String) -> [URL] {
        guard let url = URL(string: issuer) else { return [] }
        let origin = MCPEraCache.origin(of: url)
        let path = trimSlash(url.path(percentEncoded: true))
        let list = path.isEmpty
            ? [origin + "/.well-known/oauth-authorization-server", origin + "/.well-known/openid-configuration"]
            : [origin + "/.well-known/oauth-authorization-server" + path,
               origin + "/.well-known/openid-configuration" + path,
               origin + path + "/.well-known/openid-configuration"]
        return list.compactMap(URL.init(string:))
    }

    /// Lowercase scheme/host, no fragment/query, no trailing slash.
    static func canonical(_ url: URL) -> String {
        trimSlash(MCPEraCache.origin(of: url) + url.path(percentEncoded: true))
    }

    static func trimSlash(_ s: String) -> String {
        var s = s
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
}

// MARK: - PKCE & encoding

enum PKCE {
    static func verifier() -> String { random(32) }
    static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
    static func random(_ count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        if SecRandomCopyBytes(kSecRandomDefault, count, &bytes) != errSecSuccess {
            bytes = (0..<count).map { _ in UInt8.random(in: .min ... .max) }
        }
        return base64URL(Data(bytes))
    }
    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

enum FormEncoding {
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
    static func encode(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? s }
    static func query(_ pairs: [(String, String)]) -> String {
        pairs.map { "\(encode($0.0))=\(encode($0.1))" }.joined(separator: "&")
    }
}

// MARK: - Session

/// Tokens as persisted in the `SecretStore`, keyed by (issuer, resource).
struct StoredTokens: Codable, Sendable, Hashable {
    var accessToken: String
    var refreshToken: String?
    var expiresAt: Date?
    var scope: String?
    var issuer: String
    var resource: String
    var tokenEndpoint: URL
    var clientID: String
}

/// A registered (DCR) or user-supplied OAuth client, keyed by issuer:
/// credentials are bound to the authorization server that issued them.
struct StoredClient: Codable, Sendable, Hashable {
    var issuer: String
    var clientID: String
    var clientSecret: String?
    var redirectURI: String
    /// `none`, `client_secret_basic` or `client_secret_post`.
    var authMethod: String
}

public enum OAuthKeys {
    static func tokens(issuer: String, resource: String) -> String { "mcp.oauth.tokens|\(issuer)|\(resource)" }
    static func client(issuer: String) -> String { "mcp.oauth.client|\(issuer)" }
    /// Which (issuer, resource) a server URL's tokens live under, so a
    /// relaunch can send the token before any discovery.
    static func binding(server: String) -> String { "mcp.oauth.binding|\(server)" }
    /// Which issuer a manual client secret was first used with. The app
    /// clears it when manual credentials are (re)saved, so a server that
    /// later names a different issuer can't silently receive the old secret.
    public static func manualIssuer(secretKey: String) -> String { "\(secretKey)|issuer" }
}

private struct TokenBinding: Codable { var issuer: String; var resource: String }

private struct TokenEndpointError: Error {
    var status: Int
    var code: String?
    var detail: String
    var mcp: MCPError { .auth(.tokenRequestFailed(detail)) }
}

private struct RegistrationRejected: Error { var detail: String }

/// OAuth state for one MCP server. An actor so refreshes are serialized:
/// with rotating refresh tokens, two concurrent refreshes would burn the
/// token and log the user out.
actor MCPOAuthSession {
    let serverURL: URL
    private let transport: any HTTPTransport
    private let secrets: any SecretStore
    private let environment: MCPAuthEnvironment
    private let manualClient: (id: String, secretKey: String?)?
    /// Redirect registered with the manual client (custom scheme), if not
    /// the environment's.
    private let manualRedirectURI: String?
    /// The user's scope choice; nil = what the server's metadata lists.
    private let configuredScopes: [String]?
    private let discovery: OAuthDiscovery

    private var tokens: StoredTokens?
    private var loaded = false
    private var refreshing: Task<StoredTokens, Error>?
    private var authorizing: Task<StoredTokens, Error>?
    /// Union of everything requested so far — step-up must not drop scopes.
    private var requestedScopes: [String] = []
    /// The last challenge a non-interactive request couldn't satisfy; an
    /// explicit `signIn()` uses its scopes and resource metadata.
    private var pendingChallenge: AuthChallenge?

    init(serverURL: URL, transport: any HTTPTransport, secrets: any SecretStore, environment: MCPAuthEnvironment,
         manualClient: (id: String, secretKey: String?)?, manualRedirectURI: String? = nil, scopes: [String]? = nil) {
        self.serverURL = serverURL
        self.transport = transport
        self.secrets = secrets
        self.environment = environment
        self.manualClient = manualClient
        self.manualRedirectURI = manualRedirectURI.flatMap { $0.isEmpty ? nil : $0 }
        self.configuredScopes = scopes.flatMap { $0.isEmpty ? nil : $0 }
        self.discovery = OAuthDiscovery(transport: transport, serverURL: serverURL)
    }

    /// Whether tokens are stored for this server.
    func isSignedIn() -> Bool {
        loadIfNeeded()
        return tokens != nil
    }

    /// Current access token, refreshed first when it is about to expire.
    func accessToken() async -> String? {
        loadIfNeeded()
        guard let current = tokens else { return nil }
        if let expiry = current.expiresAt, expiry <= environment.now().addingTimeInterval(30), current.refreshToken != nil {
            return (try? await refresh(current))?.accessToken
        }
        return current.accessToken
    }

    /// Reacts to a 401 / 403 `insufficient_scope`: refresh if that can
    /// help, else run the interactive flow (step-up adds the challenged
    /// scopes). Returns when a retry makes sense.
    ///
    /// `interactive: false` (tool calls in a run) never opens the sign-in
    /// sheet: it throws `authorizationRequired` and remembers the
    /// challenge for the user's explicit `signIn()`.
    func recover(from head: HTTPResponseHead, sentToken: String?, interactive: Bool = true) async throws {
        loadIfNeeded()
        let challenge = WWWAuthenticate.bearer(in: head)
        if challenge?.isInsufficientScope != true {
            if let current = tokens, current.accessToken != sentToken { return } // someone refreshed meanwhile
            if let current = tokens, current.refreshToken != nil, (try? await refresh(current)) != nil { return }
        }
        guard interactive else {
            pendingChallenge = challenge
            throw MCPError.authorizationRequired(await requirement(challenge: challenge))
        }
        _ = try await authorize(challenge: challenge)
    }

    /// Explicit sign-in ("Sign in" button): runs the interactive flow even
    /// though no request has been refused yet, using the last challenge
    /// a tool call couldn't satisfy (its scopes) if there is one.
    func signIn() async throws {
        loadIfNeeded()
        _ = try await authorize(challenge: pendingChallenge)
        pendingChallenge = nil
    }

    /// What the UI should offer when this session can't sign in by itself.
    private func requirement(challenge: AuthChallenge?) async -> MCPAuthRequirement {
        guard let found = try? await discovery.discover(challenge: challenge) else {
            return .unsupported("its sign-in configuration couldn't be read")
        }
        let meta = found.authServer
        guard meta.codeChallengeMethods.contains("S256") else { return .unsupported("the sign-in server doesn't support PKCE") }
        if manualClient != nil || meta.registrationEndpoint != nil || loadClient(issuer: meta.issuer) != nil {
            return .oauthAutomatic(issuer: meta.issuer)
        }
        return .oauthNeedsClientCredentials(issuer: meta.issuer)
    }

    func signOut() {
        loadIfNeeded()
        if let t = tokens { try? secrets.removeSecret(for: OAuthKeys.tokens(issuer: t.issuer, resource: t.resource)) }
        try? secrets.removeSecret(for: OAuthKeys.binding(server: OAuthDiscovery.canonical(serverURL)))
        tokens = nil
    }

    // MARK: Refresh

    func refresh(_ current: StoredTokens) async throws -> StoredTokens {
        if let refreshing { return try await refreshing.value }
        if let tokens, tokens.accessToken != current.accessToken { return tokens } // already rotated
        let task = Task { try await self.performRefresh(current) }
        refreshing = task
        defer { refreshing = nil }
        return try await task.value
    }

    private func performRefresh(_ current: StoredTokens) async throws -> StoredTokens {
        guard let refreshToken = current.refreshToken else { throw MCPError.auth(.tokenRequestFailed("no refresh token")) }
        let client = try clientForTokens(current)
        do {
            let response = try await tokenRequest(current.tokenEndpoint, client: client, form: [
                ("grant_type", "refresh_token"), ("refresh_token", refreshToken), ("resource", current.resource),
            ])
            var next = current
            next.accessToken = response.accessToken
            // Rotation: a new refresh token replaces the old one; keep the
            // old one only if the server didn't send a new one.
            next.refreshToken = response.refreshToken ?? current.refreshToken
            next.expiresAt = response.expiresIn.map { environment.now().addingTimeInterval($0) }
            next.scope = response.scope ?? current.scope
            save(next)
            return next
        } catch let error as TokenEndpointError {
            if (400..<500).contains(error.status) { clearTokens() } // invalid_grant → sign in again
            throw error.mcp
        }
    }

    // MARK: Authorization code flow

    private func authorize(challenge: AuthChallenge?) async throws -> StoredTokens {
        if let authorizing { return try await authorizing.value }
        let task = Task { try await self.runAuthorization(challenge: challenge) }
        authorizing = task
        defer { authorizing = nil }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }

    private func runAuthorization(challenge: AuthChallenge?) async throws -> StoredTokens {
        let found = try await discovery.discover(challenge: challenge)
        let meta = found.authServer
        guard meta.codeChallengeMethods.contains("S256") else { throw MCPError.auth(.pkceUnsupported(issuer: meta.issuer)) }
        guard let presenter = environment.presenter else {
            throw MCPError.authorizationRequired(manualClient != nil || meta.registrationEndpoint != nil
                ? .oauthAutomatic(issuer: meta.issuer) : .oauthNeedsClientCredentials(issuer: meta.issuer))
        }

        var scopes = requestedScopes
        // The user's choice, plus what a challenge asks for: its `scope`,
        // or — for metadata scoped to one tool — the narrowest of that
        // tool's alternatives. With neither, least-privilege defaults
        // (`MCPScopeSelection`).
        let supported = found.protectedResource?.scopesSupported ?? []
        var wanted = configuredScopes ?? []
        if let challenged = challenge?.scopes {
            wanted += challenged
        } else if discovery.isToolSpecific(challenge), !supported.isEmpty {
            let granted = Set(tokens?.scope?.split(separator: " ").map(String.init) ?? [])
            wanted += MCPScopeSelection.stepUp(alternatives: supported, requested: scopes + wanted, granted: granted,
                                               issuer: meta.issuer)
        } else if configuredScopes == nil {
            wanted += MCPScopeSelection.defaults(supported: supported, issuer: meta.issuer)
        }
        for s in wanted where !scopes.contains(s) { scopes.append(s) }
        if meta.scopesSupported?.contains("offline_access") == true, !scopes.contains("offline_access") {
            scopes.append("offline_access") // refresh tokens matter on a phone
        }
        requestedScopes = scopes
        let scope = scopes.isEmpty ? nil : scopes.joined(separator: " ")

        let (client, loopback) = try await obtainClient(meta, scope: scope)
        do {
            let verifier = PKCE.verifier()
            let state = PKCE.random(16)
            var query: [(String, String)] = [
                ("response_type", "code"), ("client_id", client.clientID), ("redirect_uri", client.redirectURI),
                ("code_challenge", PKCE.challenge(for: verifier)), ("code_challenge_method", "S256"),
                ("state", state), ("resource", found.resource),
            ]
            if let scope { query.append(("scope", scope)) }
            var components = URLComponents(url: meta.authorizationEndpoint, resolvingAgainstBaseURL: false)
            let existing = components?.percentEncodedQuery.map { $0 + "&" } ?? ""
            components?.percentEncodedQuery = existing + FormEncoding.query(query)
            guard let url = components?.url else { throw MCPError.auth(.metadataNotFound("bad authorization_endpoint")) }

            let callback = try await present(url, redirectURI: client.redirectURI, presenter: presenter, loopback: loopback)
            await loopback?.stop()
            let code = try Self.validateCallback(callback, state: state, issuer: meta.issuer,
                                                 issParameterSupported: meta.issParameterSupported)

            let response: TokenResponse
            do {
                response = try await tokenRequest(meta.tokenEndpoint, client: client, form: [
                    ("grant_type", "authorization_code"), ("code", code), ("redirect_uri", client.redirectURI),
                    ("code_verifier", verifier), ("resource", found.resource),
                ])
            } catch let error as TokenEndpointError {
                throw error.mcp
            }
            let stored = StoredTokens(accessToken: response.accessToken, refreshToken: response.refreshToken,
                                      expiresAt: response.expiresIn.map { environment.now().addingTimeInterval($0) },
                                      scope: response.scope ?? scope, issuer: meta.issuer, resource: found.resource,
                                      tokenEndpoint: meta.tokenEndpoint, clientID: client.clientID)
            save(stored)
            return stored
        } catch {
            await loopback?.stop()
            throw error
        }
    }

    /// RFC 9207 validation happens before the code goes anywhere, and on
    /// mismatch even an error response is not acted on.
    static func validateCallback(_ url: URL, state: String, issuer: String, issParameterSupported: Bool) throws -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard value("state") == state else { throw MCPError.auth(.stateMismatch) }
        if let iss = value("iss") {
            guard iss == issuer else { throw MCPError.auth(.issuerMismatch(expected: issuer, received: iss)) }
        } else if issParameterSupported {
            throw MCPError.auth(.missingIssuer)
        }
        if let error = value("error") { throw MCPError.auth(.authorizationDenied(value("error_description") ?? error)) }
        guard let code = value("code"), !code.isEmpty else { throw MCPError.auth(.missingCode) }
        return code
    }

    private func present(_ url: URL, redirectURI: String, presenter: any OAuthPresenter,
                         loopback: (any OAuthLoopbackServer)?) async throws -> URL {
        guard let loopback else {
            return try await presenter.authorize(url: url, callbackScheme: URL(string: redirectURI)?.scheme ?? "praxischat")
        }
        // Loopback: the browser's redirect lands on the in-app listener;
        // cancelling the presenter then closes the sheet.
        // NEEDS DEVICE SPIKE: ASWebAuthenticationSession + a loopback
        // NWListener on iOS (backgrounding, sheet dismissal) is unverified.
        return try await withThrowingTaskGroup(of: URL.self) { group in
            group.addTask { try await loopback.waitForCallback() }
            group.addTask { try await presenter.authorize(url: url, callbackScheme: "http") }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw CancellationError() }
            return first
        }
    }

    // MARK: Client registration

    private func obtainClient(_ meta: AuthorizationServerMetadata, scope: String?) async throws -> (StoredClient, (any OAuthLoopbackServer)?) {
        if let manual = manualClient {
            let secret = try manual.secretKey.flatMap { try secrets.secret(for: $0) }
            if let key = manual.secretKey, secret != nil {
                // The secret was entered for one provider; the server names
                // the issuer, so a changed issuer means asking again — never
                // silently sending the old secret somewhere new.
                let binding = OAuthKeys.manualIssuer(secretKey: key)
                if let bound = try secrets.secret(for: binding), bound != meta.issuer {
                    throw MCPError.authorizationRequired(.oauthNeedsClientCredentials(issuer: meta.issuer))
                }
                try? secrets.setSecret(meta.issuer, for: binding)
            }
            let methods = meta.tokenEndpointAuthMethods ?? ["client_secret_basic"]
            let method = secret == nil ? "none" : (methods.contains("client_secret_basic") ? "client_secret_basic" : "client_secret_post")
            return (StoredClient(issuer: meta.issuer, clientID: manual.id, clientSecret: secret,
                                 redirectURI: manualRedirectURI ?? environment.redirectURI.absoluteString, authMethod: method), nil)
        }
        let preferred = environment.redirectURI.absoluteString
        if let stored = loadClient(issuer: meta.issuer) {
            if stored.redirectURI == preferred { return (stored, nil) }
            if let factory = environment.loopback, let old = URL(string: stored.redirectURI), old.host() == "127.0.0.1" {
                let server = factory()
                if let uri = try? await server.start(preferredPort: old.port.map(UInt16.init)), uri.absoluteString == stored.redirectURI {
                    return (stored, server)
                }
                await server.stop()
            }
        }
        guard let endpoint = meta.registrationEndpoint else {
            throw MCPError.authorizationRequired(.oauthNeedsClientCredentials(issuer: meta.issuer))
        }
        do {
            let client = try await register(endpoint, issuer: meta.issuer, redirectURI: preferred, scope: scope)
            return (client, nil)
        } catch let rejected as RegistrationRejected {
            guard let factory = environment.loopback else { throw MCPError.auth(.registrationFailed(rejected.detail)) }
            // The AS refused the private-use scheme: retry with a loopback
            // redirect (RFC 8252 §7.3), served by a one-shot listener.
            let server = factory()
            do {
                let uri = try await server.start(preferredPort: nil)
                let client = try await register(endpoint, issuer: meta.issuer, redirectURI: uri.absoluteString, scope: scope)
                return (client, server)
            } catch let again as RegistrationRejected {
                await server.stop()
                throw MCPError.auth(.registrationFailed(again.detail))
            } catch {
                await server.stop()
                throw error
            }
        }
    }

    /// RFC 7591 registration as a public native client.
    private func register(_ endpoint: URL, issuer: String, redirectURI: String, scope: String?) async throws -> StoredClient {
        guard OAuthDiscovery.allowsOAuthURL(endpoint) else {
            throw MCPError.auth(.registrationFailed("refusing to register over \(endpoint.scheme ?? "?")"))
        }
        var body: [String: JSONValue] = [
            "client_name": .string(environment.clientName),
            "redirect_uris": [.string(redirectURI)],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "application_type": "native",
        ]
        if let scope { body["scope"] = .string(scope) }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = JSONValue.object(body).encodedData()
        let (data, head) = try await transport.data(request, limit: 1 << 20)
        let json = try? JSONValue(parsing: data)
        guard head.isSuccess, let clientID = json?["client_id"]?.stringValue else {
            let detail = [json?["error"]?.stringValue, json?["error_description"]?.stringValue].compactMap { $0 }.joined(separator: ": ")
            let message = detail.isEmpty ? "HTTP \(head.status)" : detail
            if (400..<500).contains(head.status) { throw RegistrationRejected(detail: message) }
            throw MCPError.auth(.registrationFailed(message))
        }
        let secret = json?["client_secret"]?.stringValue
        let method = json?["token_endpoint_auth_method"]?.stringValue ?? (secret == nil ? "none" : "client_secret_basic")
        let client = StoredClient(issuer: issuer, clientID: clientID, clientSecret: secret, redirectURI: redirectURI, authMethod: method)
        if let encoded = try? JSONEncoder().encode(client) {
            try? secrets.setSecret(String(decoding: encoded, as: UTF8.self), for: OAuthKeys.client(issuer: issuer))
        }
        return client
    }

    // MARK: Token endpoint

    private struct TokenResponse {
        var accessToken: String
        var refreshToken: String?
        var expiresIn: TimeInterval?
        var scope: String?
    }

    private func tokenRequest(_ endpoint: URL, client: StoredClient, form: [(String, String)]) async throws -> TokenResponse {
        guard OAuthDiscovery.allowsOAuthURL(endpoint) else {
            throw MCPError.auth(.tokenRequestFailed("refusing to send credentials over \(endpoint.scheme ?? "?")"))
        }
        var pairs = form
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        switch (client.authMethod, client.clientSecret) {
        case ("client_secret_basic", let secret?):
            let credentials = "\(FormEncoding.encode(client.clientID)):\(FormEncoding.encode(secret))"
            request.setValue("Basic " + Data(credentials.utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        case ("client_secret_post", let secret?):
            pairs += [("client_id", client.clientID), ("client_secret", secret)]
        default:
            pairs.append(("client_id", client.clientID))
        }
        request.httpBody = Data(FormEncoding.query(pairs).utf8)
        let (data, head) = try await transport.data(request, limit: 1 << 20)
        let json = try? JSONValue(parsing: data)
        guard head.isSuccess, let access = json?["access_token"]?.stringValue else {
            let code = json?["error"]?.stringValue
            let detail = [code, json?["error_description"]?.stringValue].compactMap { $0 }.joined(separator: ": ")
            throw TokenEndpointError(status: head.status, code: code, detail: detail.isEmpty ? "HTTP \(head.status)" : detail)
        }
        return TokenResponse(accessToken: access, refreshToken: json?["refresh_token"]?.stringValue,
                             expiresIn: json?["expires_in"]?.doubleValue, scope: json?["scope"]?.stringValue)
    }

    // MARK: Storage

    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true
        let decoder = JSONDecoder()
        guard let raw = try? secrets.secret(for: OAuthKeys.binding(server: OAuthDiscovery.canonical(serverURL))),
              let binding = try? decoder.decode(TokenBinding.self, from: Data(raw.utf8)),
              let stored = try? secrets.secret(for: OAuthKeys.tokens(issuer: binding.issuer, resource: binding.resource)),
              let decoded = try? decoder.decode(StoredTokens.self, from: Data(stored.utf8)) else { return }
        tokens = decoded
    }

    private func save(_ new: StoredTokens) {
        tokens = new
        let encoder = JSONEncoder()
        if let data = try? encoder.encode(new) {
            try? secrets.setSecret(String(decoding: data, as: UTF8.self), for: OAuthKeys.tokens(issuer: new.issuer, resource: new.resource))
        }
        if let data = try? encoder.encode(TokenBinding(issuer: new.issuer, resource: new.resource)) {
            try? secrets.setSecret(String(decoding: data, as: UTF8.self), for: OAuthKeys.binding(server: OAuthDiscovery.canonical(serverURL)))
        }
    }

    private func clearTokens() {
        if let t = tokens { try? secrets.removeSecret(for: OAuthKeys.tokens(issuer: t.issuer, resource: t.resource)) }
        tokens = nil
    }

    private func loadClient(issuer: String) -> StoredClient? {
        guard let raw = try? secrets.secret(for: OAuthKeys.client(issuer: issuer)) else { return nil }
        return try? JSONDecoder().decode(StoredClient.self, from: Data(raw.utf8))
    }

    private func clientForTokens(_ t: StoredTokens) throws -> StoredClient {
        if let manual = manualClient, manual.id == t.clientID {
            let secret = try manual.secretKey.flatMap { try secrets.secret(for: $0) }
            return StoredClient(issuer: t.issuer, clientID: manual.id, clientSecret: secret, redirectURI: "",
                                authMethod: secret == nil ? "none" : "client_secret_basic")
        }
        if let stored = loadClient(issuer: t.issuer), stored.clientID == t.clientID { return stored }
        return StoredClient(issuer: t.issuer, clientID: t.clientID, clientSecret: nil, redirectURI: "", authMethod: "none")
    }
}
