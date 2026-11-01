import XCTest
import Synchronization
import AuthenticationServices
@testable import PraxisChat

@MainActor
final class CloudOAuthFlowTests: XCTestCase {
    private let connected = #"{"type":"connector","id":"remote","name":"Remote","url":"https://mcp.example.test","transport":"streamableHttp","enabled":true,"trusted":false,"disabledTools":[],"authStatus":"connected","updatedAt":"2026-10-30T00:00:00Z"}"#

    private func run(_ present: @escaping @Sendable (URL, String) async throws -> URL) async throws -> (CloudServices, [String]) {
        let paths = Mutex<[String]>([])
        let connected = connected
        let client = try cloudNetClient { request in
            paths.withLock { $0.append(request.url!.path) }
            if request.url!.path.hasSuffix("/oauth/start") {
                XCTAssertEqual(request.httpMethod, "POST")
                var bytes = request.httpBody ?? Data()
                if bytes.isEmpty, let stream = request.httpBodyStream {
                    stream.open(); defer { stream.close() }
                    var buffer = [UInt8](repeating: 0, count: 1024)
                    while stream.hasBytesAvailable {
                        let count = stream.read(&buffer, maxLength: buffer.count)
                        guard count > 0 else { break }; bytes.append(contentsOf: buffer.prefix(count))
                    }
                }
                let body = try JSONSerialization.jsonObject(with: bytes) as? [String: String]
                XCTAssertEqual(body?["returnUrl"], "praxis-app://oauth/callback")
                return CloudNetReply(#"{"type":"oauth.authorization","url":"https://login.example.test/authorize","state":"issued"}"#)
            }
            return CloudNetReply(connected)
        }
        let services = CloudServices(client: client)
        try await services.signInToConnector("remote", authorizer: CloudOAuthAuthorizer(present: present))
        return (services, paths.withLock { $0 })
    }

    func testSuccessStartsViaAPIUsesAppSchemeAndConfirmsConnector() async throws {
        let (services, paths) = try await run { url, scheme in
            XCTAssertEqual(url.host, "login.example.test")
            XCTAssertEqual(scheme, "praxis-app")
            return URL(string: "praxis-app://oauth/callback?state=issued")!
        }
        XCTAssertEqual(paths, ["/v1/connectors/remote/oauth/start", "/v1/connectors/remote"])
        XCTAssertEqual(services.connectors.first?.authStatus, "connected")
    }
    func testCancellationPropagatesWithoutReportingSuccess() async {
        do {
            _ = try await run { _, _ in throw ASWebAuthenticationSessionError(.canceledLogin) }
            XCTFail("Cancelled browser authentication must not succeed")
        } catch { XCTAssertEqual((error as NSError).code, ASWebAuthenticationSessionError.Code.canceledLogin.rawValue) }
    }
    func testErrorCallbackDoesNotConfirmConnector() async {
        do {
            _ = try await run { _, _ in URL(string: "praxis-app://oauth/callback?state=issued&error=access_denied")! }
            XCTFail("OAuth denial must not succeed")
        } catch { XCTAssertTrue(error is CloudSettingsError) }
    }
    func testOAuthStartHTTPErrorNeverPresentsBrowser() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(#"{"code":"oauth_unavailable","message":"Not configured"}"#, status: 503) }
        let services = CloudServices(client: client)
        do {
            try await services.signInToConnector("remote", authorizer: CloudOAuthAuthorizer { _, _ in
                XCTFail("Browser cannot open after failed OAuth start")
                throw CancellationError()
            })
            XCTFail("Unavailable server must fail")
        } catch { XCTAssertEqual((error as? CloudAPIError)?.statusCode, 503) }
        XCTAssertTrue(services.connectors.isEmpty)
    }
    func testLocalSignInPersistsActualServerBearerAndSelectsUser() async throws {
        let backend = CloudTestBackend(); defer { backend.shutdown() }
        let client = CloudAPIClient(configuration: try .init(baseURL: URL(string: "http://127.0.0.1:8807")!), session: backend.makeSession(), tokens: .init(inMemory: true))
        let services = CloudServices(client: client)
        XCTAssertTrue(services.canSignInLocally)
        try await services.signInLocally()
        XCTAssertEqual(services.account?.id, "stub-user")
        let token = try await client.tokens.token(for: client.configuration.origin)
        XCTAssertEqual(token, CloudTestBackend.token)
        XCTAssertNil(services.lastError)
        XCTAssertEqual(backend.recordedRequests().first?.path, "/v1/auth/dev")
    }
    func testLocalSignInWithoutBearerFailsBeforeSelectingAccount() async throws {
        let transport = try cloudNetClient { _ in
            CloudNetReply(#"{"user":{"id":"local-user","name":"Local"},"expiresAt":"2027-01-01T00:00:00Z"}"#)
        }
        let client = CloudAPIClient(configuration: try .init(baseURL: URL(string: "http://127.0.0.1:8807")!), session: transport.session, tokens: .init(inMemory: true))
        let services = CloudServices(client: client)
        do { try await services.signInLocally(); XCTFail("Missing token must fail") }
        catch { XCTAssertTrue(error is CloudSessionError) }
        XCTAssertNil(services.account)
        let token = try await client.tokens.token(for: client.configuration.origin)
        XCTAssertNil(token)
    }
    func testRemoteServerNeverOffersDevelopmentSignIn() async throws {
        let client = try cloudNetClient { _ in XCTFail("No request permitted"); return CloudNetReply("{}") }
        let services = CloudServices(client: client)
        XCTAssertFalse(services.canSignInLocally)
        do { try await services.signInLocally(); XCTFail("Remote server cannot use local authentication") }
        catch { XCTAssertTrue(error is CloudAPIError) }
    }
    func testSignOutClearsTheConstructedAccountReplica() async throws {
        let backend = CloudTestBackend(); defer { backend.shutdown() }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let client = CloudAPIClient(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
        let store = ChatStore.makeCloudStore(client: client, replicaRoot: root)
        await store.prepareCloudSession()
        await store.cloudReplica?.waitForSync()
        XCTAssertNotNil(store.cloudReplica?.userID)
        store.newChat()
        XCTAssertFalse(store.conversations.isEmpty)
        try await store.cloudServices?.signOut()
        XCTAssertTrue(store.conversations.isEmpty)
        XCTAssertNil(store.selectedID)
        XCTAssertNil(store.cloudReplica?.userID)
        XCTAssertNil(store.cloudReplica?.lifecycle)
    }
}
