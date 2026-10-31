import XCTest
import AgentCore
import Synchronization
@testable import PraxisChat

@MainActor
final class CloudReplicaTests: XCTestCase {
    private func root() -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root
    }
    func testSyncPageAndCursorCommitAtomicallyAndTombstonesPersist() throws {
        let file = root().appendingPathComponent("replica.json")
        var replica = CloudCursorReplica()
        let page = try JSONDecoder().decode(CloudCursorReplica.Page.self, from: Data(#"{"cursor":"4","nextCursor":null,"entities":[{"key":"chat:a","deleted":false,"value":{"id":"a","title":"Cached","updatedAt":"2026-10-30T00:00:00Z"}}]}"#.utf8))
        try replica.apply(page, file: file)
        let loaded = try CloudCursorReplica.load(file)
        XCTAssertEqual(loaded.cursor, "4")
        XCTAssertEqual(try loaded.rows("chat", as: CloudRemoteChat.self).first?.title, "Cached")
        let tombstone = try JSONDecoder().decode(CloudCursorReplica.Page.self, from: Data(#"{"cursor":"5","nextCursor":null,"entities":[{"key":"chat:a","deleted":true,"value":null}]}"#.utf8))
        try replica.apply(tombstone, file: file)
        XCTAssertTrue(try CloudCursorReplica.load(file).values.isEmpty)
        XCTAssertEqual(replica.cursor, "5")
    }
    func testCorruptNewAccountCacheCannotLeaveOldChatsVisible() throws {
        let root = root()
        let client = try cloudNetClient { _ in CloudNetReply("{}") }
        let store = ChatStore(conversations: [Conversation(title: "Previous account secret")])
        let controller = CloudAccountReplica(store: store, client: client, root: root)
        let directory = CloudReplicaScope.directory(root: root, origin: client.configuration.origin, userID: "new")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("corrupted".utf8).write(to: directory.appendingPathComponent("replica.json"))
        controller.sessionChanged(CloudUser(id: "new", name: "New", email: nil))
        XCTAssertTrue(store.conversations.isEmpty)
        XCTAssertNil(controller.userID)
        XCTAssertNotNil(controller.error)
    }

    func testAccountSwitchSignOutAndLocalFirstCredentialIsolation() async throws {
        let directory = root()
        let networkCalls = Mutex(0)
        let client = try cloudNetClient { request in
            networkCalls.withLock { $0 += 1 }
            if request.url!.path == "/v1/sync/root" { return CloudNetReply(#"{"cursor":"1"}"#) }
            let user = request.value(forHTTPHeaderField: "Authorization") == "Bearer B" ? "B" : "A"
            return CloudNetReply("{\"cursor\":\"1\",\"nextCursor\":null,\"entities\":[{\"key\":\"chat:\(user)\",\"deleted\":false,\"value\":{\"id\":\"\(user)\",\"title\":\"Account \(user)\",\"updatedAt\":\"2026-10-30T00:00:00Z\"}}]}")
        }
        let store = ChatStore(conversations: [])
        let controller = CloudAccountReplica(store: store, client: client, root: directory)
        controller.foreground()
        await controller.waitForSync()
        XCTAssertEqual(networkCalls.withLock { $0 }, 0, "Foreground must not race initial local restoration")
        try await client.tokens.setToken("A", for: client.configuration.origin)
        controller.sessionChanged(CloudUser(id: "A", name: "A", email: nil))
        await controller.waitForSync()
        XCTAssertTrue(store.conversations.contains { $0.title == "Account A" })
        controller.sessionChanged(nil)
        XCTAssertTrue(store.conversations.isEmpty)
        try await client.tokens.setToken("B", for: client.configuration.origin)
        let next = CloudAccountReplica(store: store, client: client, root: directory)
        await next.restoreBeforeNetwork()
        XCTAssertTrue(store.conversations.isEmpty, "A's cache cannot paint with B's token")
        next.sessionChanged(CloudUser(id: "B", name: "B", email: nil))
        XCTAssertFalse(store.conversations.contains { $0.title == "Account A" })
        await next.waitForSync()
        XCTAssertTrue(store.conversations.contains { $0.title == "Account B" })
        let restoredStore = ChatStore(conversations: [])
        let restored = CloudAccountReplica(store: restoredStore, client: client, root: directory)
        let before = networkCalls.withLock { $0 }
        await restored.restoreBeforeNetwork()
        XCTAssertTrue(restoredStore.conversations.contains { $0.title == "Account B" })
        XCTAssertEqual(before, networkCalls.withLock { $0 }, "Cached paint must precede network reconciliation")
        next.sessionChanged(nil); restored.sessionChanged(nil)
    }

    func testSignOutSupersedesAnInFlightForegroundSessionCheck() async throws {
        let requested = expectation(description: "foreground session requested")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let client = try cloudNetClient { request in
            switch request.url!.path {
            case "/v1/auth/session":
                requested.fulfill()
                _ = release.wait(timeout: .now() + 5)
                return CloudNetReply(#"{"user":{"id":"A","name":"A"},"expiresAt":"2027-01-01T00:00:00Z"}"#)
            case "/v1/sync/root": return CloudNetReply(#"{"cursor":"0"}"#)
            default: return CloudNetReply(#"{"cursor":"0","nextCursor":null,"entities":[]}"#)
            }
        }
        let store = ChatStore(conversations: [])
        let controller = CloudAccountReplica(store: store, client: client, root: root())
        controller.sessionChanged(CloudUser(id: "A", name: "A", email: nil))
        await controller.waitForSync()
        controller.foreground()
        await fulfillment(of: [requested], timeout: 5)
        controller.sessionChanged(nil)
        release.signal()
        await controller.waitForSync()
        XCTAssertNil(controller.userID)
        XCTAssertTrue(store.conversations.isEmpty)
    }
}

extension CloudReplicaTests {
    func testSyncedMessagePreservesToolTranscriptAndExistingLocalProjection() throws {
        var replica = CloudCursorReplica()
        let id = UUID()
        let body = """
        {"cursor":"1","nextCursor":null,"entities":[
        {"key":"chat:chat","deleted":false,"value":{"id":"chat","title":"Chat","updatedAt":"2026-10-30T00:00:00Z"}},
        {"key":"message:m","deleted":false,"value":{"id":"m","chatId":"chat","clientTurnId":"\(id)","createdAt":"2026-10-30T00:00:00Z","role":"assistant","parts":[{"type":"toolCall","callId":"call","name":"echo","arguments":"{}"}]}}
        ]}
        """
        let page = try JSONDecoder().decode(CloudCursorReplica.Page.self, from: Data(body.utf8))
        try replica.apply(page, file: root().appendingPathComponent("replica.json"))
        let rows = try replica.rows("message", as: CloudSyncedMessage.self)
        XCTAssertEqual(rows.first?.native.toolCalls.first?.name, "echo")
        let original = Turn(id: id, userText: "User", blocks: [.markdown(id: UUID(), source: "Rich local result", isStreaming: false)],
                            isFinished: true, outcome: .completed, transcript: [rows[0].native], engine: .cloud)
        let conv = Conversation(title: "Local", turns: [original], cloudChatID: "chat")
        let store = ChatStore(conversations: [conv])
        try store.applyCloudReplica(replica)
        XCTAssertEqual(conv.turns.first?.blocks, original.blocks)
    }
}
