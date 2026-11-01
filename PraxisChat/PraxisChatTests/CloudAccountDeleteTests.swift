import XCTest
@testable import PraxisChat

@MainActor
final class CloudAccountDeleteTests: XCTestCase {
    private func signedInStore() async throws -> (ChatStore, CloudTestBackend, URL, URL) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        let backend = CloudTestBackend()
        addTeardownBlock { backend.shutdown() }
        let client = CloudAPIClient(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
        let store = ChatStore.makeCloudStore(client: client, replicaRoot: root)
        await store.prepareCloudSession(); await store.cloudReplica?.waitForSync()
        let scope = CloudReplicaScope.directory(root: root, origin: client.configuration.origin, userID: "stub-user")
        try FileManager.default.createDirectory(at: scope.appendingPathComponent("Runs"), withIntermediateDirectories: true)
        try Data("journal".utf8).write(to: scope.appendingPathComponent("Runs/secret"))
        return (store, backend, root, scope)
    }

    func testDeleteAccountSendsConfirmationThenWipesLocalAccountData() async throws {
        let (store, backend, root, scope) = try await signedInStore()
        let services = try XCTUnwrap(store.cloudServices)
        let attachment = UUID()
        store.attachmentStore.stage(Data("photo".utf8), id: attachment)
        let recordings = root.appendingPathComponent("Recordings")
        try FileManager.default.createDirectory(at: recordings, withIntermediateDirectories: true)
        try Data("audio".utf8).write(to: recordings.appendingPathComponent("voice.m4a"))

        try await services.deleteAccount(password: "hunter2")
        await store.cloudReplica?.waitForSync()

        let request = try XCTUnwrap(backend.recordedRequests().last { $0.path == "/v1/account" })
        XCTAssertEqual(request.method, "DELETE")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: String])
        XCTAssertEqual(body, ["type": "account.delete", "password": "hunter2"])
        XCTAssertFalse(services.isSignedIn)
        XCTAssertTrue(services.accountDeleted)
        let token = try await services.client.tokens.token(for: services.client.configuration.origin)
        XCTAssertNil(token)
        XCTAssertFalse(FileManager.default.fileExists(atPath: scope.path), "replica and journals are wiped")
        XCTAssertFalse(FileManager.default.fileExists(atPath: recordings.path))
        XCTAssertFalse(store.attachmentStore.contains(attachment))
        XCTAssertTrue(store.conversations.allSatisfy { $0.cloudChatID == nil })
    }

    func testDeleteAccountFailureSurfacesServerMessageAndKeepsAccount() async throws {
        let (store, _, _, scope) = try await signedInStore()
        let services = try XCTUnwrap(store.cloudServices)
        do {
            try await services.deleteAccount(password: "wrong")
            XCTFail("A rejected confirmation must throw")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Confirm your current password or sign in again")
        }
        XCTAssertTrue(services.isSignedIn)
        XCTAssertFalse(services.accountDeleted)
        XCTAssertTrue(FileManager.default.fileExists(atPath: scope.path))
    }
}
