import XCTest
@testable import PraxisChat

/// Deterministic engine: no mic, no session, no timers of its own. The
/// test drives `currentTime` and events by hand.
@MainActor
final class FakeVoiceEngine: VoiceRecorderEngine {
    var isRecording = false
    var isPaused = false
    var currentTime: TimeInterval = 0
    var level: Float = 0.5
    var eventHandler: (@MainActor (VoiceRecorderEvent) -> Void)?
    var permissionGranted = true
    var startError: Error?
    var startedURLs: [URL] = []
    var stopCount = 0

    func requestPermission() async -> Bool { permissionGranted }

    func start(fileURL: URL) throws {
        if let startError { throw startError }
        try? FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: fileURL.path, contents: Data([0x00]))
        startedURLs.append(fileURL)
        isRecording = true
        isPaused = false
    }

    func pause() { isPaused = true }

    func resume() throws {
        if let startError { throw startError }
        isPaused = false
    }

    func stop() {
        isRecording = false
        isPaused = false
        stopCount += 1
    }

    func updateMeters() {}

    func emit(_ event: VoiceRecorderEvent) { eventHandler?(event) }
}

/// Scripted transcriber with a programmable outcome (the app-DEBUG
/// `FakeTranscriber` only succeeds; UI seams use that one).
struct StubTranscriber: Transcriber, Sendable {
    var result: Result<VoiceTranscript, VoiceTranscriptionError>

    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript {
        progress(0.5, 1, 1)
        switch result {
        case .success(let transcript): return transcript
        case .failure(let error): throw error
        }
    }
}

/// The controller state machine (VOICE_PLAN.md §2–3): record → stop →
/// transcribe/review, pause/resume, interruptions, cancel rules, the
/// sent-message deletion rule, and the DEBUG seams' argument parsing.
@MainActor
final class VoiceInputControllerTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws {
        directory = temporaryDirectory().appendingPathComponent("Recordings", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory.deletingLastPathComponent())
    }

    private func makeChat() -> ChatStore {
        ChatStore(engine: DemoAgentEngine(timeScale: 0), conversations: [Conversation(title: "t")])
    }

    @discardableResult
    private func makeController(chat: ChatStore? = nil,
                                transcriber: any Transcriber = FakeTranscriber(text: "hello"),
                                configured: Bool = true,
                                engine: FakeVoiceEngine? = nil)
        -> (controller: VoiceInputController, chat: ChatStore, engine: FakeVoiceEngine)
    {
        let chat = chat ?? makeChat()
        let engine = engine ?? FakeVoiceEngine()
        let controller = VoiceInputController(
            store: RecordingStore(directory: directory), transcriber: transcriber,
            settings: FakeVoiceSettings(isConfigured: configured), chatStore: chat,
            makeEngine: { engine })
        return (controller, chat, engine)
    }

    private func startRecording(_ controller: VoiceInputController) async -> VoiceRecording {
        controller.micTapped()
        await waitUntil { controller.phase == .recording }
        return controller.activeRecording!
    }

    // MARK: Record → stop → transcribe

    func testMicStartsRecordingAndPersistsSidecar() async {
        let (controller, chat, engine) = makeController()
        let recording = await startRecording(controller)
        XCTAssertEqual(engine.startedURLs.count, 1)
        XCTAssertNotNil(RecordingStore(directory: directory).load(id: recording.id))
        XCTAssertTrue(RecordingStore(directory: directory).audioExists(for: recording))
        XCTAssertEqual(recording.conversationID, chat.selectedID,
                       "the recording binds to the chat it started in")
    }

    func testDoubleMicTapStartsOnce() async {
        let (controller, _, engine) = makeController()
        controller.micTapped()
        controller.micTapped()
        await waitUntil { controller.phase == .recording }
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(engine.startedURLs.count, 1)
    }

    func testStopAndTranscribeAppendsToDraft() async {
        let (controller, chat, _) = makeController()
        chat.draft = "existing"
        _ = await startRecording(controller)
        controller.stopAndTranscribe()
        await waitUntil { controller.phase == .idle }
        XCTAssertEqual(chat.draft, "existing\nhello")
        let id = controller.recoverable.first?.id
        XCTAssertNil(id, "transcribed recordings leave the recovery list")
    }

    func testStopAndTranscribeEmptyDraftHasNoSeparator() async {
        let (controller, chat, _) = makeController()
        _ = await startRecording(controller)
        controller.stopAndTranscribe()
        await waitUntil { controller.phase == .idle }
        XCTAssertEqual(chat.draft, "hello")
    }

    func testTranscribedRecordingKeepsPreview() async {
        let (controller, _, _) = makeController()
        let recording = await startRecording(controller)
        controller.stopAndTranscribe()
        await waitUntil { controller.phase == .idle }
        let saved = RecordingStore(directory: directory).load(id: recording.id)
        XCTAssertEqual(saved?.state, .transcribed)
        XCTAssertEqual(saved?.transcriptPreview, "hello")
    }

    func testStopAndReviewKeepsAudioWithoutTranscribing() async {
        let (controller, chat, _) = makeController()
        let recording = await startRecording(controller)
        controller.stopAndReview()
        XCTAssertEqual(controller.phase, .review)
        XCTAssertTrue(chat.draft.isEmpty)
        XCTAssertEqual(RecordingStore(directory: directory).load(id: recording.id)?.state, .stopped)
        XCTAssertTrue(RecordingStore(directory: directory).audioExists(for: recording))
    }

    // MARK: Cancel rules

    func testCancelShortRecordingDiscardsImmediately() async {
        let (controller, _, engine) = makeController()
        let recording = await startRecording(controller)
        engine.currentTime = 5
        controller.cancelTapped()
        XCTAssertEqual(controller.phase, .idle)
        XCTAssertFalse(controller.cancelConfirmation)
        XCTAssertNil(RecordingStore(directory: directory).load(id: recording.id))
        XCTAssertFalse(RecordingStore(directory: directory).audioExists(for: recording))
    }

    func testCancelLongRecordingNeedsConfirmation() async {
        let (controller, _, engine) = makeController()
        let recording = await startRecording(controller)
        engine.currentTime = 15
        await waitUntil { controller.elapsed > 10 }
        controller.cancelTapped()
        XCTAssertTrue(controller.cancelConfirmation)
        XCTAssertEqual(controller.phase, .recording, "still recording until confirmed")
        controller.discardConfirmed()
        XCTAssertEqual(controller.phase, .idle)
        XCTAssertNil(RecordingStore(directory: directory).load(id: recording.id))
    }

    // MARK: Pause / resume / interruptions

    func testPauseAndResume() async {
        let (controller, _, engine) = makeController()
        _ = await startRecording(controller)
        controller.pauseTapped()
        XCTAssertEqual(controller.phase, .paused(.user))
        XCTAssertTrue(engine.isPaused)
        controller.resumeTapped()
        XCTAssertEqual(controller.phase, .recording)
        XCTAssertFalse(engine.isPaused)
    }

    func testEngineInterruptionEventPauses() async {
        let (controller, _, engine) = makeController()
        let recording = await startRecording(controller)
        engine.emit(.interrupted)
        XCTAssertEqual(controller.phase, .paused(.interrupted))
        XCTAssertEqual(controller.pauseNotice, "Paused — tap to resume")
        XCTAssertEqual(RecordingStore(directory: directory).load(id: recording.id)?.state, .paused)
        engine.emit(.interruptionEnded)
        XCTAssertEqual(controller.phase, .paused(.interrupted), "must NOT auto-resume")
    }

    func testRouteLostPausesAndRestoreStaysPaused() async {
        let (controller, _, engine) = makeController()
        _ = await startRecording(controller)
        engine.emit(.routeLost)
        XCTAssertEqual(controller.phase, .paused(.routeLost))
        XCTAssertEqual(controller.pauseNotice, "Microphone disconnected — tap to resume")
        engine.emit(.routeRestored)
        XCTAssertEqual(controller.phase, .paused(.user), "stays paused, generic hint")
    }

    func testEngineFailureStopsAndKeepsFile() async {
        let (controller, _, engine) = makeController()
        let recording = await startRecording(controller)
        engine.emit(.failed(message: "disk full"))
        XCTAssertEqual(controller.phase, .review)
        XCTAssertNotNil(controller.errorMessage)
        XCTAssertTrue(RecordingStore(directory: directory).audioExists(for: recording))
        XCTAssertEqual(RecordingStore(directory: directory).load(id: recording.id)?.state, .stopped)
    }

    // MARK: Permission / start errors

    func testDeniedPermissionShowsInlineNotice() async {
        let engine = FakeVoiceEngine()
        engine.permissionGranted = false
        let (controller, _, _) = makeController(engine: engine)
        controller.micTapped()
        await waitUntil { controller.permissionDenied }
        XCTAssertEqual(controller.phase, .idle)
        XCTAssertTrue(controller.showsRecordingUI)
        controller.dismissNotice()
        XCTAssertFalse(controller.permissionDenied)
    }

    func testStartFailureShowsErrorAndCleansUp() async {
        struct Boom: Error {}
        let engine = FakeVoiceEngine()
        engine.startError = Boom()
        let (controller, _, _) = makeController(engine: engine)
        controller.micTapped()
        await waitUntil { controller.startError != nil }
        XCTAssertEqual(controller.phase, .idle)
        XCTAssertTrue(RecordingStore(directory: directory).scan().isEmpty)
    }

    // MARK: Transcription failures

    func testServerFailureKeepsAudioAndOffersRetry() async {
        let transcriber = StubTranscriber(result: .failure(.server(message: "boom")))
        let (controller, _, _) = makeController(transcriber: transcriber)
        let recording = await startRecording(controller)
        controller.stopAndTranscribe()
        await waitUntil { controller.phase == .review }
        XCTAssertEqual(controller.errorMessage, "boom")
        XCTAssertTrue(RecordingStore(directory: directory).audioExists(for: recording))
        XCTAssertEqual(RecordingStore(directory: directory).load(id: recording.id)?.state, .failed)
    }

    func testOfflineFailureQueues() async {
        let transcriber = StubTranscriber(result: .failure(.offline))
        let (controller, _, _) = makeController(transcriber: transcriber)
        let recording = await startRecording(controller)
        controller.stopAndTranscribe()
        await waitUntil { controller.phase == .review }
        XCTAssertEqual(RecordingStore(directory: directory).load(id: recording.id)?.state, .queued)
        XCTAssertTrue(controller.errorMessage?.contains("offline") == true)
    }

    func testEmptyTranscriptIsKeptAsFailure() async {
        let empty = VoiceTranscript(text: "  \n ", language: nil, segments: [])
        let (controller, chat, _) = makeController(transcriber: StubTranscriber(result: .success(empty)))
        _ = await startRecording(controller)
        controller.stopAndTranscribe()
        await waitUntil { controller.phase == .review }
        XCTAssertTrue(chat.draft.isEmpty, "nothing appended")
        XCTAssertNotNil(controller.errorMessage)
    }

    func testCancelTranscriptionRestowsQuietly() async {
        let (controller, _, _) = makeController()
        let recording = await startRecording(controller)
        controller.stopAndTranscribe()
        controller.cancelTranscription()
        await waitUntil(timeout: 5) { controller.phase == .review && controller.transcribingID == nil }
        XCTAssertNil(controller.errorMessage)
        XCTAssertEqual(RecordingStore(directory: directory).load(id: recording.id)?.state, .stopped)
    }

    func testMissingKeyRoutesToSettingsAndRestows() async {
        let (controller, chat, _) = makeController(configured: false)
        _ = await startRecording(controller)
        controller.stopAndTranscribe()
        // No async transcription involved: the guard fails synchronously.
        XCTAssertEqual(controller.phase, .review)
        XCTAssertEqual(controller.transcribeHint, "Add your Groq API key to use voice input")
        XCTAssertTrue(chat.isSettingsPresented)
    }

    // MARK: Sent-message rule

    func testNoteDidSendDeletesOnlyMatchingTranscripts() async {
        let (controller, _, _) = makeController()
        let recording = await startRecording(controller)
        controller.stopAndTranscribe()
        await waitUntil { controller.phase == .idle }
        controller.noteDidSend(text: "something unrelated")
        XCTAssertNotNil(RecordingStore(directory: directory).load(id: recording.id),
                        "transcribed-but-unsent recordings stay")
        controller.noteDidSend(text: "please hello world")
        XCTAssertNil(RecordingStore(directory: directory).load(id: recording.id),
                     "sent transcript deletes its audio")
    }

    // MARK: Origin-chat scoping

    func testRecordingUIOnlyInOriginChat() async {
        let chat = makeChat()
        chat.newChat()
        let chatB = chat.selectedID!
        let (controller, _, _) = makeController(chat: chat)
        _ = await startRecording(controller)
        XCTAssertTrue(controller.showsRecordingUI)
        XCTAssertTrue(controller.showsStopButton)
        XCTAssertNil(controller.pillRecording)
        let chatA = chat.conversations.first { $0.id != chatB }!.id
        chat.select(chatA)
        XCTAssertFalse(controller.showsRecordingUI, "other chats keep their field")
        XCTAssertFalse(controller.showsStopButton)
        XCTAssertNotNil(controller.pillRecording)
        chat.select(chatB)
        XCTAssertTrue(controller.showsRecordingUI)
        XCTAssertNil(controller.pillRecording)
    }

    func testMicDuringLiveSessionDoesNothing() async {
        let (controller, _, engine) = makeController()
        _ = await startRecording(controller)
        controller.stopAndReview()
        controller.micTapped() // the review owns the session
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(engine.startedURLs.count, 1)
        XCTAssertEqual(controller.phase, .review)
    }

    func testReviewFallsBackToBannerFromOtherChat() async {
        let chat = makeChat()
        chat.newChat()
        let chatB = chat.selectedID!
        let (controller, _, _) = makeController(chat: chat)
        let recording = await startRecording(controller)
        controller.stopAndReview()
        controller.refreshRecoverables()
        XCTAssertTrue(controller.recoverable.isEmpty, "the review row owns it in its own chat")
        let chatA = chat.conversations.first { $0.id != chatB }!.id
        chat.select(chatA)
        controller.refreshRecoverables() // ChatScreen does this on selection change
        XCTAssertEqual(controller.recoverable.map(\.id), [recording.id])
    }

    // MARK: Recovery

    func testRecoveryListedOnInit() async {
        let store = RecordingStore(directory: directory)
        var recording = VoiceRecording(conversationID: UUID())
        recording.state = .stopped
        XCTAssertTrue(store.save(recording))
        FileManager.default.createFile(atPath: store.audioURL(for: recording).path, contents: Data([0x00]))
        let (controller, _, _) = makeController()
        XCTAssertEqual(controller.recoverable.map(\.id), [recording.id])
    }

    // MARK: DEBUG seams (argument parsing)

    func testFakeTranscriptFlagParsing() {
        XCTAssertNil(VoiceInputController.fakeTranscriptText(arguments: ["app"]))
        XCTAssertEqual(VoiceInputController.fakeTranscriptText(
            arguments: ["app", "-PraxisFakeTranscript", "hi there"]), "hi there")
        XCTAssertEqual(VoiceInputController.fakeTranscriptText(
            arguments: ["app", "-PraxisFakeTranscript"]), "Test transcription")
    }

    func testFakeRecordingFlagParsing() {
        XCTAssertNil(VoiceInputController.fakeFixtureURL(arguments: ["app"]))
        XCTAssertNil(VoiceInputController.fakeFixtureURL(arguments: ["app", "-PraxisFakeRecording"]))
        let tmp = temporaryDirectory().appendingPathComponent("x.m4a")
        FileManager.default.createFile(atPath: tmp.path, contents: Data([0x00]))
        XCTAssertEqual(VoiceInputController.fakeFixtureURL(
            arguments: ["app", "-PraxisFakeRecording", tmp.path]), tmp)
        try? FileManager.default.removeItem(at: tmp.deletingLastPathComponent())
    }

    func testFakeElapsedParsing() {
        XCTAssertEqual(VoiceInputController.fakeElapsed(arguments: ["app"]), 0)
        XCTAssertEqual(VoiceInputController.fakeElapsed(
            arguments: ["app", "-PraxisFakeElapsed", "15"]), 15)
        XCTAssertEqual(VoiceInputController.fakeElapsed(
            arguments: ["app", "-PraxisFakeElapsed", "junk"]), 0)
    }
}
