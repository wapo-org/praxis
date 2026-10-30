import Foundation
import XCTest
@testable import PraxisChat

final class CloudRunJournalTests: XCTestCase, @unchecked Sendable {
    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("CloudJournal-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    private func event(_ id: Int, runID: String = "run") -> Data {
        Data("{\n\"type\":\"run.event\",\"id\":\(id),\"runId\":\"\(runID)\",\"future\":{\"value\":42},\"event\":{\"type\":\"future.event\"}}".utf8)
    }

    func testReplayPreservesOriginalBytesAndDeduplicatesAcceptedIDs() async throws {
        let root = try temporaryDirectory()
        let journal = CloudRunJournal(directory: root)
        try await journal.append(event(1), runID: "run")
        try await journal.append(event(1), runID: "run")
        try await journal.append(event(3), runID: "run")
        let replay = await CloudRunJournal(directory: root).replay(runID: "run")
        XCTAssertEqual(replay.events, [event(1), event(3)])
        XCTAssertEqual(replay.cursor, 3)
    }

    func testPartialLastWriteIsIgnoredAndRepairedBeforeAppending() async throws {
        let root = try temporaryDirectory()
        let journal = CloudRunJournal(directory: root)
        try await journal.append(event(1), runID: "run")
        let file = root.appendingPathComponent("Runs").appendingPathComponent(CloudReplicaScope.digest("run")).appendingPathExtension("ndjson")
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("{\"data\":\"partial".utf8))
        try handle.close()
        let restored = CloudRunJournal(directory: root)
        let before = await restored.replay(runID: "run")
        XCTAssertEqual(before.cursor, 1)
        try await restored.append(event(2), runID: "run")
        let after = await restored.replay(runID: "run")
        XCTAssertEqual(after.events, [event(1), event(2)])
        XCTAssertEqual(after.cursor, 2)
    }

    func testCorruptionStopsCursorBeforeGap() async throws {
        let root = try temporaryDirectory()
        let journal = CloudRunJournal(directory: root)
        try await journal.append(event(1), runID: "run")
        let file = root.appendingPathComponent("Runs").appendingPathComponent(CloudReplicaScope.digest("run")).appendingPathExtension("ndjson")
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("invalid record\n".utf8))
        try handle.close()
        let restored = CloudRunJournal(directory: root)
        let replay = await restored.replay(runID: "run")
        XCTAssertEqual(replay.cursor, 1)
        XCTAssertEqual(replay.events.count, 1)
    }

    func testJournalMetadataRecoversRunAfterRelaunchAndRemovesAfterCommit() async throws {
        let root = try temporaryDirectory()
        let record = CloudRunJournal.Record(conversationID: UUID(), turnID: UUID(), runID: "run")
        let journal = CloudRunJournal(directory: root)
        try await journal.register(record)
        try await journal.append(event(1), runID: "run")
        let restored = CloudRunJournal(directory: root)
        let records = await restored.records()
        XCTAssertEqual(records, [record])
        try await restored.remove(runID: "run")
        let removed = await restored.records()
        let replay = await restored.replay(runID: "run")
        XCTAssertTrue(removed.isEmpty)
        XCTAssertEqual(replay.cursor, 0)
    }

    func testJournalRejectsCrossRunAndUnsafeCursor() async throws {
        let journal = CloudRunJournal(directory: try temporaryDirectory())
        do { try await journal.append(event(1, runID: "other"), runID: "run"); XCTFail("Accepted wrong run") } catch {}
        do { try await journal.append(event(9_007_199_254_740_992), runID: "run"); XCTFail("Accepted unsafe cursor") } catch {}
        let replay = await journal.replay(runID: "run")
        XCTAssertEqual(replay.cursor, 0)
    }

    func testScopeAndOpaqueResourceIdentityAreStableAndIsolated() throws {
        let root = try temporaryDirectory()
        let first = CloudReplicaScope.directory(root: root, origin: "https://one.example", userID: "a")
        XCTAssertEqual(first, CloudReplicaScope.directory(root: root, origin: "https://one.example", userID: "a"))
        XCTAssertNotEqual(first, CloudReplicaScope.directory(root: root, origin: "https://two.example", userID: "a"))
        XCTAssertNotEqual(first, CloudReplicaScope.directory(root: root, origin: "https://one.example", userID: "b"))
        XCTAssertEqual(CloudReplicaScope.localID("welcome"), CloudReplicaScope.localID("welcome"))
        XCTAssertNotEqual(CloudReplicaScope.localID("welcome"), CloudReplicaScope.localID("different"))
        let uuid = UUID()
        XCTAssertEqual(CloudReplicaScope.localID(uuid.uuidString), uuid)
    }
}
