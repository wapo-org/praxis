import XCTest
import AgentCore
import Synchronization
@testable import PraxisChat

@MainActor
final class CloudC5RegressionTests: XCTestCase {
    private func root() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func replica(_ directory: URL) throws -> CloudCursorReplica {
        let json = #"{"cursor":"0","entities":[{"key":"chat:chat","deleted":false,"value":{"id":"chat","title":"Remote","updatedAt":"2026-10-30T00:00:00Z"}},{"key":"message:user","deleted":false,"value":{"id":"user","chatId":"chat","runId":"web-run","clientTurnId":"web-turn","role":"user","parts":[{"type":"text","text":"Web prompt"}],"createdAt":"2026-10-30T00:00:00Z"}},{"key":"run:web-run","deleted":false,"value":{"id":"web-run","chatId":"chat","clientTurnId":"web-turn","status":"running","lastEventId":0}}]}"#
        var replica = CloudCursorReplica()
        try replica.apply(JSONDecoder().decode(CloudCursorReplica.Page.self, from: Data(json.utf8)), file: directory.appendingPathComponent("replica.json"))
        return replica
    }
    private func save(_ conv: Conversation, to disk: ConversationStore) async {
        disk.save(conv.record)
        disk.saveIndex(.init(conversations: [.init(id: conv.id, title: conv.title, updatedAt: conv.updatedAt, isPinned: false)]))
        await disk.flush()
    }
    func testRemoteProjectionKeepsRunIdentityAndSettlesAuthoritativeTerminal() async throws {
        let directory = root(), projection = try replica(directory)
        let store = ChatStore(conversations: [])
        try store.applyCloudReplica(projection)
        let conv = try XCTUnwrap(store.conversations.first)
        XCTAssertEqual(conv.turns.first?.cloudRunID, "web-run")
        let client = try cloudNetClient { _ in CloudNetReply(#"{"id":"web-run","chatId":"chat","clientTurnId":"web-turn","status":"completed","lastEventId":10}"#) }
        let engine = CloudLifecycleEngine(client: client, journal: CloudRunJournal(directory: directory), elicitations: ElicitationCenter())
        try await store.resumeCloudRuns(try projection.rows("run", as: CloudRun.self), engine: engine, client: client)
        XCTAssertEqual(conv.turns.first?.isFinished, true)
        XCTAssertEqual(conv.turns.first?.outcome, .completed)
    }
    func testOfflineRemoteTurnRelaunchNeverPostsAnotherRun() async throws {
        let directory = root(), projection = try replica(directory)
        let starts = Mutex(0)
        let client = try cloudNetClient { request in
            switch request.url!.path {
            case "/v1/runs/web-run": return CloudNetReply(#"{"code":"offline","message":"Offline"}"#, status: 503)
            case "/v1/chats/chat": return CloudNetReply(#"{"id":"chat"}"#)
            case "/v1/runs": starts.withLock { $0 += 1 }; return CloudNetReply(#"{"id":"duplicate","chatId":"chat","status":"running","lastEventId":0}"#)
            default: return CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"run.finished","outcome":"completed"}"#, run: request.url!.path.contains("web-run") ? "web-run" : "duplicate")])
            }
        }
        let disk = ConversationStore(directory: directory.appendingPathComponent("Conversations"))
        let engine = CloudLifecycleEngine(client: client, journal: CloudRunJournal(directory: directory), elicitations: ElicitationCenter())
        let store = ChatStore(conversations: [], persistence: disk)
        try store.applyCloudReplica(projection)
        do { try await store.resumeCloudRuns(try projection.rows("run", as: CloudRun.self), engine: engine, client: client) } catch { }
        let conv = try XCTUnwrap(store.conversations.first)
        await save(conv, to: disk)
        let relaunched = ChatStore(conversations: [])
        relaunched.installCloudPersistence(disk, engine: engine)
        await waitUntil { relaunched.conversations.first?.turns.first?.isFinished == true }
        XCTAssertEqual(starts.withLock { $0 }, 0, "A web prompt must never be re-sent by the phone")
        relaunched.clearCloudReplica(); await engine.detachAll()
    }
    func testPageOneChangesSurvivePageTwoFailureAndForegroundRetry() async throws {
        let base = root()
        let calls = Mutex(0)
        let first = #"{"cursor":"1","nextCursor":"2","entities":[{"key":"chat:chat","deleted":false,"value":{"id":"chat","title":"Changed on web","updatedAt":"2026-10-31T00:00:00Z"}}]}"#
        let client = try cloudNetClient { request in
            switch request.url!.path {
            case "/v1/auth/session": return CloudNetReply(#"{"user":{"id":"u","name":"U"},"expiresAt":"2030-01-01T00:00:00Z"}"#)
            case "/v1/sync/root": return CloudNetReply(#"{"cursor":"2"}"#)
            case "/v1/sync/pull":
                let call = calls.withLock { $0 += 1; return $0 }
                if call == 1 { return CloudNetReply(first) }
                if call == 2 { return CloudNetReply(#"{"code":"offline","message":"Lost page two"}"#, status: 503) }
                return CloudNetReply(#"{"cursor":"2","entities":[],"nextCursor":null}"#)
            default: return CloudNetReply(#"{"code":"not_found","message":"No stream fixture"}"#, status: 404)
            }
        }
        let directory = CloudReplicaScope.directory(root: base, origin: client.configuration.origin, userID: "u")
        let initial = try replica(directory)
        // No pending run is needed for the changed-chat regression.
        var cache = initial; cache.values = cache.values.filter { $0.key.hasPrefix("chat:") }
        try JSONEncoder().encode(cache).write(to: directory.appendingPathComponent("replica.json"))
        let disk = ConversationStore(directory: directory.appendingPathComponent("Conversations"))
        let conv = Conversation(id: CloudReplicaScope.localID("chat"), title: "Remote", cloudChatID: "chat")
        await save(conv, to: disk)
        let store = ChatStore(conversations: [])
        let controller = CloudAccountReplica(store: store, client: client, root: base)
        controller.sessionChanged(.init(id: "u", name: "U", email: nil)); await controller.waitForSync()
        XCTAssertNotNil(controller.error)
        controller.foreground(); await controller.waitForSync()
        XCTAssertEqual(store.conversations.first?.title, "Changed on web")
        controller.sessionChanged(nil); await controller.waitForSync()
    }
    func testSignOutBeforeCachedAccountLoadsErasesMediaAndCachedScope() async throws {
        let base = root(), client = try cloudNetClient { _ in CloudNetReply("{}") }
        let scope = CloudReplicaScope.directory(root: base, origin: client.configuration.origin, userID: "cached-a")
        let identity = base.appendingPathComponent("Cloud/" + CloudReplicaScope.digest(client.configuration.origin) + ".identity")
        try FileManager.default.createDirectory(at: scope, withIntermediateDirectories: true)
        try Data(#"{"userID":"cached-a","tokenHash":"unused"}"#.utf8).write(to: identity)
        try Data("secret".utf8).write(to: scope.appendingPathComponent("private"))
        let attachments = AttachmentStore(directory: base.appendingPathComponent("Attachments"))
        let attachment = UUID(); attachments.stage(Data("photo".utf8), id: attachment); attachments.persist([attachment])
        _ = attachments.data(for: attachment)
        let recordings = base.appendingPathComponent("Recordings")
        try FileManager.default.createDirectory(at: recordings, withIntermediateDirectories: true)
        try Data("audio".utf8).write(to: recordings.appendingPathComponent("voice.m4a"))
        let store = ChatStore(conversations: [], attachments: attachments)
        let controller = CloudAccountReplica(store: store, client: client, root: base)
        controller.sessionChanged(nil); await controller.waitForSync()
        XCTAssertFalse(FileManager.default.fileExists(atPath: scope.path))
        XCTAssertFalse(attachments.contains(attachment)); XCTAssertNil(attachments.data(for: attachment))
        XCTAssertFalse(FileManager.default.fileExists(atPath: recordings.path))
    }
    func testAnAppUpdateRetriesPreviouslyQuarantinedDecodableRows() throws {
        let directory = root(); try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("replica.json")
        try Data(#"{"cursor":"12","values":{},"quarantineBuildVersion":"old-build","quarantine":{"chat:recovered":{"id":"recovered","title":"Readable now","updatedAt":"2026-10-31T00:00:00Z"}}}"#.utf8).write(to: file)
        let replica = try CloudCursorReplica.load(file)
        XCTAssertEqual(try replica.rows("chat", as: CloudRemoteChat.self).map(\.id), ["recovered"])
        XCTAssertEqual(replica.cursor, "12"); XCTAssertTrue(replica.quarantine?.isEmpty ?? true)
    }
    func testBackgroundDuringReplayDoesNotDeliverAnyDeltaTwice() async throws {
        let client = try cloudNetClient { _ in XCTFail("Completed journal must not touch network"); return CloudNetReply("{}") }
        let journal = CloudRunJournal(directory: root())
        let req = ChatRunRequest(conversationID: UUID(), history: [], userText: "Replay", mode: .auto, effort: .high, modelID: "m", webSearch: false, attachments: [], policy: ToolPolicy(), approvals: AutoApprove(), setup: nil, compaction: nil, contextMeasurement: nil)
        try await journal.register(.init(conversationID: req.conversationID, turnID: req.turnID, runID: "run"))
        for id in 1...100 {
            let payload = id == 100 ? #"{"type":"run.finished","outcome":"completed"}"# : #"{"type":"text.delta","blockId":"b","text":"x"}"#
            let raw = "{\"type\":\"run.event\",\"id\":\(id),\"runId\":\"run\",\"chatId\":\"chat\",\"createdAt\":\"2026-10-31T00:00:00Z\",\"event\":\(payload)}"
            try await journal.append(Data(raw.utf8), runID: "run")
        }
        let engine = CloudLifecycleEngine(client: client, journal: journal, elicitations: ElicitationCenter())
        var text = "", toggled = false
        for await event in engine.run(req) {
            if case .textDelta(_, let delta) = event {
                text += delta
                if !toggled { toggled = true; await engine.setBackgrounded(true); await engine.setBackgrounded(false) }
            }
        }
        XCTAssertTrue(toggled); XCTAssertEqual(text, String(repeating: "x", count: 99))
    }
}
