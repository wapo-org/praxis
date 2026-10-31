import XCTest
import AgentCore
import Synchronization
@testable import PraxisChat

private actor HeldApproval: ApprovalHandler {
    private var continuation: CheckedContinuation<ApprovalDecision, Never>?
    private(set) var waiting = false
    func decide(_ request: ApprovalRequest) async -> ApprovalDecision {
        waiting = true
        return await withCheckedContinuation { continuation = $0 }
    }
    func release() { continuation?.resume(returning: .deny); continuation = nil }
}

@MainActor
final class CloudReviewLifecycleTests: XCTestCase {
    private func root() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func client(_ backend: CloudTestBackend) throws -> CloudAPIClient {
        .init(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
    }
    private func request() -> ChatRunRequest {
        .init(conversationID: UUID(), history: [], userText: "Recover", mode: .auto, effort: .high, modelID: "stub-model", webSearch: false, attachments: [], policy: ToolPolicy(), approvals: AutoApprove(), setup: nil, compaction: nil, contextMeasurement: nil)
    }
    private func seed(_ req: ChatRunRequest, journal: CloudRunJournal, client: CloudAPIClient) async {
        let engine = CloudChatEngine(client: client, onRunStarted: { conversation, turn, run in
            try? await journal.register(.init(conversationID: conversation, turnID: turn, runID: run))
        }, onEvent: { _, _, run, data in try await journal.append(data, runID: run) })
        for await _ in engine.run(req) {}
    }
    func testBackgroundBeginReplaysDurablePrefixOnFirstForeground() async throws {
        let backend = CloudTestBackend(); defer { backend.shutdown() }
        let api = try client(backend), req = request(), journal = CloudRunJournal(directory: root())
        await seed(req, journal: journal, client: api)
        let engine = CloudLifecycleEngine(client: api, journal: journal, elicitations: ElicitationCenter(), backgrounded: true)
        let done = expectation(description: "journal replay completes")
        var turn = Turn(userText: req.userText), reducer = TurnReducer()
        let reader = Task { for await event in engine.run(req) { _ = reducer.reduce(event, into: &turn, at: Date()) }; done.fulfill() }
        try await Task.sleep(for: .milliseconds(30))
        await engine.setBackgrounded(false)
        await fulfillment(of: [done], timeout: 5)
        reader.cancel()
        XCTAssertEqual(turn.outcome, .completed)
        XCTAssertEqual(turn.transcript.filter { $0.role == .assistant }.map(\.text).joined(), "Cloud reply: Recover 🌍")
    }
    func testForegroundDrainCannotReattachAfterAnotherBackgroundTransition() async throws {
        let backend = CloudTestBackend(scenario: .approval); defer { backend.shutdown() }
        let api = try client(backend)
        let engine = CloudLifecycleEngine(client: api, journal: CloudRunJournal(directory: root()), elicitations: ElicitationCenter())
        let held = HeldApproval()
        var req = request(); req.approvals = held
        let reader = Task { for await _ in engine.run(req) {} }
        for _ in 0..<500 { if await held.waiting { break }; try await Task.sleep(for: .milliseconds(10)) }
        let waiting = await held.waiting
        XCTAssertTrue(waiting)
        await engine.setBackgrounded(true)
        let before = backend.recordedRequests().filter { $0.path.hasSuffix("/events") }.count
        let foreground = Task { await engine.setBackgrounded(false) }
        try await Task.sleep(for: .milliseconds(50))
        await engine.setBackgrounded(true)
        await held.release()
        await foreground.value
        try await Task.sleep(for: .milliseconds(120))
        XCTAssertEqual(backend.recordedRequests().filter { $0.path.hasSuffix("/events") }.count, before)
        reader.cancel(); await engine.detachAll()
    }
    func testOfflineForegroundRestoresJournalBeforeRetryingSession() async throws {
        let backend = CloudTestBackend(); defer { backend.shutdown() }
        let req = request(), base = root()
        let attempts = Mutex(0)
        let api = try cloudNetClient { request in
            if request.url!.path == "/v1/auth/session" { attempts.withLock { $0 += 1 }; return CloudNetReply(#"{"code":"offline","message":"Retry later"}"#, status: 503) }
            if request.url!.path == "/v1/sync/root" { return CloudNetReply(#"{"cursor":"0"}"#) }
            return CloudNetReply(#"{"cursor":"0","entities":[],"nextCursor":null}"#)
        }
        let directory = CloudReplicaScope.directory(root: base, origin: api.configuration.origin, userID: "user")
        let journal = CloudRunJournal(directory: directory)
        await seed(req, journal: journal, client: try client(backend))
        let turn = Turn(id: req.turnID, userText: req.userText, isRunning: true, engine: .cloud)
        let conversation = Conversation(id: req.conversationID, title: "Recover", turns: [turn])
        let disk = ConversationStore(directory: directory.appendingPathComponent("Conversations"))
        disk.save(conversation.record)
        disk.saveIndex(.init(conversations: [.init(id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, isPinned: false)]))
        await disk.flush()
        let store = ChatStore(conversations: [])
        let controller = CloudAccountReplica(store: store, client: api, root: base)
        controller.background(); controller.sessionChanged(.init(id: "user", name: "User", email: nil))
        await controller.waitForSync()
        controller.foreground()
        await waitUntil(timeout: 3) { store.conversations.first?.turns.first?.isFinished == true }
        XCTAssertEqual(store.conversations.first?.turns.first?.transcript.filter { $0.role == .assistant }.map(\.text).joined(), "Cloud reply: Recover 🌍")
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertGreaterThanOrEqual(attempts.withLock { $0 }, 2)
        controller.sessionChanged(nil)
    }
    func testRepeatedCursorExpirationHasBoundedSnapshotRecovery() async throws {
        let snapshots = Mutex(0)
        let api = try cloudNetClient { request in
            if request.url!.path.hasSuffix("/snapshot") {
                let count = snapshots.withLock { $0 += 1; return $0 }
                if count > 3 { return CloudNetReply(#"{"code":"test_stop","message":"Stop runaway recovery"}"#, status: 503) }
                return CloudNetReply(#"{"run":{"id":"run","chatId":"chat","status":"running","lastEventId":1},"lastEventId":1,"blocks":[],"tools":[],"pendingApprovals":[],"pendingElicitations":[],"messages":[]}"#)
            }
            return CloudNetReply(#"{"code":"cursor_expired","message":"Expired"}"#, status: 409)
        }
        var req = request(); req.cloudChatID = "chat"
        var turn = Turn(userText: req.userText), reducer = TurnReducer()
        for await event in CloudChatEngine(client: api).resume(request: req, runID: "run", cursor: 1) { _ = reducer.reduce(event, into: &turn, at: Date()) }
        XCTAssertLessThanOrEqual(snapshots.withLock { $0 }, 2)
        guard case .failed = turn.outcome else { return XCTFail("Recovery limit must fail visibly") }
    }
    func testJournalReportsDuplicateAsNotAcceptedForPresentation() async throws {
        let journal = CloudRunJournal(directory: root())
        let bytes = Data(#"{"type":"run.event","id":1,"runId":"run","event":{"type":"text.delta","blockId":"b","text":"once"}}"#.utf8)
        let first: Any = try await journal.append(bytes, runID: "run")
        let duplicate: Any = try await journal.append(bytes, runID: "run")
        XCTAssertEqual(first as? Bool, true)
        XCTAssertEqual(duplicate as? Bool, false)
    }
}
