import Foundation
import Synchronization
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentMCP

/// Regression tests for Team C hardening fix R2-H1: discovered OAuth URLs
/// (challenge metadata, issuers, endpoints) must be https or loopback-http.
@Suite struct CHardeningOAuthURLTests {
    private static let server = URL(string: "https://mcp.evil.test/mcp")!

    @Test func challengeMetadataURLMustBeHttpsOrLoopback() async throws {
        let transport = ScriptedTransport { request, _ in
            let url = request.url!.absoluteString
            if url == "https://mcp.evil.test/.well-known/oauth-protected-resource" {
                return .json(#"{"resource":"https://mcp.evil.test/mcp","authorization_servers":["https://auth.good.test"]}"#)
            }
            if url == "https://auth.good.test/.well-known/oauth-authorization-server" {
                return .json(#"""
                    {"issuer":"https://auth.good.test","authorization_endpoint":"https://auth.good.test/authorize",
                     "token_endpoint":"https://auth.good.test/token","code_challenge_methods_supported":["S256"]}
                    """#)
            }
            return ScriptedTransport.Reply(status: 404, body: Data())
        }
        let discovery = OAuthDiscovery(transport: transport, serverURL: Self.server)
        let challenge = AuthChallenge(scheme: "Bearer", params: ["resource_metadata": "http://169.254.169.254/x"])
        let found = try await discovery.discover(challenge: challenge)
        #expect(found.authServer.issuer == "https://auth.good.test") // fell back to standard candidates
        #expect(!transport.requests.contains { $0.url?.host() == "169.254.169.254" })
    }

    @Test func loopbackChallengeMetadataURLIsFetched() async throws {
        let transport = ScriptedTransport { request, _ in
            if request.url!.absoluteString == "http://127.0.0.1:9/x" {
                return .json(#"{"resource":"https://mcp.evil.test/mcp","authorization_servers":["https://auth.good.test"]}"#)
            }
            if request.url!.absoluteString == "https://auth.good.test/.well-known/oauth-authorization-server" {
                return .json(#"""
                    {"issuer":"https://auth.good.test","authorization_endpoint":"https://auth.good.test/authorize",
                     "token_endpoint":"https://auth.good.test/token","code_challenge_methods_supported":["S256"]}
                    """#)
            }
            return ScriptedTransport.Reply(status: 404, body: Data())
        }
        let discovery = OAuthDiscovery(transport: transport, serverURL: Self.server)
        let challenge = AuthChallenge(scheme: "Bearer", params: ["resource_metadata": "http://127.0.0.1:9/x"])
        let found = try await discovery.discover(challenge: challenge)
        #expect(found.authServer.issuer == "https://auth.good.test")
        #expect(transport.requests.contains { $0.url?.absoluteString == "http://127.0.0.1:9/x" })
    }

    @Test func httpIssuerIsNeverFetched() async throws {
        let transport = ScriptedTransport { request, _ in
            if request.url!.absoluteString == "https://mcp.evil.test/.well-known/oauth-protected-resource/mcp" {
                return .json(#"{"resource":"https://mcp.evil.test/mcp","authorization_servers":["http://as.evil.test"]}"#)
            }
            return ScriptedTransport.Reply(status: 404, body: Data())
        }
        let discovery = OAuthDiscovery(transport: transport, serverURL: Self.server)
        await #expect(throws: MCPError.self) { try await discovery.discover(challenge: nil) }
        #expect(!transport.requests.contains { $0.url?.host() == "as.evil.test" })
    }

    @Test func httpEndpointsVoidTheMetadataDoc() async throws {
        let transport = ScriptedTransport { request, _ in
            let url = request.url!.absoluteString
            if url == "https://mcp.evil.test/.well-known/oauth-protected-resource/mcp" {
                return .json(#"{"resource":"https://mcp.evil.test/mcp","authorization_servers":["https://as.mixed.test"]}"#)
            }
            if url == "https://as.mixed.test/.well-known/oauth-authorization-server" {
                // https issuer, but a cleartext token endpoint: the doc must be refused.
                return .json(#"""
                    {"issuer":"https://as.mixed.test","authorization_endpoint":"https://as.mixed.test/authorize",
                     "token_endpoint":"http://as.mixed.test/token","code_challenge_methods_supported":["S256"]}
                    """#)
            }
            return ScriptedTransport.Reply(status: 404, body: Data())
        }
        let discovery = OAuthDiscovery(transport: transport, serverURL: Self.server)
        await #expect(throws: MCPError.self) { try await discovery.discover(challenge: nil) }
        #expect(!transport.requests.contains { $0.method == "POST" })
    }

    @Test func loopbackAuthorizationServerWorks() async throws {
        let transport = ScriptedTransport { request, _ in
            let url = request.url!.absoluteString
            if url == "https://mcp.evil.test/.well-known/oauth-protected-resource/mcp" {
                return .json(#"{"resource":"https://mcp.evil.test/mcp","authorization_servers":["http://127.0.0.1:43121"]}"#)
            }
            if url == "http://127.0.0.1:43121/.well-known/oauth-authorization-server" {
                return .json(#"""
                    {"issuer":"http://127.0.0.1:43121","authorization_endpoint":"http://127.0.0.1:43121/authorize",
                     "token_endpoint":"http://127.0.0.1:43121/token","code_challenge_methods_supported":["S256"]}
                    """#)
            }
            return ScriptedTransport.Reply(status: 404, body: Data())
        }
        let discovery = OAuthDiscovery(transport: transport, serverURL: Self.server)
        let found = try await discovery.discover(challenge: nil)
        #expect(found.authServer.issuer == "http://127.0.0.1:43121")
        #expect(found.authServer.tokenEndpoint.absoluteString == "http://127.0.0.1:43121/token")
    }

    @Test func redirectedMetadataLandsMustStayAllowed() async throws {
        struct RedirectingTransport: HTTPTransport, Sendable {
            func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
                let url = request.url!.absoluteString
                let body: Data
                let final: URL?
                if url == "https://mcp.evil.test/.well-known/oauth-protected-resource/mcp" {
                    // Valid doc, but "redirected" to a cleartext host: void.
                    body = Data(#"{"resource":"https://mcp.evil.test/mcp","authorization_servers":["https://auth.evil.test"]}"#.utf8)
                    final = URL(string: "http://evil.test/landing")
                } else if url == "https://mcp.evil.test/.well-known/oauth-protected-resource" {
                    body = Data(#"{"resource":"https://mcp.evil.test/mcp","authorization_servers":["https://auth.good.test"]}"#.utf8)
                    final = nil // ScriptedTransport-style: no redirect info.
                } else if url == "https://auth.good.test/.well-known/oauth-authorization-server" {
                    body = Data(#"""
                        {"issuer":"https://auth.good.test","authorization_endpoint":"https://auth.good.test/authorize",
                         "token_endpoint":"https://auth.good.test/token","code_challenge_methods_supported":["S256"]}
                        """#.utf8)
                    final = nil
                } else {
                    return HTTPStreamResponse(head: HTTPResponseHead(status: 404, headers: [:]),
                                              body: AsyncThrowingStream { $0.finish() })
                }
                return HTTPStreamResponse(
                    head: HTTPResponseHead(status: 200, headers: ["content-type": "application/json"], url: final),
                    body: AsyncThrowingStream { $0.yield(body); $0.finish() })
            }
        }
        let discovery = OAuthDiscovery(transport: RedirectingTransport(), serverURL: Self.server)
        let found = try await discovery.discover(challenge: nil)
        #expect(found.authServer.issuer == "https://auth.good.test")
    }
}

/// Regression tests for R2-M1: a manual client secret is bound to the issuer
/// it was first used with; a server that later names another issuer gets a
/// credentials requirement, never the silent secret.
@Suite struct CHardeningManualIssuerTests {
    /// One MCP server whose protected-resource metadata names whichever AS
    /// `issuerHost` currently points at.
    final class SwitchingWorld: Sendable {
        let issuerHost = Mutex("as-a.test")
        let prmURL = "https://mcp.acme.test/.well-known/oauth-protected-resource/mcp"

        func handle(_ request: URLRequest) -> Reply {
            let url = request.url!
            let host = url.host() ?? ""
            let path = url.path()
            if host == "mcp.acme.test", path == "/mcp" {
                if request.header("Authorization") == "Bearer at-1" {
                    return (try? Fake.modern()(request, 0)) ?? Reply(status: 500, body: Data())
                }
                return Reply(status: 401, headers: [
                    "WWW-Authenticate": #"Bearer [REDACTED]"invalid_token", resource_metadata="\#(prmURL)""#,
                ], body: Data())
            }
            if url.absoluteString == prmURL {
                let issuer = "https://\(issuerHost.withLock { $0 })"
                return .json(#"{"resource":"https://mcp.acme.test/mcp","authorization_servers":["\#(issuer)"]}"#)
            }
            if path == "/.well-known/oauth-authorization-server", host.hasPrefix("as-") {
                let issuer = "https://\(host)"
                return .json(#"""
                    {"issuer":"\#(issuer)","authorization_endpoint":"\#(issuer)/authorize",
                     "token_endpoint":"\#(issuer)/token","code_challenge_methods_supported":["S256"]}
                    """#)
            }
            if path == "/token", host.hasPrefix("as-") {
                let form = request.form
                guard form["grant_type"] == "authorization_code", form["code"] == "code-1",
                      form["code_verifier"]?.isEmpty == false,
                      form["resource"] == "https://mcp.acme.test/mcp" else {
                    return .json(#"{"error":"invalid_grant"}"#, status: 400)
                }
                let want = "Basic " + Data("cid-manual:shh-secret".utf8).base64EncodedString()
                guard request.header("Authorization") == want else {
                    return .json(#"{"error":"invalid_client"}"#, status: 401)
                }
                return .json(#"{"access_token":"at-1","token_type":"Bearer"}"#)
            }
            return Reply(status: 404, body: Data())
        }

        func presenter() -> StubPresenter {
            StubPresenter { url, _ in
                let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
                let state = items.first { $0.name == "state" }?.value ?? ""
                let redirect = items.first { $0.name == "redirect_uri" }?.value ?? "praxischat://oauth/callback"
                let iss = "https://\(url.host() ?? "")".addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
                return URL(string: "\(redirect)?code=code-1&state=\(state)&iss=\(iss)")!
            }
        }
    }

    @Test func secretStaysWithItsFirstIssuer() async throws {
        let world = SwitchingWorld()
        let transport = ScriptedTransport { r, _ in world.handle(r) }
        let secrets = InMemorySecretStore(["manual-key": "shh-secret"])
        let client = makeClient(
            transport,
            config: acmeConfig(auth: .manualOAuth(clientID: "cid-manual", clientSecretKey: "manual-key")),
            secrets: secrets,
            auth: MCPAuthEnvironment(presenter: world.presenter(), loopback: nil))

        // First sign-in against issuer A: the secret goes to A's token endpoint.
        _ = try await client.listTools()
        let firstPosts = transport.requests.filter { $0.url?.path() == "/token" }
        #expect(firstPosts.count == 1)
        #expect(firstPosts.first?.url?.host() == "as-a.test")

        // The server now names issuer B. Signing in again must ask for new
        // credentials for B — never POST the old secret to B's token endpoint.
        world.issuerHost.withLock { $0 = "as-b.test" }
        await client.signOut()
        do {
            _ = try await client.listTools()
            Issue.record("expected authorizationRequired, sign-in succeeded")
        } catch let error as MCPError {
            #expect(error == .authorizationRequired(.oauthNeedsClientCredentials(issuer: "https://as-b.test")))
        }
        #expect(!transport.requests.contains { $0.url?.host() == "as-b.test" && $0.url?.path() == "/token" })
        let secretBasic = "Basic " + Data("cid-manual:shh-secret".utf8).base64EncodedString()
        let leaked = transport.requests.contains {
            $0.url?.host() == "as-b.test" && $0.headers["Authorization"] == secretBasic
        }
        #expect(!leaked)
    }
}

/// Regression tests for R2-M2: a 401 during an agent-run call on a legacy SSE
/// server throws `authorizationRequired` — it never opens the sign-in sheet.
@Suite struct CHardeningSSEInteractiveTests {
    /// Legacy SSE server whose tool-call POSTs are rejected with 401, while
    /// OAuth discovery succeeds (so an interactive recovery WOULD sign in).
    final class ExpiringSSEServer: Sendable {
        private let stream = Mutex<AsyncThrowingStream<Data, Error>.Continuation?>(nil)

        func handle(_ request: URLRequest) async throws -> HTTPStreamResponse {
            let url = request.url!
            let path = url.path()
            if request.httpMethod == "GET", path == "/sse" {
                let (body, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
                stream.withLock { $0 = continuation }
                continuation.yield(Data(": keep-alive\n\nevent: endpoint\ndata: /messages?sessionId=abc\n\n".utf8))
                return HTTPStreamResponse(head: HTTPResponseHead(status: 200, headers: ["content-type": "text/event-stream"]), body: body)
            }
            if path == "/.well-known/oauth-protected-resource/sse" {
                return LiveTransport.respond(.json(#"{"resource":"https://mcp.acme.test/sse","authorization_servers":["https://auth.sse.test"]}"#))
            }
            if url.absoluteString == "https://auth.sse.test/.well-known/oauth-authorization-server" {
                return LiveTransport.respond(.json(#"""
                    {"issuer":"https://auth.sse.test","authorization_endpoint":"https://auth.sse.test/authorize",
                     "token_endpoint":"https://auth.sse.test/token","registration_endpoint":"https://auth.sse.test/register",
                     "code_challenge_methods_supported":["S256"]}
                    """#))
            }
            guard request.httpMethod == "POST", path == "/messages" else {
                return LiveTransport.respond(Reply(status: 405, body: Data()))
            }
            if request.rpcMethod == "tools/call" {
                return LiveTransport.respond(Reply(status: 401, headers: ["WWW-Authenticate": #"Bearer [REDACTED]"invalid_token""#],
                                                   body: Data()))
            }
            if let id = request.rpc?["id"], let method = request.rpcMethod {
                let result: JSONValue
                switch method {
                case "initialize":
                    result = ["protocolVersion": "2024-11-05", "capabilities": ["tools": [:]], "serverInfo": ["name": "old", "version": "0.1"]]
                case "tools/list":
                    result = ["tools": .array([Fake.tool("old_tool")])]
                default:
                    result = [:]
                }
                _ = stream.withLock { $0?.yield(Data("event: message\ndata: \(Fake.message(id: id, result: result).encodedString())\n\n".utf8)) }
            }
            return LiveTransport.respond(Fake.accepted)
        }
    }

    @Test func expiredTokenMidRunThrowsInsteadOfPrompting() async throws {
        let server = ExpiringSSEServer()
        let transport = LiveTransport { try await server.handle($0) }
        let opened = Box<URL>()
        let presenter = StubPresenter { url, _ in
            opened.append(url)
            throw CancellationError()
        }
        let client = makeClient(transport, config: acmeConfig(auth: .oauth, url: URL(string: "https://mcp.acme.test/sse")!),
                                auth: MCPAuthEnvironment(presenter: presenter, loopback: nil))
        do {
            _ = try await client.callTool("old_tool", arguments: ["q": "x"])
            Issue.record("expected authorizationRequired, the call succeeded")
        } catch let error as MCPError {
            #expect(error == .authorizationRequired(.oauthAutomatic(issuer: "https://auth.sse.test")))
        }
        #expect(opened.all.isEmpty) // the sheet never opened mid-run
        #expect(!transport.requests.contains { $0.url.path() == "/register" })
        await client.close()
        #expect(opened.all.isEmpty) // nor while closing
    }
}

/// Regression tests for R2-M6: waiting for the legacy SSE `endpoint` event
/// ends on timeout and on cancellation — it never hangs a silent server.
@Suite struct CHardeningSSEEndpointWaitTests {
    private static func silentChannel() -> (LegacySSEChannel, HTTPStreamResponse) {
        let channel = LegacySSEChannel(
            streamURL: URL(string: "https://mcp.acme.test/sse")!,
            post: { _, _, _ in },
            serverRequest: { _, _, _ in .null },
            notification: { _, _ in })
        let body = AsyncThrowingStream<Data, Error> { _ in /* silent server: no events, never closes */ }
        let response = HTTPStreamResponse(
            head: HTTPResponseHead(status: 200, headers: ["content-type": "text/event-stream"]), body: body)
        return (channel, response)
    }

    @Test func silentServerTimesOut() async throws {
        let (channel, response) = Self.silentChannel()
        let start = Date()
        do {
            _ = try await channel.open(response, timeout: .milliseconds(100))
            Issue.record("expected a protocol violation, open succeeded")
        } catch let error as MCPError {
            #expect(error == .protocolViolation("no endpoint event from the event stream"))
        }
        #expect(Date().timeIntervalSince(start) < 10)
        await channel.close()
    }

    @Test func waitingEndsOnCancellation() async throws {
        let (channel, response) = Self.silentChannel()
        let start = Date()
        let task = Task { try await channel.open(response, timeout: .seconds(60)) }
        try await Task.sleep(for: .milliseconds(100))
        task.cancel()
        do {
            _ = try await task.value
            Issue.record("expected a throw, open succeeded")
        } catch is CancellationError {
        } catch {
            Issue.record("expected CancellationError, got \(error)")
        }
        #expect(Date().timeIntervalSince(start) < 10)
        await channel.close()
    }
}

/// Regression tests for R2-L2: server URLs with embedded credentials are
/// refused (they would persist secrets in cleartext configs).
@Suite struct CHardeningUserinfoTests {
    @Test func userinfoURLIsRefused() {
        #expect(throws: MCPInstallError.credentialsInURL) {
            _ = try MCPInstaller.parse(url: "https://user:secret@mcp.acme.test/mcp")
        }
        #expect(throws: MCPInstallError.credentialsInURL) {
            _ = try MCPInstaller.parse(url: "https://user@mcp.acme.test/mcp")
        }
    }

    @Test func userinfoEntryIsRejectedNotImported() throws {
        let result = try MCPInstaller.parse(config: #"{"mcpServers":{"evil":{"url":"https://u:p@mcp.acme.test/mcp"}}}"#)
        #expect(result.candidates.isEmpty)
        #expect(result.rejected.count == 1)
        #expect(result.rejected.first?.reason.contains("credentials") ?? false)
    }

    @Test func plainURLStillParses() throws {
        let candidate = try MCPInstaller.parse(url: "https://mcp.acme.test/mcp")
        #expect(candidate.urlTemplate == "https://mcp.acme.test/mcp")
    }
}

/// Regression tests for R2-M7: `nextCursor` paging can't stuff unbounded
/// entries/bytes into the caches.
@Suite struct CHardeningPaginationCapsTests {
    @Test func toolPagesAreCapped() async throws {
        let transport = ScriptedTransport { request, _ in
            switch request.rpcMethod {
            case "server/discover"?: return Fake.result(request, Fake.discover)
            case "tools/list"?:
                let page = Int(request.params["cursor"]?.stringValue?.dropFirst() ?? "0") ?? 0
                let tools = (0..<200).map { Fake.tool("tool_\(page * 200 + $0)") }
                return Fake.result(request, ["tools": .array(tools), "nextCursor": .string("p\(page + 1)")])
            default: return Fake.error(request, code: -32601, message: "nope")
            }
        }
        let client = makeClient(transport)
        let tools = try await client.listTools()
        #expect(tools.count == 500)
        #expect(await client.toolListTruncated)
        #expect(transport.requests.filter { $0.rpcMethod == "tools/list" }.count == 3) // stops paging early
    }

    @Test func promptPagesAreCapped() async throws {
        let transport = ScriptedTransport { request, _ in
            switch request.rpcMethod {
            case "server/discover"?: return Fake.result(request, Fake.discover)
            case "prompts/list"?:
                let page = Int(request.params["cursor"]?.stringValue?.dropFirst() ?? "0") ?? 0
                let prompts = (0..<50).map { JSONValue.object(["name": .string("prompt_\(page * 50 + $0)")]) }
                return Fake.result(request, ["prompts": .array(prompts), "nextCursor": .string("p\(page + 1)")])
            default: return Fake.error(request, code: -32601, message: "nope")
            }
        }
        let client = makeClient(transport)
        let prompts = try await client.listPrompts()
        #expect(prompts.count == 200)
        #expect(await client.promptListTruncated)
    }

    @Test func hugeSchemasAreCappedByBytes() async throws {
        let big = String(repeating: "x", count: 600_000)
        let transport = ScriptedTransport { request, _ in
            switch request.rpcMethod {
            case "server/discover"?: return Fake.result(request, Fake.discover)
            case "tools/list"?:
                let tools = (0..<10).map { Fake.tool("big_\($0)", schema: ["type": "object", "description": .string(big)]) }
                return Fake.result(request, ["tools": .array(tools)])
            default: return Fake.error(request, code: -32601, message: "nope")
            }
        }
        let client = makeClient(transport)
        let tools = try await client.listTools()
        #expect(tools.count < 10) // 10 × ~600KB would be ~6MB; the cap is 4MB
        #expect(await client.toolListTruncated)
    }

    @Test func smallListingsAreNotTruncated() async throws {
        let transport = ScriptedTransport { request, _ in
            switch request.rpcMethod {
            case "server/discover"?: return Fake.result(request, Fake.discover)
            case "tools/list"?: return Fake.result(request, ["tools": [Fake.tool("a"), Fake.tool("b")]])
            case "prompts/list"?: return Fake.result(request, ["prompts": [["name": "p"]]])
            default: return Fake.error(request, code: -32601, message: "nope")
            }
        }
        let client = makeClient(transport)
        #expect(try await client.listTools().count == 2)
        #expect(try await client.listPrompts().count == 1)
        #expect(await !client.toolListTruncated)
        #expect(await !client.promptListTruncated)
    }
}
