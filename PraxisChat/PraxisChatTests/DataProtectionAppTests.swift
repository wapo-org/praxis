import XCTest
import AgentCore
@testable import PraxisChat

/// Verifies Data Protection writes and that persist/remove races never resurrect deleted files.
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
    // Checks protection flags in source because iOS Simulator ignores file protection attributes.

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

    /// Part transcript caches contain user content and must carry the same Data Protection class.
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
        // Polls past the old async writer window to confirm remove() acts as a deletion barrier.
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

        attachments.stage(Data([42]), id: id)
        attachments.persist([id])
        await waitUntil { FileManager.default.fileExists(atPath: attachments.url(for: id).path) }
        XCTAssertEqual(try Data(contentsOf: attachments.url(for: id)), Data([42]))
    }
}
