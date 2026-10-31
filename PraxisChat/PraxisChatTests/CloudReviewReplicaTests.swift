import XCTest
import AgentCore
import Synchronization
@testable import PraxisChat

@MainActor
final class CloudReviewReplicaTests: XCTestCase {
    private func root() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func page(_ rows: [[String: Any]], cursor: String = "1") throws -> CloudCursorReplica.Page {
        let entities = rows.enumerated().map { i, row in ["key": "\(row["kind"]!):\(row["id"]!)", "deleted": false, "value": row] as [String: Any] }
        return try JSONDecoder().decode(CloudCursorReplica.Page.self, from: JSONSerialization.data(withJSONObject: ["cursor": cursor, "entities": entities]))
    }
    private var chat: [String: Any] { ["kind": "chat", "id": "chat", "title": "Remote", "updatedAt": "2026-10-30T00:00:00Z"] }
    func testSignedOutNewChatDoesNotWriteNativeHistory() async throws {
        let defaults = UserDefaults.standard
        let keys = ["PraxisCloudStub", "PraxisEngine", "PraxisNativeLoopEnabled", "PraxisResetData", "PraxisCloudServerURL"]
        let previous = keys.map { defaults.object(forKey: $0) }
        defer { for (key, value) in zip(keys, previous) { defaults.set(value, forKey: key) } }
        defaults.set("cloud", forKey: "PraxisEngine"); defaults.set(false, forKey: "PraxisNativeLoopEnabled")
        defaults.set(false, forKey: "PraxisResetData"); defaults.set(true, forKey: "PraxisCloudStub")
        defaults.set("https://cloud.praxis.test", forKey: "PraxisCloudServerURL")
        let file = AppDirectories.conversations.appendingPathComponent("index.json")
        let original = try? Data(contentsOf: file)
        defer { if let original { try? original.write(to: file) } else { try? FileManager.default.removeItem(at: file) } }
        let native = ConversationStore(directory: AppDirectories.conversations)
        native.saveIndex(.init(conversations: [.init(id: UUID(), title: "Frozen native history", updatedAt: Date(), isPinned: false)]))
        await native.flush()
        let before = try Data(contentsOf: file)
        let store = ChatStore.forLaunch(); store.newChat()
        await store.settle(); await native.flush()
        XCTAssertEqual(try Data(contentsOf: file), before)
    }
    func testFinishedLocalTurnNeverRestartsFromStaleRemoteRunningRow() async throws {
        let turn = Turn(userText: "Finished", blocks: [.markdown(id: UUID(), source: "Local rich answer", isStreaming: false)], isFinished: true, outcome: .completed, engine: .cloud)
        let conversation = Conversation(title: "Remote", turns: [turn], cloudChatID: "chat")
        let store = ChatStore(conversations: [conversation])
        let calls = Mutex(0)
        let client = try cloudNetClient { _ in calls.withLock { $0 += 1 }; return CloudNetReply("{}") }
        let engine = CloudLifecycleEngine(client: client, journal: CloudRunJournal(directory: root()), elicitations: ElicitationCenter())
        var replica = CloudCursorReplica()
        try replica.apply(page([["kind": "run", "id": "run", "chatId": "chat", "status": "running", "lastEventId": 1, "clientTurnId": turn.id.uuidString]]), file: root().appendingPathComponent("replica.json"))
        try await store.resumeCloudRuns(replica, engine: engine)
        XCTAssertFalse(store.isRunning(conversation.id))
        XCTAssertEqual(conversation.turns.first?.blocks, turn.blocks)
        XCTAssertEqual(calls.withLock { $0 }, 0)
        store.clearCloudReplica()
    }
    func testChatTombstoneClearsBackgroundStateAndPendingApproval() async throws {
        let backend = CloudTestBackend(scenario: .approval); defer { backend.shutdown() }
        let client = CloudAPIClient(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
        let conversation = Conversation(title: "Remote")
        let store = ChatStore(engine: CloudChatEngine(client: client), conversations: [conversation])
        store.send(text: "Ask permission")
        await waitUntil { !store.approvals.pendingIDs.isEmpty }
        conversation.cloudChatID = "chat"
        XCTAssertNotNil(store.background.states[conversation.id])
        try store.applyCloudReplica(CloudCursorReplica())
        XCTAssertNil(store.background.states[conversation.id])
        XCTAssertTrue(store.approvals.pendingIDs.isEmpty)
        XCTAssertTrue(store.conversations.isEmpty)
        store.clearCloudReplica()
    }
    func testMalformedRowCannotBlockValidRowsOrLaterSyncPages() throws {
        var replica = CloudCursorReplica()
        let file = root().appendingPathComponent("replica.json")
        try replica.apply(page([chat, ["kind": "chat", "id": "bad", "title": NSNull()]]), file: file)
        XCTAssertEqual(try replica.rows("chat", as: CloudRemoteChat.self).map(\.id), ["chat"])
        try replica.apply(page([["kind": "chat", "id": "next", "title": "Next", "updatedAt": "2026-10-30T00:00:00Z"]], cursor: "2"), file: file)
        XCTAssertEqual(Set(try replica.rows("chat", as: CloudRemoteChat.self).map(\.id)), ["chat", "next"])
        XCTAssertEqual(replica.cursor, "2")
        let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        XCTAssertNotNil((saved?["quarantine"] as? [String: Any])?["chat:bad"])
    }
    func testExplicitSignOutRemovesCachedChatsAndJournals() async throws {
        let directory = root()
        let backend = CloudTestBackend(); defer { backend.shutdown() }
        let client = CloudAPIClient(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
        let store = ChatStore.makeCloudStore(client: client, replicaRoot: directory)
        await store.prepareCloudSession(); await store.cloudReplica?.waitForSync()
        let scope = CloudReplicaScope.directory(root: directory, origin: client.configuration.origin, userID: "stub-user")
        try FileManager.default.createDirectory(at: scope.appendingPathComponent("Runs"), withIntermediateDirectories: true)
        try Data("private".utf8).write(to: scope.appendingPathComponent("Runs/secret"))
        try await store.cloudServices?.signOut()
        await store.cloudReplica?.waitForSync()
        XCTAssertFalse(FileManager.default.fileExists(atPath: scope.path))
    }
    func testUnchangedReplicaDoesNotRewriteEveryConversation() async throws {
        let directory = root()
        let disk = ConversationStore(directory: directory)
        let store = ChatStore(conversations: [], persistence: disk)
        var replica = CloudCursorReplica()
        try replica.apply(page([chat]), file: root().appendingPathComponent("replica.json"))
        try store.applyCloudReplica(replica)
        await disk.flush()
        let id = try XCTUnwrap(store.conversations.first?.id)
        let file = directory.appendingPathComponent(id.uuidString + ".json")
        let first = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
        try await Task.sleep(for: .milliseconds(30))
        try store.applyCloudReplica(replica)
        await disk.flush()
        let second = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate] as? Date
        XCTAssertEqual(first, second)
    }
    func testRemoteTurnsMergeChronologicallyIntoPartialCache() throws {
        let late = Turn(userText: "Late", isFinished: true, outcome: .completed, engine: .cloud)
        let conversation = Conversation(title: "Remote", turns: [late], cloudChatID: "chat")
        let early = UUID()
        var replica = CloudCursorReplica()
        let rows: [[String: Any]] = [chat,
            ["kind": "message", "id": "early", "chatId": "chat", "clientTurnId": early.uuidString, "role": "user", "parts": [["type": "text", "text": "Early"]], "createdAt": "2026-10-29T00:00:00Z"],
            ["kind": "message", "id": "late", "chatId": "chat", "clientTurnId": late.id.uuidString, "role": "user", "parts": [["type": "text", "text": "Late"]], "createdAt": "2026-10-30T00:00:00Z"]]
        try replica.apply(page(rows), file: root().appendingPathComponent("replica.json"))
        try ChatStore(conversations: [conversation]).applyCloudReplica(replica)
        XCTAssertEqual(conversation.turns.map(\.id), [early, late.id])
    }
}
