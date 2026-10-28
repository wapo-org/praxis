import XCTest
import AgentCore
@testable import PraxisChat

/// One JSON file per conversation plus an index, written at commit
/// points; demo threads seeded only on first launch.
@MainActor
final class PersistenceTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = temporaryDirectory()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testFirstLaunchSeedsAndWrites() async throws {
        let persistence = ConversationStore(directory: directory)
        XCTAssertNil(persistence.load(), "nothing on disk yet")
        let store = ChatStore(engine: DemoAgentEngine(timeScale: 0), persistence: persistence)
        let seeded = store.conversations.map(\.id)
        XCTAssertFalse(seeded.isEmpty)
        await store.settle()

        let snapshot = try XCTUnwrap(persistence.load())
        XCTAssertEqual(snapshot.conversations.map(\.id), seeded)
        XCTAssertEqual(snapshot.conversations.first?.turns.count, store.conversations.first?.turns.count)
    }

    func testRelaunchLoadsInsteadOfSeeding() async throws {
        let first = ChatStore(engine: DemoAgentEngine(timeScale: 0), persistence: ConversationStore(directory: directory))
        first.newChat()
        first.send(text: "Add haptics to buttons")
        await waitUntil { !first.isRunning }
        let sentID = try XCTUnwrap(first.selectedID)
        first.deleteConversations([first.conversations.last!.id])
        await first.settle()

        let second = ChatStore(engine: DemoAgentEngine(timeScale: 0), persistence: ConversationStore(directory: directory))
        XCTAssertEqual(second.conversations.map(\.id), first.conversations.map(\.id))
        let reloaded = try XCTUnwrap(second.conversations.first { $0.id == sentID })
        XCTAssertEqual(reloaded.turns.count, 1)
        let turn = reloaded.turns[0]
        XCTAssertEqual(turn.outcome, .completed)
        let original = try XCTUnwrap(first.conversations.first { $0.id == sentID }?.turns[0])
        XCTAssertEqual(turn.markdownSources, original.markdownSources)
        XCTAssertEqual(turn.activities.map(\.steps), original.activities.map(\.steps))
        XCTAssertEqual(turn.transcript, original.transcript)
        XCTAssertFalse(turn.transcript.isEmpty, "the transcript survives for the next request")
    }

    func testRecordRoundTripsThroughJSON() throws {
        var command = CommandData(code: "ls", language: "bash", lines: ["a", "b"], exitCode: 0)
        command.droppedLineCount = 3
        command.startedAt = Date(timeIntervalSinceReferenceDate: 5)
        var activity = ActivityData(isRunning: false, elapsed: 4)
        activity.steps = [
            Step(toolCallID: "c1", kind: .command, runningSummary: "Running", finalSummary: "Ran", command: command),
            Step(toolCallID: "c2", kind: .integration, runningSummary: "Merging", finalSummary: "Merged",
                 status: .denied, traces: [Trace(kind: .api, text: "PUT /merge")]),
        ]
        var turn = Turn(userText: "hi", attachments: [Attachment(kind: .file, name: "notes.txt")],
                        blocks: [.activity(activity), .markdown(id: UUID(), source: "**Done**", isStreaming: false)],
                        isFinished: true, outcome: .refused("policy"), modelID: "atlas")
        turn.transcript = [.user("hi"), Message(role: .assistant, parts: [.text("Done")])]
        let record = ConversationRecord(id: UUID(), title: "T", updatedAt: Date(timeIntervalSinceReferenceDate: 9),
                                        isPinned: true, turns: [turn])
        let data = try JSONEncoder().encode(record)
        XCTAssertEqual(try JSONDecoder().decode(ConversationRecord.self, from: data), record)
    }

    func testRecordSavedMidRunSettlesOnRelaunch() {
        var activity = ActivityData(isRunning: true, isExpanded: true)
        activity.steps = [Step(toolCallID: "a", kind: .readFile, runningSummary: "", finalSummary: "",
                               status: .awaitingApproval,
                               approval: PendingApproval(requestID: "a", title: "", reason: "", toolName: "",
                                                         arguments: "{}"))]
        let turn = Turn(userText: "x", blocks: [.activity(activity),
                                                .markdown(id: UUID(), source: "", isStreaming: true)],
                        isRunning: true)
        let settled = ConversationRecord(id: UUID(), title: "", updatedAt: Date(), isPinned: false, turns: [turn])
            .settledAfterRelaunch().turns[0]
        XCTAssertFalse(settled.isRunning)
        XCTAssertEqual(settled.outcome, .stopped)
        XCTAssertEqual(settled.blocks.count, 1, "empty streaming block dropped")
        XCTAssertEqual(settled.activities[0].steps[0].status, .cancelled)
        XCTAssertNil(settled.activities[0].steps[0].approval)
        XCTAssertTrue(settled.activities[0].isStopped)
    }

    func testFlushWaitsForWritesEnqueuedWhileDraining() async {
        // Saves still arriving while flush runs must land before it
        // returns: tearDown deletes the directory next.
        let persistence = ConversationStore(directory: directory.appendingPathComponent("Conversations"))
        let records = (0..<10).map { _ in ConversationRecord(id: UUID(), title: "T", updatedAt: Date(), isPinned: false, turns: []) }
        persistence.save(records[0])
        Task.detached {
            for record in records.dropFirst() {
                try? await Task.sleep(for: .milliseconds(2))
                persistence.save(record)
            }
        }
        await persistence.flush()
        for record in records {
            XCTAssertTrue(FileManager.default.fileExists(atPath: persistence.fileURL(for: record.id).path))
        }
    }

    func testWriteToAnUnusableDirectoryDoesNotCrash() async throws {
        // A queued write racing a deleted directory used to hit
        // assertionFailure in Debug and kill the test host. Pointing the
        // store somewhere no directory can exist reproduces the failure
        // deterministically: the write must be dropped, not crash.
        let blocker = directory.appendingPathComponent("blocker")
        try "x".write(to: blocker, atomically: true, encoding: .utf8)
        let persistence = ConversationStore(directory: blocker.appendingPathComponent("Conversations"))
        persistence.save(ConversationRecord(id: UUID(), title: "T", updatedAt: Date(), isPinned: false, turns: []))
        await persistence.flush()
        XCTAssertNil(persistence.load())
    }

    func testAttachmentBytesLiveOnDisk() async throws {
        let attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))
        let id = UUID()
        attachments.stage(Data([1, 2, 3]), id: id)
        XCTAssertEqual(attachments.data(for: id), Data([1, 2, 3]))
        attachments.persist([id])
        await waitUntil { FileManager.default.fileExists(atPath: attachments.url(for: id).path) }
        XCTAssertEqual(try Data(contentsOf: attachments.url(for: id)), Data([1, 2, 3]))
        attachments.remove([id])
        XCTAssertNil(attachments.data(for: id))
    }
}
