import Foundation
import Testing
import Synchronization
import AgentCore
import AgentTestSupport
@testable import AgentMCP

private let mail = "https://mail.google.com/"
private func gmail(_ s: String) -> String { "https://www.googleapis.com/auth/gmail.\(s)" }
/// What gmailmcp.googleapis.com/mcp/v1 lists (fetched 2026-10-25).
private let gmailScopes = [mail] + ["compose", "drafts", "drafts.create", "drafts.readonly", "labels", "metadata",
                                    "modify", "readonly", "send", "settings.basic"].map(gmail)
/// Its per-tool metadata (`/.well-known/oauth-protected-resource/<tool>`): any one suffices.
private let perTool: [String: [String]] = [
    "search_threads": [mail, gmail("modify"), gmail("readonly")],
    "create_draft": [mail, gmail("compose"), gmail("drafts"), gmail("drafts.create"), gmail("modify")],
    "trash_thread": [mail, gmail("modify")],
    "list_labels": [mail, gmail("modify"), gmail("readonly"), gmail("labels"), gmail("metadata")],
]
private let google = "https://accounts.google.com/"

@Suite struct ScopeSelectionTests {
    @Test func googleDefaultsToItsGmailGuidesLeastPrivilegeSet() {
        #expect(MCPScopeSelection.defaults(supported: gmailScopes, issuer: google) == [gmail("readonly"), gmail("compose")])
        // Only what the server lists: a server offering just one of them gets just that one.
        #expect(MCPScopeSelection.defaults(supported: [mail, gmail("readonly")], issuer: google) == [gmail("readonly")])
        // A Google server offering none of them (another product) gets what it lists.
        let calendar = ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.readonly"]
        #expect(MCPScopeSelection.defaults(supported: calendar, issuer: google) == calendar)
    }

    @Test func challengedScopesWinAndOtherIssuersGetWhatTheyList() {
        #expect(MCPScopeSelection.defaults(supported: gmailScopes, challenged: [gmail("send")], issuer: google) == [gmail("send")])
        #expect(MCPScopeSelection.defaults(supported: ["files:read", "files:write"], issuer: "https://auth.acme.test")
            == ["files:read", "files:write"])
        #expect(MCPScopeSelection.defaults(supported: ["a", "a", "b"], issuer: nil) == ["a", "b"])
    }

    @Test func toolAlternativesGoNarrowestFirst() {
        for (tool, expected) in [("search_threads", gmail("readonly")), ("create_draft", gmail("compose")),
                                 ("trash_thread", gmail("modify")), ("list_labels", gmail("readonly"))] {
            #expect(MCPScopeSelection.narrowestFirst(perTool[tool]!, issuer: google).first == expected, "\(tool)")
        }
        // The broadest (listed first) comes last.
        #expect(MCPScopeSelection.narrowestFirst(perTool["search_threads"]!, issuer: "https://other.test").last == mail)
    }

    @Test func stepUpAddsOneAlternativeAtATime() {
        let base = [gmail("readonly"), gmail("compose")]
        // Nothing asked yet: the narrowest alternative alone.
        #expect(MCPScopeSelection.stepUp(alternatives: perTool["list_labels"]!, requested: [], granted: [],
                                         issuer: google) == [gmail("readonly")])
        // Trash needs modify: add just that, never the full-mailbox scope.
        #expect(MCPScopeSelection.stepUp(alternatives: perTool["trash_thread"]!, requested: base, granted: Set(base),
                                         issuer: google) == [gmail("modify")])
        // Asked for but not granted (unticked on the consent screen): ask again, add nothing.
        #expect(MCPScopeSelection.stepUp(alternatives: perTool["search_threads"]!, requested: base, granted: [gmail("compose")],
                                         issuer: google) == [])
        // Granted and still refused: widen to the next one.
        #expect(MCPScopeSelection.stepUp(alternatives: perTool["search_threads"]!, requested: base, granted: Set(base),
                                         issuer: google) == [gmail("modify")])
    }
}

/// Gmail's real metadata shape on Google's real issuer: anonymous listing,
/// per-tool `resource_metadata` on 401/403, no DCR.
private final class GoogleWorld: Sendable {
    static let serverURL = URL(string: "https://gmailmcp.test/mcp/v1")!
    static let clientID = "123-abc.apps.googleusercontent.com"
    static let redirect = "com.googleusercontent.apps.123-abc:/oauthredirect"
    /// Tokens issued with the scopes they carry.
    let issued = Mutex<[(token: String, scopes: Set<String>)]>([])

    func handle(_ request: URLRequest) -> Reply {
        let url = request.url!
        switch (url.host() ?? "", url.path()) {
        case ("gmailmcp.test", "/mcp/v1"):
            switch request.rpcMethod {
            case "server/discover"?: return Fake.error(request, code: -32602, message: "Invalid params")
            case "initialize"?:
                return Fake.result(request, ["protocolVersion": "2025-06-18", "capabilities": ["tools": ["listChanged": false]],
                                             "serverInfo": ["name": "StatelessServer", "version": "ESF"]])
            case "notifications/initialized"?: return Fake.accepted
            case "tools/list"?:
                return Fake.result(request, ["tools": .array(perTool.keys.sorted().map { Fake.tool($0) })])
            case "tools/call"?:
                let tool = request.params["name"]?.stringValue ?? ""
                let auth = request.header("Authorization")
                let held = issued.withLock { $0.last { "Bearer \($0.token)" == auth }?.scopes }
                let prm = #"Bearer resource_metadata="https://gmailmcp.test/.well-known/oauth-protected-resource/\#(tool)""#
                guard let held else { return Reply(status: 401, headers: ["WWW-Authenticate": prm], body: Data()) }
                guard !held.isDisjoint(with: perTool[tool] ?? []) else {
                    return Reply(status: 403, headers: ["WWW-Authenticate": #"Bearer error="insufficient_scope", "# + prm.dropFirst(7)],
                                 body: Data())
                }
                return Fake.result(request, Fake.text("ok"))
            default:
                return Fake.error(request, code: -32601, message: "Method not found")
            }
        case ("gmailmcp.test", "/.well-known/oauth-protected-resource/mcp/v1"):
            return .json(#"{"authorization_servers":["\#(google)"],"resource":"https://gmailmcp.test/mcp/v1","scopes_supported":\#(Self.list(gmailScopes))}"#)
        case ("gmailmcp.test", let path) where path.hasPrefix("/.well-known/oauth-protected-resource/"):
            let tool = String(path.dropFirst("/.well-known/oauth-protected-resource/".count))
            guard let scopes = perTool[tool] else { return Reply(status: 404, body: Data()) }
            return .json(#"{"authorization_servers":["\#(google)"],"resource":"https://gmailmcp.test/mcp","scopes_supported":\#(Self.list(scopes))}"#)
        case ("accounts.google.com", "/.well-known/openid-configuration"):
            return .json("""
            {"issuer":"https://accounts.google.com","authorization_endpoint":"https://accounts.google.com/o/oauth2/v2/auth",
             "token_endpoint":"https://oauth2.googleapis.com/token","code_challenge_methods_supported":["plain","S256"],
             "scopes_supported":["openid","email","profile"]}
            """)
        case ("oauth2.googleapis.com", "/token"):
            let form = request.form
            guard form["grant_type"] == "authorization_code", form["client_id"] == Self.clientID else {
                return .json(#"{"error":"invalid_grant"}"#, status: 400)
            }
            // The code carries the scopes the user approved.
            let scopes = Set((form["code"] ?? "").split(separator: " ").map(String.init))
            let token = issued.withLock { list -> String in
                list.append(("ya29.\(list.count + 1)", scopes))
                return "ya29.\(list.count)"
            }
            return .json(#"{"access_token":"\#(token)","token_type":"Bearer","expires_in":3599,"scope":"\#(scopes.sorted().joined(separator: " "))"}"#)
        default:
            return Reply(status: 404, body: Data())
        }
    }

    private static func list(_ scopes: [String]) -> String { "[" + scopes.map { "\"\($0)\"" }.joined(separator: ",") + "]" }

    /// Approves everything asked; the code encodes the requested scopes.
    func presenter(log: Box<String>) -> StubPresenter {
        StubPresenter { url, _ in
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let state = items.first { $0.name == "state" }?.value ?? ""
            let scope = items.first { $0.name == "scope" }?.value ?? ""
            log.append(scope)
            var back = URLComponents(string: Self.redirect)!
            back.queryItems = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "code", value: scope)]
            return back.url!
        }
    }

    func client(log: Box<String>, scopes: [String]? = nil) -> (MCPClient, ScriptedTransport) {
        let transport = ScriptedTransport { [self] r, _ in handle(r) }
        let config = MCPServerConfig(id: "gmail", name: "Gmail", url: Self.serverURL,
                                     auth: .manualOAuth(clientID: Self.clientID, clientSecretKey: nil),
                                     oauthRedirectURI: Self.redirect, oauthScopes: scopes)
        let client = MCPClient(config: config, transport: transport, secrets: InMemorySecretStore(),
                               auth: MCPAuthEnvironment(presenter: presenter(log: log), loopback: nil),
                               options: MCPClientOptions(requestTimeout: .seconds(5), callTimeout: .seconds(5)))
        return (client, transport)
    }
}

@Suite struct GmailScopeFlowTests {
    @Test func offerRecommendsTheLeastPrivilegeSubset() async throws {
        let world = GoogleWorld()
        let (client, _) = world.client(log: Box())
        let offer = try #require(await client.signInOffer())
        #expect(offer.scopes == gmailScopes)
        #expect(offer.recommendedScopes == [gmail("readonly"), gmail("compose")])
    }

    @Test func signInWithoutAChoiceAsksForTheNarrowestScopeTheToolTakes() async throws {
        let world = GoogleWorld()
        let log = Box<String>()
        let (client, _) = world.client(log: log)
        _ = try await client.listTools()
        await #expect(throws: MCPError.self) { _ = try await client.callTool("search_threads") }
        try await client.signIn()
        #expect(log.all == [gmail("readonly")])
        #expect(try await client.callTool("search_threads").content == [.text("ok")])
    }

    @Test func stepUpForATrashCallAddsModifyNotFullMailbox() async throws {
        let world = GoogleWorld()
        let log = Box<String>()
        let (client, _) = world.client(log: log, scopes: [gmail("readonly"), gmail("compose")])
        _ = try await client.listTools()
        await #expect(throws: MCPError.self) { _ = try await client.callTool("search_threads") }
        try await client.signIn()
        #expect(try await client.callTool("search_threads").content == [.text("ok")])
        #expect(try await client.callTool("create_draft").content == [.text("ok")])

        // Trash needs gmail.modify (or full access): the call asks for sign-in again…
        await #expect(throws: MCPError.self) { _ = try await client.callTool("trash_thread") }
        try await client.signIn()
        // …which adds exactly modify to what was granted.
        #expect(log.all == [gmail("readonly") + " " + gmail("compose"),
                            gmail("readonly") + " " + gmail("compose") + " " + gmail("modify")])
        #expect(!log.all.joined(separator: " ").contains(mail))
        #expect(try await client.callTool("trash_thread").content == [.text("ok")])
    }
}
