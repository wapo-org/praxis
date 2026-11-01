import XCTest
import AgentCore
@testable import PraxisChat

/// R3-M2: conversations, the index, attachments and sidecars are written
/// with Data Protection (complete-until-first-unlock), like the other app
/// files; R3-M4: a persist racing a remove can't resurrect the file.
@MainActor
final class DataProtectionAppTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = temporaryDirectory()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: R3-M2 — Data Protection
    //
    // Pinned at the source level: the simulator doesn't record protection
    // attributes (verified: files written with the option read back nil
    // there, while the same API records them in a macOS-native probe),
    // so attribute assertions can't observe the fix. Every `.atomic`
    // write in the stores must carry the protection class instead, and
    // the directories get the matching class. Confirm the attributes on
    // a real device.

    private func persistenceSource(_ name: String) throws -> String {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("PraxisChat/Persistence/\(name)", isDirectory: false)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func assertDataProtection(in source: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(source.contains(".completeFileProtectionUntilFirstUserAuthentication"),
                      "writes carry the protection class", file: file, line: line)
        XCTAssertFalse(source.contains("options: .atomic)"),
                       "no bare .atomic write without the protection class", file: file, line: line)
        XCTAssertTrue(source.contains("FileProtectionType.completeUntilFirstUserAuthentication"),
                      "the directory gets the matching class", file: file, line: line)
    }

    func testConversationStoreWritesCarryDataProtection() throws {
        try assertDataProtection(in: persistenceSource("ConversationStore.swift"))
    }

    func testAttachmentStoreWritesCarryDataProtection() throws {
        try assertDataProtection(in: persistenceSource("AttachmentStore.swift"))
    }

    /// Review fix F5: cached part transcripts are user content, protected
    /// like the audio they came from.
    func testPartCacheWritesCarryDataProtection() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("PraxisChat/Services/Voice/AudioSegmenter.swift", isDirectory: false)
        try assertDataProtection(in: String(contentsOf: url, encoding: .utf8))
    }

    // MARK: R3-M4 — persist/remove race

    func testPersistRacingRemoveCannotResurrectTheFile() async throws {
        let attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))
        let id = UUID()
        attachments.stage(Data([1, 2, 3]), id: id)
        attachments.persist([id])
        attachments.remove([id])
        // remove() is a barrier: everything queued before it has landed
        // (and been deleted). Poll past the window where a detached
        // writer used to resurrect the file.
        for _ in 0..<20 {
            XCTAssertFalse(FileManager.default.fileExists(atPath: attachments.url(for: id).path), "no resurrection")
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertNil(attachments.data(for: id))
        XCTAssertFalse(attachments.contains(id))
    }

    func testRepeatedPersistRemoveCyclesLeaveNothingBehind() async throws {
        let attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))
        let id = UUID()
        for byte in 0..<20 {
            attachments.stage(Data([UInt8(byte)]), id: id)
            attachments.persist([id])
            attachments.remove([id])
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: attachments.url(for: id).path))
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(FileManager.default.fileExists(atPath: attachments.url(for: id).path),
                       "no late write resurrects the file")
        XCTAssertFalse(attachments.contains(id))

        // And the store still works after the churn.
        attachments.stage(Data([42]), id: id)
        attachments.persist([id])
        await waitUntil { FileManager.default.fileExists(atPath: attachments.url(for: id).path) }
        XCTAssertEqual(try Data(contentsOf: attachments.url(for: id)), Data([42]))
    }
}
