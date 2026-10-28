import Foundation
import Testing
import Synchronization
import AgentCore
import AgentTestSupport
@testable import AgentMCP

/// A server shaped like Google's Gmail MCP endpoint: legacy Streamable
/// HTTP (the modern probe gets a JSON-RPC error), `initialize` and
/// `tools/list` work anonymously, `tools/call` answers 401 with a
/// per-tool `resource_metadata`. Its authorization server has OIDC
/// metadata only and no Dynamic Client Registration, so the user brings
/// an iOS-type client ID whose redirect is the reversed-client-ID scheme.
final class AnonymousListingWorld: Sendable {
    static let serverURL = URL(string: "https://gmail.test/mcp/v1")!
    static let clientID = "123-abc.apps.googleusercontent.com"
    static let redirect = "com.googleusercontent.apps.123-abc:/oauthredirect"

    struct State: Sendable {
        var issued: [String] = []
        var callBodyIsAuthText = false
        var advertisesSignIn = true
    }
    let state = Mutex(State())

    func handle(_ request: URLRequest) -> Reply {
        let url = request.url!
        switch (url.host() ?? "", url.path()) {
        case ("gmail.test", "/mcp/v1"):
            switch request.rpcMethod {
            case "server/discover"?:
                return Fake.error(request, code: -32602, message: "Invalid params")
            case "initialize"?:
                return Fake.result(request, ["protocolVersion": "2025-06-18", "capabilities": ["tools": ["listChanged": false]],
                                             "serverInfo": ["name": "StatelessServer", "version": "ESF"]])
            case "notifications/initialized"?:
                return Fake.accepted
            case "tools/list"?:
                return Fake.result(request, ["tools": [Fake.tool("search_threads", readOnly: true)]])
            case "tools/call"?:
                let auth = request.header("Authorization")
                let valid = auth != nil && state.withLock { s in s.issued.last.map { "Bearer \($0)" } == auth }
                if valid { return Fake.result(request, Fake.text("3 threads")) }
                let denial: JSONValue = ["content": [["type": "text", "text": "Request is missing required authentication credential. Expected OAuth 2 access token."]],
                                         "isError": true]
                if state.withLock({ $0.callBodyIsAuthText }) { return Fake.result(request, denial) }
                var reply = Fake.result(request, denial)
                reply.status = 401
                reply.headers["WWW-Authenticate"] = #"Bearer resource_metadata="https://gmail.test/.well-known/oauth-protected-resource/search_threads""#
                return reply
            default:
                return Fake.error(request, code: -32601, message: "Method not found")
            }
        case ("gmail.test", "/.well-known/oauth-protected-resource/mcp/v1"):
            guard state.withLock({ $0.advertisesSignIn }) else { return Reply(status: 404, body: Data()) }
            return .json(#"{"authorization_servers":["https://accounts.test/"],"resource":"https://gmail.test/mcp/v1","scopes_supported":["https://mail.test/","gmail.readonly","gmail.compose"]}"#)
        case ("gmail.test", "/.well-known/oauth-protected-resource/search_threads"):
            return .json(#"{"authorization_servers":["https://accounts.test/"],"resource":"https://gmail.test/mcp","scopes_supported":["https://mail.test/","gmail.readonly"]}"#)
        case ("accounts.test", "/.well-known/openid-configuration"):
            return .json("""
            {"issuer":"https://accounts.test","authorization_endpoint":"https://accounts.test/o/oauth2/v2/auth",
             "token_endpoint":"https://oauth2.accounts.test/token","code_challenge_methods_supported":["plain","S256"],
             "authorization_response_iss_parameter_supported":true,"scopes_supported":["openid","email"],
             "token_endpoint_auth_methods_supported":["client_secret_post","client_secret_basic"]}
            """)
        case ("oauth2.accounts.test", "/token"):
            let form = request.form
            guard form["grant_type"] == "authorization_code", form["code"] == "code-g", form["client_id"] == Self.clientID,
                  form["redirect_uri"] == Self.redirect, form["code_verifier"]?.isEmpty == false, form["client_secret"] == nil else {
                return .json(#"{"error":"invalid_grant"}"#, status: 400)
            }
            let token = state.withLock { s -> String in
                s.issued.append("ya29.\(s.issued.count + 1)")
                return s.issued.last!
            }
            return .json(#"{"access_token":"\#(token)","token_type":"Bearer","refresh_token":"1//rt","expires_in":3599}"#)
        default:
            return Reply(status: 404, body: Data())
        }
    }

    /// Approves whatever is asked, as Google would: back to the redirect
    /// with the code, state and issuer.
    func presenter(log: Box<(URL, String)>) -> StubPresenter {
        StubPresenter { url, scheme in
            log.append((url, scheme))
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let state = items.first { $0.name == "state" }?.value ?? ""
            let redirect = items.first { $0.name == "redirect_uri" }?.value ?? ""
            return URL(string: "\(redirect)?state=\(state)&code=code-g&scope=gmail.readonly&iss=https%3A%2F%2Faccounts.test")!
        }
    }

    static func config(auth: MCPAuthKind = .none, scopes: [String]? = nil) -> MCPServerConfig {
        let redirectURI: String? = if case .manualOAuth = auth { redirect } else { nil }
        return MCPServerConfig(id: "gmail", name: "Gmail", url: serverURL, auth: auth,
                               oauthRedirectURI: redirectURI, oauthScopes: scopes)
    }
}

@Suite struct SignInOnCallTests {
    private func client(_ world: AnonymousListingWorld, _ transport: ScriptedTransport, config: MCPServerConfig,
                        secrets: any SecretStore = InMemorySecretStore(), presenter: (any OAuthPresenter)? = nil,
                        events: Box<MCPClientEvent>? = nil) -> MCPClient {
        var handler: (@Sendable (MCPClientEvent) -> Void)?
        if let events { handler = { event in events.append(event) } }
        return MCPClient(config: config, transport: transport, secrets: secrets,
                         auth: MCPAuthEnvironment(presenter: presenter, loopback: nil),
                         options: MCPClientOptions(requestTimeout: .seconds(5), callTimeout: .seconds(5)),
                         onEvent: handler)
    }

    @Test func toolsListAnonymouslyButTheCallNeedsSignIn() async throws {
        let world = AnonymousListingWorld()
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let events = Box<MCPClientEvent>()
        let gmail = client(world, transport, config: AnonymousListingWorld.config(), events: events)

        // What the add flow saw on device: tools, no 401 anywhere.
        let tools = try await gmail.listTools()
        #expect(tools.map(\.name) == ["search_threads"])
        #expect(await gmail.serverInfo?.era == .legacyStreamableHTTP)

        // (a) The probe still finds the sign-in the server advertises.
        let offer = try #require(await gmail.signInOffer())
        #expect(offer.requirement == .oauthNeedsClientCredentials(issuer: "https://accounts.test"))
        #expect(offer.scopes == ["https://mail.test/", "gmail.readonly", "gmail.compose"])

        // (b) The call's 401 becomes a sign-in requirement + an event.
        await #expect(throws: MCPError.authorizationRequired(.oauthNeedsClientCredentials(issuer: "https://accounts.test"))) {
            _ = try await gmail.callTool("search_threads", arguments: ["q": "recepta"])
        }
        #expect(events.all == [.authorizationRequired(.oauthNeedsClientCredentials(issuer: "https://accounts.test"))])
    }

    @Test func probeFindsNothingOnServersWithoutMetadata() async throws {
        let world = AnonymousListingWorld()
        world.state.withLock { $0.advertisesSignIn = false }
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let gmail = client(world, transport, config: AnonymousListingWorld.config())
        #expect(await gmail.signInOffer() == nil)
        // And no origin-as-issuer guess: nothing was asked of the origin's AS metadata.
        #expect(!transport.requests.contains { $0.url?.path().contains("oauth-authorization-server") == true && $0.url?.host() == "gmail.test" })
    }

    @Test func aCallNeverOpensTheSignInSheetButAnExplicitSignInDoes() async throws {
        let world = AnonymousListingWorld()
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let opened = Box<(URL, String)>()
        let events = Box<MCPClientEvent>()
        let config = AnonymousListingWorld.config(auth: .manualOAuth(clientID: AnonymousListingWorld.clientID, clientSecretKey: nil),
                                                  scopes: ["gmail.readonly", "gmail.compose"])
        let gmail = client(world, transport, config: config, presenter: world.presenter(log: opened), events: events)

        _ = try await gmail.listTools()
        await #expect(throws: MCPError.authorizationRequired(.oauthAutomatic(issuer: "https://accounts.test"))) {
            _ = try await gmail.callTool("search_threads", arguments: ["q": "x"])
        }
        #expect(opened.all.isEmpty) // mid-run: no sheet
        #expect(events.all == [.authorizationRequired(.oauthAutomatic(issuer: "https://accounts.test"))])
        #expect(await gmail.isSignedIn == false)

        // The user taps "Sign in to Gmail".
        try await gmail.signIn()
        let (authorize, scheme) = try #require(opened.all.first)
        #expect(scheme == "com.googleusercontent.apps.123-abc")
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: authorize, resolvingAgainstBaseURL: false)?.queryItems ?? [])
            .map { ($0.name, $0.value ?? "") })
        #expect(authorize.host() == "accounts.test")
        #expect(query["client_id"] == AnonymousListingWorld.clientID)
        #expect(query["redirect_uri"] == AnonymousListingWorld.redirect)
        #expect(query["scope"] == "gmail.readonly gmail.compose") // the user's choice, not all 3 advertised
        #expect(query["code_challenge_method"] == "S256")
        #expect(await gmail.isSignedIn)

        // The next call carries the token and works — same client, no re-freeze.
        let result = try await gmail.callTool("search_threads", arguments: ["q": "x"])
        #expect(result.content == [.text("3 threads")])
        let lastCall = try #require(transport.requests.last { $0.rpcMethod == "tools/call" })
        #expect(lastCall.header("Authorization") == "Bearer ya29.1")
    }

    @Test func reauthOnAReplacedClientThenTheCallSucceeds() async throws {
        // The app's flow: the plain connector fails, the user enters a
        // client ID (config replaced → new client), signs in, retries.
        let world = AnonymousListingWorld()
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let secrets = InMemorySecretStore()
        let plain = client(world, transport, config: AnonymousListingWorld.config(), secrets: secrets)
        _ = try await plain.listTools()
        await #expect(throws: MCPError.self) { _ = try await plain.callTool("search_threads") }

        let opened = Box<(URL, String)>()
        let manual = client(world, transport,
                            config: AnonymousListingWorld.config(auth: .manualOAuth(clientID: AnonymousListingWorld.clientID, clientSecretKey: nil)),
                            secrets: secrets, presenter: world.presenter(log: opened))
        try await manual.signIn()
        #expect(opened.all.count == 1)
        // No configured scopes, no challenge: everything the metadata lists.
        let query = URLComponents(url: opened.all[0].0, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(query.first { $0.name == "scope" }?.value == "https://mail.test/ gmail.readonly gmail.compose")
        #expect(query.first { $0.name == "resource" }?.value == "https://gmail.test/mcp/v1")
        #expect(try await manual.callTool("search_threads").content == [.text("3 threads")])

        // Tokens live in the SecretStore: a relaunch needs no sheet.
        let relaunched = client(world, transport,
                                config: AnonymousListingWorld.config(auth: .manualOAuth(clientID: AnonymousListingWorld.clientID, clientSecretKey: nil)),
                                secrets: secrets)
        #expect(await relaunched.isSignedIn)
        #expect(try await relaunched.callTool("search_threads").content == [.text("3 threads")])
    }

    @Test func anAuthLookingErrorWithoutA401CountsWhenTheServerAdvertisesSignIn() async throws {
        let world = AnonymousListingWorld()
        world.state.withLock { $0.callBodyIsAuthText = true }
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let events = Box<MCPClientEvent>()
        let gmail = client(world, transport, config: AnonymousListingWorld.config(), events: events)
        await #expect(throws: MCPError.authorizationRequired(.oauthNeedsClientCredentials(issuer: "https://accounts.test"))) {
            _ = try await gmail.callTool("search_threads")
        }
        #expect(events.all.count == 1)

        // Same text from a server that advertises nothing: an ordinary tool error.
        let quiet = AnonymousListingWorld()
        quiet.state.withLock { $0.callBodyIsAuthText = true; $0.advertisesSignIn = false }
        let other = client(quiet, ScriptedTransport { r, _ in quiet.handle(r) }, config: AnonymousListingWorld.config())
        let result = try await other.callTool("search_threads")
        #expect(result.isError)
    }

    @Test func theToolTellsTheModelToAskForTheButtonAndMarksTheStep() async throws {
        let world = AnonymousListingWorld()
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let gmail = client(world, transport, config: AnonymousListingWorld.config())
        let set = MCPToolset(listings: [(gmail, try await gmail.listTools())])
        let tool = try #require(set.catalog.first)
        let progress = Box<ToolProgress>()
        let output = try await tool.execute(ToolInvocation(id: "t1", name: tool.spec.name, arguments: ["q": "x"]),
                                            context: ToolContext(conversationID: "c", mode: .auto, emit: { progress.append($0) }))
        #expect(output.isError)
        #expect(output.summary == "Gmail needs sign-in")
        #expect(output.text.contains("“Sign in to Gmail” button"))
        #expect(output.text.contains("accounts.test"))
        #expect(output.text.contains("Don't ask the user to paste"))
        let marker = progress.all.compactMap { p -> String? in if case .trace(.note, let t) = p { return t }; return nil }.first
        let parsed = try #require(marker.flatMap(MCPSignInNotice.parse))
        #expect(parsed.serverID == "gmail")
        #expect(parsed.serverName == "Gmail")
        #expect(MCPSignInNotice.parse("ordinary note") == nil)
    }
}
