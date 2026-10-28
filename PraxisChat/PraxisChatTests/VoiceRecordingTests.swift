import XCTest
@testable import PraxisChat

/// The crash-safety contract (VOICE_PLAN.md §2): audio streams straight to
/// disk, the JSON sidecar describes it, and `scan()` recovers everything
/// unfinished — including orphan audio — on the next launch.
@MainActor
final class VoiceRecordingTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = temporaryDirectory().appendingPathComponent("Recordings", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory.deletingLastPathComponent())
    }

    private var store: RecordingStore { RecordingStore(directory: directory) }

    private func seed(state: VoiceRecordingState, withAudio: Bool = true,
                      createdAt: Date = Date()) -> VoiceRecording {
        var recording = VoiceRecording(conversationID: UUID(), createdAt: createdAt)
        recording.state = state
        recording.duration = 42
        XCTAssertTrue(store.save(recording))
        if withAudio {
            FileManager.default.createFile(atPath: store.audioURL(for: recording).path,
                                           contents: Data([0x00, 0x01, 0x02, 0x03]))
        }
        return recording
    }

    func testSidecarRoundTrip() throws {
        var recording = VoiceRecording(conversationID: UUID())
        recording.state = .paused
        recording.duration = 95.5
        recording.transcriptPreview = "hello there"
        XCTAssertTrue(store.save(recording))
        let loaded = try XCTUnwrap(store.load(id: recording.id))
        XCTAssertEqual(loaded.id, recording.id)
        XCTAssertEqual(loaded.conversationID, recording.conversationID)
        XCTAssertEqual(loaded.state, recording.state)
        XCTAssertEqual(loaded.createdAt.timeIntervalSince1970,
                       recording.createdAt.timeIntervalSince1970, accuracy: 1)
        XCTAssertEqual(loaded.duration, recording.duration)
        XCTAssertEqual(loaded.fileName, recording.fileName)
        XCTAssertEqual(loaded.transcriptPreview, recording.transcriptPreview)
    }

    func testScanFindsUnfinishedButNotTranscribed() {
        let unfinished: [VoiceRecordingState] = [.recording, .paused, .stopped, .queued, .failed]
        let ids = Set(unfinished.map { seed(state: $0).id })
        let done = seed(state: .transcribed)
        let found = store.scan()
        XCTAssertEqual(Set(found.map(\.id)), ids)
        XCTAssertFalse(found.map(\.id).contains(done.id))
    }

    func testScanNormalizesStaleRecordingToPaused() {
        // A kill mid-recording: no recorder is alive at scan time, so the
        // stale `.recording` becomes `.paused` (transcribable, playable,
        // but never resumed — AVAudioRecorder can't append across launches).
        let recording = seed(state: .recording)
        let found = store.scan()
        XCTAssertEqual(found.first { $0.id == recording.id }?.state, .paused)
        XCTAssertEqual(store.load(id: recording.id)?.state, .paused,
                       "normalization must persist, not just report")
    }

    func testScanNormalizesStaleTranscribingToStopped() {
        // A kill mid-upload: the audio is intact and re-transcribes whole.
        let recording = seed(state: .transcribing)
        let found = store.scan()
        XCTAssertEqual(found.first { $0.id == recording.id }?.state, .stopped)
        XCTAssertEqual(store.load(id: recording.id)?.state, .stopped)
    }

    func testScanAdoptsOrphanM4a() {
        // A crash between the recorder creating the file and the first
        // sidecar write leaves audio with no description: adopt it.
        let id = UUID()
        let audioURL = directory.appendingPathComponent(id.uuidString + ".m4a")
        FileManager.default.createFile(atPath: audioURL.path, contents: Data([0x00]))
        let found = store.scan()
        let adopted = found.first { $0.id == id }
        XCTAssertEqual(adopted?.state, .stopped)
        XCTAssertNotNil(store.load(id: id), "adoption must persist a sidecar")
        XCTAssertEqual(store.scan().filter { $0.id == id }.count, 1,
                       "the second scan must not adopt it twice")
    }

    func testScanIgnoresNonUUIDOrphans() {
        let stray = directory.appendingPathComponent("notes.m4a")
        FileManager.default.createFile(atPath: stray.path, contents: Data([0x00]))
        XCTAssertTrue(store.scan().isEmpty)
    }

    func testScanSkipsSidecarWithoutAudio() {
        let recording = seed(state: .stopped, withAudio: false)
        XCTAssertTrue(store.scan().isEmpty)
        _ = recording
    }

    func testScanExcludesLiveIDs() {
        // The controller owns live/transcribing/under-review states; scan's
        // normalization must not rewrite them mid-flight.
        let live = seed(state: .recording)
        let found = store.scan(excluding: [live.id])
        XCTAssertTrue(found.isEmpty)
        XCTAssertEqual(store.load(id: live.id)?.state, .recording,
                       "excluded sidecars must not be normalized")
    }

    func testScanSortsNewestFirst() {
        let old = seed(state: .stopped, createdAt: Date(timeIntervalSince1970: 100))
        let new = seed(state: .stopped, createdAt: Date(timeIntervalSince1970: 200))
        XCTAssertEqual(store.scan().map(\.id), [new.id, old.id])
    }

    func testScanIncludeTranscribedAddsFinished() {
        let done = seed(state: .transcribed)
        XCTAssertTrue(store.scan().isEmpty)
        XCTAssertEqual(store.scan(includeTranscribed: true).map(\.id), [done.id])
    }

    func testDeleteRemovesAudioAndSidecar() {
        let recording = seed(state: .stopped)
        XCTAssertTrue(store.audioExists(for: recording))
        store.delete(id: recording.id)
        XCTAssertFalse(store.audioExists(for: recording))
        XCTAssertNil(store.load(id: recording.id))
    }
}
