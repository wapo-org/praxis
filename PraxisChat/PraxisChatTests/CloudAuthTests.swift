import XCTest
@testable import PraxisChat

@MainActor
final class CloudAuthTests: XCTestCase {
    func testCanonicalOriginNormalizesHostAndDefaultPort() throws {
        let a = try CloudServerConfiguration(baseURL: URL(string: "https://EXAMPLE.com:443/")!)
        let b = try CloudServerConfiguration(baseURL: URL(string: "https://example.com")!)
        XCTAssertEqual(a, b)
        XCTAssertEqual(a.origin, "https://example.com")
    }
    func testRejectsInsecureCredentialBearingAndNonOriginURLs() {
        for raw in ["http://example.com", "ftp://example.com", "https://user:pass@example.com", "https://example.com/v1", "https://example.com?q=x", "https://example.com/#fragment"] {
            XCTAssertThrowsError(try CloudServerConfiguration(baseURL: URL(string: raw)!))
        }
    }
    func testDebugLoopbackAllowsLocalAPI() throws {
        #if DEBUG
        XCTAssertNoThrow(try CloudServerConfiguration(baseURL: URL(string: "http://127.0.0.1:8808")!))
        #endif
    }
    func testDebugOverrideUsesExplicitConfiguration() throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set("https://override.test", forKey: "PraxisCloudServerURL")
        #if DEBUG
        XCTAssertEqual(try CloudServerConfiguration.forLaunch(defaults: defaults).origin, "https://override.test")
        #endif
    }
    func testTokensAreIsolatedByOriginIncludingPort() async throws {
        let store = CloudSessionStore(inMemory: true)
        try await store.setToken("one", for: "https://one.test")
        try await store.setToken("two", for: "https://one.test:444")
        let one = try await store.token(for: "https://one.test")
        let two = try await store.token(for: "https://one.test:444")
        let other = try await store.token(for: "https://two.test")
        XCTAssertEqual(one, "one"); XCTAssertEqual(two, "two"); XCTAssertNil(other)
        try await store.setToken(nil, for: "https://one.test")
        let cleared = try await store.token(for: "https://one.test")
        XCTAssertNil(cleared)
    }
    func testSignInPersistsOnlyBearerAndSessionReadUsesIt() async throws {
        let client = try cloudNetClient { request in
            if request.url!.path == "/v1/auth/sign-in" {
                return CloudNetReply(#"{"type":"session","user":{"type":"user","id":"u","name":"User"},"expiresAt":"2027-01-01T00:00:00Z","bearerToken":"session-token"}"#)
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session-token")
            return CloudNetReply(#"{"type":"session","user":{"id":"u","name":"User"},"expiresAt":"2027-01-01T00:00:00Z"}"#)
        }
        let signedIn = try await client.signIn(email: "test@example.com", password: "test-password")
        let session = try await client.currentSession()
        XCTAssertEqual(signedIn.user.id, "u"); XCTAssertNil(session.bearerToken)
        let token = try await client.tokens.token(for: client.configuration.origin)
        XCTAssertEqual(token, "session-token")
    }
    func testMissingTokenDoesNotReplaceStoredSession() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(#"{"user":{"id":"u","name":"User"},"expiresAt":"later"}"#) }
        try await client.tokens.setToken("existing", for: client.configuration.origin)
        do { _ = try await client.signIn(email: "a@b.test", password: "password"); XCTFail("expected token error") }
        catch CloudSessionError.missingToken {}
        let token = try await client.tokens.token(for: client.configuration.origin)
        XCTAssertEqual(token, "existing")
    }
    func testSignOutRevokesThenClearsOnlyCurrentOrigin() async throws {
        let client = try cloudNetClient { request in
            XCTAssertEqual(request.url!.path, "/v1/auth/sign-out")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer current")
            return CloudNetReply(#"{"type":"ok"}"#)
        }
        try await client.tokens.setToken("current", for: client.configuration.origin)
        try await client.tokens.setToken("other", for: "https://other.test")
        try await client.signOut()
        let token = try await client.tokens.token(for: client.configuration.origin)
        let other = try await client.tokens.token(for: "https://other.test")
        XCTAssertNil(token); XCTAssertEqual(other, "other")
    }
    func testFailedSignOutKeepsTokenForRetry() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(#"{"code":"unavailable","message":"Retry"}"#, status: 503) }
        try await client.tokens.setToken("current", for: client.configuration.origin)
        do { try await client.signOut(); XCTFail("expected failure") } catch {}
        let token = try await client.tokens.token(for: client.configuration.origin)
        XCTAssertEqual(token, "current")
    }
    func testKeychainPersistsSessionAcrossStoreInstancesWithoutOriginLeak() async throws {
        let service = "com.praxis.chat.cloud-session.test." + UUID().uuidString
        let first = CloudSessionStore(service: service)
        let second = CloudSessionStore(service: service)
        try await first.setToken("test-session", for: "https://session.test")
        let restored = try await second.token(for: "https://session.test")
        let otherOrigin = try await second.token(for: "https://other-session.test")
        try await second.setToken(nil, for: "https://session.test")
        XCTAssertEqual(restored, "test-session")
        XCTAssertNil(otherOrigin)
        let deleted = try await first.token(for: "https://session.test")
        XCTAssertNil(deleted)
    }
    func testDefaultCloudAndNativeOptInSelection() {
        for hasProvider in [false, true] {
            XCTAssertEqual(EngineKind.resolve(override: nil, hasProvider: hasProvider, nativeLoopEnabled: false), .cloud)
            XCTAssertEqual(EngineKind.resolve(override: .live, hasProvider: hasProvider, nativeLoopEnabled: false), .cloud)
        }
        XCTAssertEqual(EngineKind.resolve(override: .live, hasProvider: false, nativeLoopEnabled: true), .live)
        XCTAssertEqual(EngineKind.resolve(override: .demo, hasProvider: true, nativeLoopEnabled: true), .demo)
        XCTAssertEqual(EngineKind.resolve(override: .scripted, hasProvider: false, nativeLoopEnabled: false), .scripted)
        XCTAssertEqual(EngineKind.resolve(override: .cloud, hasProvider: true, nativeLoopEnabled: true), .cloud)
    }
}
