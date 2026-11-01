import Foundation
import Testing
import Synchronization
import AgentCore
import AgentTestSupport
@testable import AgentMCP

/// An OAuth-protected modern MCP server plus its authorization server.
final class OAuthWorld: Sendable {
    struct State: Sendable {
        var issued: [String] = ["at-1"]
        var refreshTokens: [String] = ["rt-1"]
        var registrations = 0
        var expiresIn: Double = 3600
        var rejectCustomScheme = false
    }

    let state = Mutex(State())
    let prmURL = "https://mcp.acme.test/.well-known/oauth-protected-resource/mcp"

    func handle(_ request: URLRequest) -> Reply {
        let url = request.url!
        switch (url.host() ?? "", url.path()) {
        case ("mcp.acme.test", "/mcp"):
            let auth = request.header("Authorization")
            let valid = state.withLock { s in s.issued.map { "Bearer \($0)" }.last == auth }
            guard valid else {
                return Reply(status: 401, headers: [
                    "WWW-Authenticate": #"Bearer error="invalid_token", resource_metadata="\#(prmURL)", scope="files:read""#,
                ], body: Data())
            }
            return (try? Fake.modern()(request, 0)) ?? Reply(status: 500, body: Data())
        case ("mcp.acme.test", "/.well-known/oauth-protected-resource/mcp"):
            return .json(#"{"resource":"https://mcp.acme.test/mcp","authorization_servers":["https://auth.acme.test"],"scopes_supported":["files:read","files:write"]}"#)
        case ("auth.acme.test", "/.well-known/oauth-authorization-server"):
            return .json("""
            {"issuer":"https://auth.acme.test","authorization_endpoint":"https://auth.acme.test/authorize",
             "token_endpoint":"https://auth.acme.test/token","registration_endpoint":"https://auth.acme.test/register",
             "code_challenge_methods_supported":["S256"],"response_types_supported":["code"],
             "authorization_response_iss_parameter_supported":true}
            """)
        case ("auth.acme.test", "/register"):
            let body = request.rpc
            let redirect = body?["redirect_uris"]?[0]?.stringValue ?? ""
            if state.withLock({ $0.rejectCustomScheme }), !redirect.hasPrefix("http://127.0.0.1") {
                return .json(#"{"error":"invalid_redirect_uri","error_description":"custom schemes not allowed"}"#, status: 400)
            }
            state.withLock { $0.registrations += 1 }
            return .json(#"{"client_id":"cid-1","redirect_uris":["\#(redirect)"],"token_endpoint_auth_method":"none"}"#, status: 201)
        case ("auth.acme.test", "/token"):
            let form = request.form
            return state.withLock { s -> Reply in
                switch form["grant_type"] {
                case "authorization_code"?:
                    guard form["code"] == "code-1", form["code_verifier"]?.isEmpty == false,
                          form["resource"] == "https://mcp.acme.test/mcp", form["client_id"] == "cid-1" else {
                        return .json(#"{"error":"invalid_grant"}"#, status: 400)
                    }
                case "refresh_token"?:
                    guard form["refresh_token"] == s.refreshTokens.last else { return .json(#"{"error":"invalid_grant"}"#, status: 400) }
                    s.issued.append("at-\(s.issued.count + 1)")
                    s.refreshTokens.append("rt-\(s.refreshTokens.count + 1)")
                default:
                    return .json(#"{"error":"unsupported_grant_type"}"#, status: 400)
                }
                return .json(#"{"access_token":"\#(s.issued.last!)","token_type":"Bearer","refresh_token":"\#(s.refreshTokens.last!)","expires_in":\#(Int(s.expiresIn))}"#)
            }
        default:
            return Reply(status: 404, body: Data())
        }
    }

    /// Approves whatever the client asks, echoing state and issuer.
    func presenter(log: Box<URL>, state override: String? = nil) -> StubPresenter {
        StubPresenter { url, scheme in
            log.append(url)
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let state = override ?? items.first { $0.name == "state" }?.value ?? ""
            let redirect = items.first { $0.name == "redirect_uri" }?.value ?? "praxischat://oauth/callback"
            return URL(string: "\(redirect)?code=code-1&state=\(state)&iss=https%3A%2F%2Fauth.acme.test")!
        }
    }
}

@Suite struct AuthTests {
    @Test func fullOAuthFlowThenBearerRetry() async throws {
        let world = OAuthWorld()
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let secrets = InMemorySecretStore()
        let opened = Box<URL>()
        let client = makeClient(transport, config: acmeConfig(auth: .oauth), secrets: secrets,
                                auth: MCPAuthEnvironment(presenter: world.presenter(log: opened), loopback: nil))

        let tools = try await client.listTools()
        #expect(tools.map(\.name) == ["search"])

        let paths = transport.requests.map { "\($0.method) \($0.url!.host() ?? "")\($0.url!.path())" }
        #expect(Array(paths.prefix(6)) == [
            "POST mcp.acme.test/mcp",
            "GET mcp.acme.test/.well-known/oauth-protected-resource/mcp",
            "GET auth.acme.test/.well-known/oauth-authorization-server",
            "POST auth.acme.test/register",
            "POST auth.acme.test/token",
            "POST mcp.acme.test/mcp",
        ])
        let registration = try #require(transport.requests[3].json)
        #expect(registration["application_type"] == "native")
        #expect(registration["redirect_uris"] == ["praxischat://oauth/callback"])
        #expect(registration["token_endpoint_auth_method"] == "none")

        let authorize = try #require(opened.all.first)
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: authorize, resolvingAgainstBaseURL: false)?.queryItems ?? [])
            .map { ($0.name, $0.value ?? "") })
        #expect(authorize.host() == "auth.acme.test")
        #expect(query["code_challenge_method"] == "S256")
        #expect(query["resource"] == "https://mcp.acme.test/mcp")
        #expect(query["scope"] == "files:read") // from the challenge, not scopes_supported
        #expect(query["client_id"] == "cid-1")
        #expect(query["state"]?.isEmpty == false)

        let token = transport.requests[4]
        let form = URLRequest(url: token.url!).with(body: token.body).form
        #expect(form["grant_type"] == "authorization_code")
        #expect(PKCE.challenge(for: form["code_verifier"] ?? "") == query["code_challenge"])

        let retried = transport.requests[5]
        #expect(retried.header("Authorization") == "Bearer at-1")
        #expect(transport.requests.dropFirst(5).allSatisfy { $0.header("Authorization") == "Bearer at-1" })

        // Tokens and the client registration persisted in the SecretStore.
        #expect(secrets.allKeys.contains(OAuthKeys.tokens(issuer: "https://auth.acme.test", resource: "https://mcp.acme.test/mcp")))
        #expect(secrets.allKeys.contains(OAuthKeys.client(issuer: "https://auth.acme.test")))

        // A new client (app relaunch) reuses the stored token without discovery.
        let relaunched = ScriptedTransport { r, _ in world.handle(r) }
        let again = makeClient(relaunched, config: acmeConfig(auth: .oauth), secrets: secrets,
                               auth: MCPAuthEnvironment(presenter: nil, loopback: nil))
        _ = try await again.listTools()
        #expect(relaunched.requests.allSatisfy { $0.url?.host() == "mcp.acme.test" && $0.header("Authorization") == "Bearer at-1" })
    }

    @Test func stateMismatchIsRejected() async throws {
        let world = OAuthWorld()
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let client = makeClient(transport, config: acmeConfig(auth: .oauth),
                                auth: MCPAuthEnvironment(presenter: world.presenter(log: Box(), state: "forged"), loopback: nil))
        await #expect(throws: MCPError.auth(.stateMismatch)) { try await client.connect() }
        #expect(!transport.requests.contains { $0.url?.path() == "/token" })
    }

    @Test func callbackValidation() throws {
        let ok = URL(string: "praxischat://oauth/callback?code=c&state=s&iss=https://as.test")!
        #expect(try MCPOAuthSession.validateCallback(ok, state: "s", issuer: "https://as.test", issParameterSupported: true) == "c")
        let wrongIss = URL(string: "praxischat://oauth/callback?code=c&state=s&iss=https://evil.test")!
        #expect(throws: MCPError.auth(.issuerMismatch(expected: "https://as.test", received: "https://evil.test"))) {
            try MCPOAuthSession.validateCallback(wrongIss, state: "s", issuer: "https://as.test", issParameterSupported: false)
        }
        let noIss = URL(string: "praxischat://oauth/callback?code=c&state=s")!
        #expect(throws: MCPError.auth(.missingIssuer)) {
            try MCPOAuthSession.validateCallback(noIss, state: "s", issuer: "https://as.test", issParameterSupported: true)
        }
        let denied = URL(string: "praxischat://oauth/callback?error=access_denied&state=s")!
        #expect(throws: MCPError.auth(.authorizationDenied("access_denied"))) {
            try MCPOAuthSession.validateCallback(denied, state: "s", issuer: "https://as.test", issParameterSupported: false)
        }
    }

    @Test func refreshRotatesAndIsSerialized() async throws {
        let world = OAuthWorld()
        world.state.withLock { $0.expiresIn = 3600 }
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let secrets = InMemorySecretStore()
        let now = Date(timeIntervalSince1970: 10_000)
        try seedTokens(secrets, access: "at-1", refresh: "rt-1", expiresAt: now.addingTimeInterval(-5))

        let session = MCPOAuthSession(serverURL: acmeURL, transport: transport, secrets: secrets,
                                      environment: MCPAuthEnvironment(presenter: nil, loopback: nil, now: { now }), manualClient: nil)
        // Two callers race for an expired token: one refresh request.
        async let a = session.accessToken()
        async let b = session.accessToken()
        let (ta, tb) = await (a, b)
        #expect(ta == "at-2")
        #expect(tb == "at-2")
        let refreshes = transport.requests.filter { $0.url?.path() == "/token" }
        #expect(refreshes.count == 1)
        let form = URLRequest(url: refreshes[0].url!).with(body: refreshes[0].body).form
        #expect(form["grant_type"] == "refresh_token")
        #expect(form["refresh_token"] == "rt-1")
        #expect(form["resource"] == "https://mcp.acme.test/mcp")

        // The rotated refresh token replaced the old one in storage.
        let stored = try #require(try secrets.secret(for: OAuthKeys.tokens(issuer: "https://auth.acme.test", resource: "https://mcp.acme.test/mcp")))
        let decoded = try JSONDecoder().decode(StoredTokens.self, from: Data(stored.utf8))
        #expect(decoded.refreshToken == "rt-2")
        #expect(decoded.accessToken == "at-2")
    }

    @Test func rejectedAccessTokenTriggersRefreshThenRetry() async throws {
        let world = OAuthWorld()
        // Server only accepts at-2: at-1 (stored, not expired) gets a 401.
        world.state.withLock { $0.issued = ["at-1"] }
        let transport = ScriptedTransport { r, _ in
            if r.url?.host() == "mcp.acme.test", r.url?.path() == "/mcp", r.header("Authorization") == "Bearer at-1" {
                return Reply(status: 401, headers: ["WWW-Authenticate": #"Bearer error="invalid_token""#], body: Data())
            }
            return world.handle(r)
        }
        let secrets = InMemorySecretStore()
        try seedTokens(secrets, access: "at-1", refresh: "rt-1", expiresAt: Date().addingTimeInterval(3600))
        let client = makeClient(transport, config: acmeConfig(auth: .oauth), secrets: secrets,
                                auth: MCPAuthEnvironment(presenter: nil, loopback: nil))
        _ = try await client.listTools()
        let mcpCalls = transport.requests.filter { $0.url?.path() == "/mcp" }.map { $0.header("Authorization") ?? "-" }
        #expect(mcpCalls.first == "Bearer at-1")
        #expect(mcpCalls.dropFirst().allSatisfy { $0 == "Bearer at-2" })
    }

    @Test func withoutPresenterSurfacesRequirement() async throws {
        let world = OAuthWorld()
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        // Not configured for OAuth: the 401 is explained, not acted on.
        let client = makeClient(transport, config: acmeConfig(auth: .none))
        await #expect(throws: MCPError.authorizationRequired(.oauthAutomatic(issuer: "https://auth.acme.test"))) {
            try await client.connect()
        }
        // Configured for OAuth but no UI available.
        let headless = makeClient(transport, config: acmeConfig(auth: .oauth), auth: MCPAuthEnvironment(presenter: nil, loopback: nil))
        await #expect(throws: MCPError.authorizationRequired(.oauthAutomatic(issuer: "https://auth.acme.test"))) {
            try await headless.connect()
        }
    }

    @Test func refusesAuthorizationServerWithoutS256() async throws {
        let transport = ScriptedTransport { r, _ in
            switch r.url?.path() ?? "" {
            case "/mcp": return Reply(status: 401, headers: ["WWW-Authenticate": "Bearer"], body: Data())
            case "/.well-known/oauth-protected-resource/mcp":
                return .json(#"{"resource":"https://mcp.acme.test/mcp","authorization_servers":["https://auth.acme.test"]}"#)
            case "/.well-known/oauth-authorization-server":
                return .json(#"{"issuer":"https://auth.acme.test","authorization_endpoint":"https://auth.acme.test/a","token_endpoint":"https://auth.acme.test/t","code_challenge_methods_supported":["plain"]}"#)
            default: return Reply(status: 404, body: Data())
            }
        }
        let client = makeClient(transport, config: acmeConfig(auth: .oauth),
                                auth: MCPAuthEnvironment(presenter: StubPresenter { _, _ in Issue.record("must not present"); throw CancellationError() }, loopback: nil))
        await #expect(throws: MCPError.auth(.pkceUnsupported(issuer: "https://auth.acme.test"))) { try await client.connect() }
    }

    @Test func manualClientSkipsRegistration() async throws {
        let world = OAuthWorld()
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let client = makeClient(transport, config: acmeConfig(auth: .manualOAuth(clientID: "cid-1", clientSecretKey: nil)),
                                auth: MCPAuthEnvironment(presenter: world.presenter(log: Box()), loopback: nil))
        _ = try await client.listTools()
        #expect(!transport.requests.contains { $0.url?.path() == "/register" })
        #expect(world.state.withLock { $0.registrations } == 0)
    }

    @Test func loopbackFallbackWhenCustomSchemeRejected() async throws {
        let world = OAuthWorld()
        world.state.withLock { $0.rejectCustomScheme = true }
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let loopback = FakeLoopback()
        let presenter = StubPresenter { url, scheme in
            #expect(scheme == "http")
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let state = items.first { $0.name == "state" }?.value ?? ""
            await loopback.deliver(URL(string: "http://127.0.0.1:53682/callback?code=code-1&state=\(state)&iss=https%3A%2F%2Fauth.acme.test")!)
            try await Task.sleep(for: .seconds(30)) // the sheet stays open until cancelled
            throw CancellationError()
        }
        let client = makeClient(transport, config: acmeConfig(auth: .oauth),
                                auth: MCPAuthEnvironment(presenter: presenter, loopback: { loopback }))
        _ = try await client.listTools()
        let registrations = transport.requests.filter { $0.url?.path() == "/register" }.compactMap { $0.json?["redirect_uris"]?[0]?.stringValue }
        #expect(registrations == ["praxischat://oauth/callback", "http://127.0.0.1:53682/callback"])
        #expect(await loopback.stopped)
    }

    @Test func parsesWWWAuthenticate() {
        let challenges = WWWAuthenticate.parse(#"Basic realm="x", Bearer error="insufficient_scope", scope="a b", resource_metadata="https://r.test/prm""#)
        #expect(challenges.map(\.scheme) == ["Basic", "Bearer"])
        #expect(challenges[1].isInsufficientScope)
        #expect(challenges[1].scopes == ["a", "b"])
        #expect(challenges[1].params["resource_metadata"] == "https://r.test/prm")
    }

    @Test func discoveryURLOrder() {
        #expect(OAuthDiscovery.protectedResourceCandidates(for: URL(string: "https://x.test/v1/mcp")!).map(\.absoluteString) == [
            "https://x.test/.well-known/oauth-protected-resource/v1/mcp", "https://x.test/.well-known/oauth-protected-resource",
        ])
        #expect(OAuthDiscovery.authorizationServerCandidates(issuer: "https://as.test/tenant").map(\.absoluteString) == [
            "https://as.test/.well-known/oauth-authorization-server/tenant",
            "https://as.test/.well-known/openid-configuration/tenant",
            "https://as.test/tenant/.well-known/openid-configuration",
        ])
    }

    private func seedTokens(_ secrets: InMemorySecretStore, access: String, refresh: String, expiresAt: Date) throws {
        let issuer = "https://auth.acme.test", resource = "https://mcp.acme.test/mcp"
        let tokens = StoredTokens(accessToken: access, refreshToken: refresh, expiresAt: expiresAt, scope: "files:read", issuer: issuer,
                                  resource: resource, tokenEndpoint: URL(string: "https://auth.acme.test/token")!, clientID: "cid-1")
        try secrets.setSecret(String(decoding: JSONEncoder().encode(tokens), as: UTF8.self), for: OAuthKeys.tokens(issuer: issuer, resource: resource))
        try secrets.setSecret(#"{"issuer":"\#(issuer)","resource":"\#(resource)"}"#, for: OAuthKeys.binding(server: resource))
    }
}

actor FakeLoopback: OAuthLoopbackServer {
    private var callback: URL?
    private var waiter: CheckedContinuation<URL, Error>?
    private(set) var stopped = false

    func start(preferredPort: UInt16?) async throws -> URL { URL(string: "http://127.0.0.1:53682/callback")! }
    func waitForCallback() async throws -> URL {
        if let callback { return callback }
        return try await withCheckedThrowingContinuation { waiter = $0 }
    }
    func deliver(_ url: URL) {
        callback = url
        waiter?.resume(returning: url)
        waiter = nil
    }
    func stop() {
        stopped = true
        waiter?.resume(throwing: CancellationError())
        waiter = nil
    }
}

extension URLRequest {
    func with(body: Data?) -> URLRequest {
        var r = self
        r.httpBody = body
        return r
    }
}

@Suite struct StepUpAndLoopbackTests {
    @Test func insufficientScopeStepsUpWithUnionOfScopes() async throws {
        let world = OAuthWorld()
        let challenged = Mutex(false)
        let transport = ScriptedTransport { r, _ in
            if r.rpcMethod == "tools/call", !challenged.withLock({ $0 }) {
                challenged.withLock { $0 = true }
                return Reply(status: 403, headers: [
                    "WWW-Authenticate": #"Bearer error="insufficient_scope", scope="files:write", resource_metadata="\#(world.prmURL)""#,
                ], body: Data())
            }
            return world.handle(r)
        }
        let opened = Box<URL>()
        let client = makeClient(transport, config: acmeConfig(auth: .oauth),
                                auth: MCPAuthEnvironment(presenter: world.presenter(log: opened), loopback: nil))
        // Listing (connector settings, first send) may sign in on the spot.
        _ = try await client.listTools()
        #expect(opened.all.count == 1)
        // A tool call never opens the sheet: the step-up is the user's tap.
        await #expect(throws: MCPError.authorizationRequired(.oauthAutomatic(issuer: "https://auth.acme.test"))) {
            _ = try await client.callTool("search")
        }
        #expect(opened.all.count == 1)
        try await client.signIn()
        let result = try await client.callTool("search")
        #expect(result.content == [.text("ok")])
        let scopes = opened.all.map { url in
            URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "scope" }?.value
        }
        #expect(scopes == ["files:read", "files:read files:write"])
        // The client registration was reused for the step-up.
        #expect(world.state.withLock { $0.registrations } == 1)
    }

    #if os(macOS)
    @Test func loopbackListenerReceivesTheCallback() async throws {
        let loopback = LoopbackRedirect()
        let redirect = try await loopback.start(preferredPort: nil)
        #expect(redirect.host() == "127.0.0.1")
        #expect(redirect.path() == "/callback")
        async let callback = loopback.waitForCallback()
        var components = URLComponents(url: redirect, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "code", value: "abc"), URLQueryItem(name: "state", value: "xyz")]
        let (data, response) = try await URLSession(configuration: .ephemeral).data(from: components.url!)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        #expect(String(decoding: data, as: UTF8.self).contains("signed in"))
        let received = try await callback
        let items = URLComponents(url: received, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(items.first { $0.name == "code" }?.value == "abc")
        #expect(items.first { $0.name == "state" }?.value == "xyz")
        await loopback.stop()
    }
    #endif
}
