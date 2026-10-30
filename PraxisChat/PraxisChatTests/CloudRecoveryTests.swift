import XCTest
import Synchronization
import AgentCore
@testable import PraxisChat

@MainActor
final class CloudRecoveryTests: XCTestCase {
    private func request() -> ChatRunRequest {
        ChatRunRequest(conversationID: UUID(), history: [], userText: "Recover", mode: .auto, effort: .high,
                       modelID: "stub-model", webSearch: false, attachments: [], policy: ToolPolicy(), approvals: AutoApprove(),
                       setup: nil, compaction: nil, contextMeasurement: nil)
    }
    func testCancelDuringStreamFiftyCyclesNeverDeadlocks() async throws {
        let backend = CloudTestBackend(scenario: .cancel)
        defer { backend.shutdown() }
        let client = CloudAPIClient(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
        let done = expectation(description: "50 cancellations")
        let worker = Task {
            for _ in 0..<50 {
                let flag = RunCancelFlag()
                var request = request(); request.isCancelled = { flag.isCancelled }
                let (arrivals, signal) = AsyncStream<Void>.makeStream()
                let engine = CloudChatEngine(client: client, onCursor: { _, _, _, _ in signal.yield(()) })
                let stream = engine.run(request)
                let reader = Task { for await _ in stream { if Task.isCancelled { break } } }
                for await _ in arrivals { break }
                flag.cancel(); reader.cancel(); signal.finish()
                await reader.value
            }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 30)
        worker.cancel()
    }
    func testCursorExpiredReplacesProjectionAndResumesAfterSnapshot() async throws {
        let backend = CloudTestBackend(scenario: .cursorExpired)
        defer { backend.shutdown() }
        let client = CloudAPIClient(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
        let request = request()
        let runID = Mutex<String?>(nil)
        // Create using the real production start path so fixture identities match.
        var reducer = TurnReducer()
        var turn = Turn(userText: request.userText)
        let done = expectation(description: "snapshot recovery finishes")
        let task = Task {
            let first = CloudChatEngine(client: client, onRunStarted: { _, _, id in runID.withLock { $0 = id } })
            for await _ in first.run(request) {}
            guard let id = runID.withLock({ $0 }) else { done.fulfill(); return }
            for await event in CloudChatEngine(client: client).resume(request: request, runID: id, cursor: 1) {
                _ = reducer.reduce(event, into: &turn, at: Date())
            }
            done.fulfill()
        }
        await fulfillment(of: [done], timeout: 10)
        task.cancel()
        XCTAssertTrue(turn.isFinished)
        XCTAssertEqual(turn.outcome, .completed)
        XCTAssertEqual(turn.transcript.filter { $0.role == .user }.count, 1)
    }
}

extension CloudRecoveryTests {
    func testBackgroundDetachCatchesUpFromJournalWithoutCancelOrDuplicateText() async throws {
        let backend = CloudTestBackend(scenario: .reconnect, chunkDelay: 0.01)
        defer { backend.shutdown() }
        let client = CloudAPIClient(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let journal = CloudRunJournal(directory: root)
        let engine = CloudLifecycleEngine(client: client, journal: journal, elicitations: ElicitationCenter())
        let firstText = expectation(description: "text before background")
        let done = expectation(description: "foreground catches up")
        var signalled = false
        var reducer = TurnReducer()
        var turn = Turn(userText: "Recover")
        let reader = Task {
            for await event in engine.run(request()) {
                if case .textDelta = event, !signalled { signalled = true; firstText.fulfill() }
                _ = reducer.reduce(event, into: &turn, at: Date())
            }
            done.fulfill()
        }
        await fulfillment(of: [firstText], timeout: 10)
        await engine.setBackgrounded(true)
        XCTAssertFalse(backend.recordedRequests().contains { $0.path.hasSuffix("/cancel") })
        try await Task.sleep(for: .milliseconds(150))
        await engine.setBackgrounded(false)
        await fulfillment(of: [done], timeout: 15)
        reader.cancel()
        XCTAssertEqual(turn.outcome, .completed)
        let answers = turn.transcript.filter { $0.role == .assistant }.map(\.text).joined()
        XCTAssertEqual(answers, "Cloud reconnect: one 🌍 answer, no duplicate text.")
        XCTAssertTrue(backend.recordedRequests().contains { $0.lastEventID != nil })
        let records = await journal.records()
        let id = try XCTUnwrap(records.first?.runID)
        let replay = await journal.replay(runID: id)
        let ids = try replay.events.map { try JSONDecoder().decode(CloudRunEvent.self, from: $0).id }
        XCTAssertEqual(ids, Array(Set(ids)).sorted())
        XCTAssertEqual(ids, Array(1...ids.count))
    }
}

extension CloudRecoveryTests {
    func testJournalSnapshotCheckpointSurvivesRelaunchWithLaterEvents() async throws {
        let backend = CloudTestBackend(scenario: .text)
        defer { backend.shutdown() }
        let client = CloudAPIClient(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
        let id = Mutex<String?>(nil)
        let first = CloudChatEngine(client: client, onRunStarted: { _, _, value in id.withLock { $0 = value } })
        let req = request()
        for await _ in first.run(req) {}
        let runID = try XCTUnwrap(id.withLock { $0 })
        let raw = try await client.jsonData("/v1/runs/\(runID)/snapshot")
        let snapshot = try JSONDecoder().decode(CloudRunSnapshot.self, from: raw)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let journal = CloudRunJournal(directory: root)
        try await journal.checkpoint(raw, runID: runID)
        let restored = await CloudRunJournal(directory: root).replay(runID: runID)
        XCTAssertEqual(restored.cursor, snapshot.lastEventId)
        XCTAssertEqual(restored.snapshot, raw)
        XCTAssertTrue(restored.events.isEmpty)
        XCTAssertTrue(snapshot.isTerminal)
        XCTAssertTrue(snapshot.pendingEvents.isEmpty)
        var turn = Turn(userText: req.userText)
        var reducer = TurnReducer()
        let mapper = CloudEventMapper(request: req)
        for payload in try snapshot.presentationEvents() {
            for event in await mapper.map(payload) { _ = reducer.reduce(event, into: &turn, at: Date()) }
        }
        XCTAssertEqual(turn.outcome, .completed)
        XCTAssertFalse(turn.transcript.isEmpty)
        try await journal.remove(runID: runID)
        let empty = await journal.replay(runID: runID)
        XCTAssertNil(empty.snapshot)
        XCTAssertEqual(empty.cursor, 0)
    }
}

extension CloudRecoveryTests {
    func testParkedApprovalRestoresAfterBackgroundWithoutAccidentalDenial() async throws {
        let backend = CloudTestBackend(scenario: .approval)
        defer { backend.shutdown() }
        let client = CloudAPIClient(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let engine = CloudLifecycleEngine(client: client, journal: CloudRunJournal(directory: root), elicitations: ElicitationCenter())
        let center = ApprovalCenter()
        var req = request(); req.approvals = center
        let done = expectation(description: "restored approval completes")
        let reader = Task { for await _ in engine.run(req) {}; done.fulfill() }
        await waitUntil { !center.pendingIDs.isEmpty }
        await engine.setBackgrounded(true)
        await engine.setBackgrounded(false)
        await waitUntil { !center.pendingIDs.isEmpty }
        let id = try XCTUnwrap(center.pendingIDs.first)
        center.resolve(id, with: .allowOnce)
        await fulfillment(of: [done], timeout: 10)
        reader.cancel()
        let decisions = backend.recordedRequests().filter { $0.path.hasSuffix("/approvals") }
        XCTAssertEqual(decisions.count, 1)
        XCTAssertTrue(String(decoding: try XCTUnwrap(decisions.first?.body), as: UTF8.self).contains("allowOnce"))
    }
}
