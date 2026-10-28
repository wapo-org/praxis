import XCTest
import Synchronization
import AgentCore
import AgentMCP
import AgentTestSupport
@testable import PraxisChat

/// Servers that answer anonymously but need sign-in for calls (Google's
/// Gmail MCP server): the add flow's probe, the chat step's "Sign in to"
/// action, Google client-ID guidance, and connector prompts.
@MainActor
final class ConnectorSignInTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws { directory = temporaryDirectory() }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

    /// Gmail-shaped: legacy Streamable HTTP, anonymous `tools/list`, 401
    /// on `tools/call`, RFC 9728 metadata naming a Google-style issuer
    /// without Dynamic Client Registration, and one prompt.
    private func gmailLike() -> ScriptedTransport {
        ScriptedTransport { request, _ in
            let rpc = request.httpBody.flatMap { try? JSONValue(parsing: $0) } ?? [:]
            let id = rpc["id"] ?? .null
            func result(_ value: JSONValue, status: Int = 200, headers: [String: String] = [:]) -> ScriptedTransport.Reply {
                .json(JSONValue.object(["jsonrpc": "2.0", "id": id, "result": value]).encodedString(), status: status, headers: headers)
            }
            switch (request.url?.host() ?? "", request.url?.path() ?? "") {
            case ("gmail.test", "/mcp/v1"):
                switch rpc["method"]?.stringValue {
                case "server/discover"?:
                    return .json(#"{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid params"}}"#)
                case "initialize"?:
                    return result(["protocolVersion": "2025-06-18", "capabilities": ["tools": [:], "prompts": [:]],
                                   "serverInfo": ["name": "gmail", "version": "1"]])
                case "tools/list"?:
                    return result(["tools": [["name": "search_threads", "inputSchema": ["type": "object"]]]])
                case "prompts/list"?:
                    return result(["prompts": [["name": "triage", "title": "Triage inbox"]]])
                case "prompts/get"?:
                    return result(["messages": [["role": "user", "content": ["type": "text", "text": "Triage my unread mail."]]]])
                case "tools/call"?:
                    return result(["content": [["type": "text", "text": "Request is missing required authentication credential."]],
                                   "isError": true], status: 401,
                                  headers: ["WWW-Authenticate": #"Bearer resource_metadata="https://gmail.test/.well-known/oauth-protected-resource/mcp/v1""#])
                default:
                    return .json("{}", status: 202)
                }
            case ("gmail.test", "/.well-known/oauth-protected-resource/mcp/v1"):
                return .json(#"{"authorization_servers":["https://accounts.google.com/"],"resource":"https://gmail.test/mcp/v1","scopes_supported":["gmail.readonly","gmail.compose"]}"#)
            case ("accounts.google.com", "/.well-known/openid-configuration"):
                return .json(#"{"issuer":"https://accounts.google.com","authorization_endpoint":"https://accounts.google.com/o/oauth2/v2/auth","token_endpoint":"https://oauth2.googleapis.com/token","code_challenge_methods_supported":["S256"]}"#)
            default:
                return ScriptedTransport.Reply(status: 404, body: Data())
            }
        }
    }

    private func installGmail(_ library: ConnectorLibrary) throws -> String {
        let candidate = try ConnectorLibrary.candidate(url: "https://gmail.test/mcp/v1", name: "Gmail")
        return try library.install(candidate).id
    }

    func testAnonymousServerThatAdvertisesSignInIsMarkedSignInAvailable() async throws {
        let library = ConnectorLibrary(fileURL: directory.appendingPathComponent("C.json"), secrets: InMemorySecretStore(),
                                       transport: gmailLike())
        let id = try installGmail(library)
        let tools = try await library.review(id)
        XCTAssertEqual(tools.map(\.name), ["search_threads"])
        let issuer = "https://accounts.google.com"
        XCTAssertEqual(library.signInOffers[id]?.requirement, .oauthNeedsClientCredentials(issuer: issuer))
        XCTAssertEqual(library.state(of: id), .signInAvailable(toolCount: 1, .oauthNeedsClientCredentials(issuer: issuer)))
        XCTAssertFalse(library.canSignInDirectly(id), "no DCR: the user needs the client-ID form")
        XCTAssertEqual(library.prompts[id]?.map(\.name), ["triage"])

        // A call refused mid-run marks it as needing sign-in.
        library.handle(.authorizationRequired(.oauthNeedsClientCredentials(issuer: issuer)), serverID: id)
        XCTAssertEqual(library.state(of: id), .needsSignIn(.oauthNeedsClientCredentials(issuer: issuer)))

        // The user enters a Google iOS client ID: the reversed-client-ID
        // redirect and the chosen scopes go into the config.
        let clientID = "123-abc.apps.googleusercontent.com"
        try await library.setManualOAuth(id, clientID: clientID, clientSecret: nil,
                                         redirectURI: OAuthClientGuide.redirect(forClientID: clientID), scopes: ["gmail.readonly"])
        let config = try XCTUnwrap(library.server(id))
        XCTAssertEqual(config.auth, .manualOAuth(clientID: clientID, clientSecretKey: nil))
        XCTAssertEqual(config.oauthRedirectURI, "com.googleusercontent.apps.123-abc:/oauthredirect")
        XCTAssertEqual(config.oauthScopes, ["gmail.readonly"])
        XCTAssertTrue(library.canSignInDirectly(id))

        // Web redirects aren't accepted for a manual client (nothing hosted).
        do {
            try await library.setManualOAuth(id, clientID: clientID, clientSecret: nil, redirectURI: "https://example.com/cb")
            XCTFail("expected a rejection")
        } catch {}
    }

    func testRefusedCallIsReportedToTheLibraryThroughTheClient() async throws {
        let library = ConnectorLibrary(fileURL: directory.appendingPathComponent("C.json"), secrets: InMemorySecretStore(),
                                       transport: gmailLike())
        let id = try installGmail(library)
        let client = try XCTUnwrap(library.client(for: id))
        do {
            _ = try await client.callTool("search_threads")
            XCTFail("expected sign-in to be required")
        } catch MCPError.authorizationRequired {}
        let expectation = expectation(description: "event applied")
        Task { @MainActor in
            while library.authRequirements[id] == nil { try? await Task.sleep(for: .milliseconds(10)) }
            expectation.fulfill()
        }
        await fulfillment(of: [expectation], timeout: 3)
        XCTAssertEqual(library.signInNeed(id), .oauthNeedsClientCredentials(issuer: "https://accounts.google.com"))
    }

    func testSignInNoticeTraceBecomesAStepAction() {
        var reducer = TurnReducer()
        var turn = Turn(userText: "find my prescription")
        let now = Date()
        _ = reducer.reduce(.toolCallStarted(tool("t1", .integration, source: .mcp(serverID: "gmail", serverName: "Gmail"))),
                           into: &turn, at: now)
        _ = reducer.reduce(.toolProgress(id: "t1", .trace(.note, MCPSignInNotice.trace(serverID: "gmail", serverName: "Gmail"))),
                           into: &turn, at: now)
        _ = reducer.reduce(.toolProgress(id: "t1", .trace(.note, "an ordinary note")), into: &turn, at: now)
        let step = try! XCTUnwrap(turn.activities.first?.steps.first)
        XCTAssertEqual(step.signIn, StepSignIn(serverID: "gmail", serverName: "Gmail"))
        XCTAssertEqual(step.traces.map(\.text), ["an ordinary note"], "the marker isn't shown as a trace")

        // Persisted turns keep it; older files without it still decode.
        let data = try! JSONEncoder().encode(step)
        XCTAssertEqual(try! JSONDecoder().decode(Step.self, from: data).signIn, step.signIn)
        var old = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        old["signIn"] = nil
        let decoded = try! JSONDecoder().decode(Step.self, from: JSONSerialization.data(withJSONObject: old))
        XCTAssertNil(decoded.signIn)
    }

    func testGoogleClientIDGuide() {
        XCTAssertEqual(OAuthClientGuide.redirect(forClientID: "123-abc.apps.googleusercontent.com"),
                       "com.googleusercontent.apps.123-abc:/oauthredirect")
        XCTAssertNil(OAuthClientGuide.redirect(forClientID: "my-client"))
        XCTAssertNil(OAuthClientGuide.redirect(forClientID: ".apps.googleusercontent.com"))
        XCTAssertEqual(OAuthClientGuide.scopes(from: "a b,c\nd"), ["a", "b", "c", "d"])
        XCTAssertNil(OAuthClientGuide.scopes(from: "  "))
        let google = OAuthClientGuide(issuer: "https://accounts.google.com")
        XCTAssertTrue(google.isGoogle)
        XCTAssertTrue(google.steps.joined().contains("iOS"))
        XCTAssertTrue(google.steps.joined().contains(OAuthClientGuide.bundleID))
        let other = OAuthClientGuide(issuer: "https://auth.example.com")
        XCTAssertFalse(other.isGoogle)
        XCTAssertTrue(other.steps.joined().contains(OAuthClientGuide.defaultRedirect))
    }

    func testPromptGoesIntoTheComposer() async throws {
        let library = ConnectorLibrary(fileURL: directory.appendingPathComponent("C.json"), secrets: InMemorySecretStore(),
                                       transport: gmailLike())
        let id = try installGmail(library)
        _ = try await library.review(id)
        let result = try await library.prompt(id, name: "triage", arguments: [:])
        XCTAssertEqual(result.composerText, "Triage my unread mail.")
    }

    // MARK: Scope field

    func testScopeFieldPrefillsLeastPrivilegeAndOffersTheRest() {
        let all = ["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.metadata",
                   "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"]
        let recommended = MCPScopeSelection.defaults(supported: all, issuer: "https://accounts.google.com")
        let prefill = OAuthClientGuide.prefill(recommended: recommended, advertised: all)
        XCTAssertEqual(prefill.map(OAuthClientGuide.shortName), ["gmail.readonly", "gmail.compose"])
        XCTAssertEqual(OAuthClientGuide.unrequested(all, field: prefill.joined(separator: " ")).map(OAuthClientGuide.shortName),
                       ["mail.google.com", "gmail.metadata"])
        XCTAssertEqual(OAuthClientGuide.prefill(recommended: [], advertised: ["a", "b"]), ["a", "b"])
        let guide = OAuthClientGuide(issuer: "https://accounts.google.com")
        XCTAssertTrue(guide.footnote(narrowed: true).contains("gmail.readonly"))
        XCTAssertFalse(OAuthClientGuide(issuer: "https://auth.acme.test").footnote(narrowed: false).contains("gmail"))
        XCTAssertEqual(OAuthClientGuide.shortName("files:read"), "files:read")
    }
}
