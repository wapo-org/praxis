import Foundation
import AVFoundation
import Observation

// VoiceSendObserver's frozen home (VOICE_PLAN.md §7): voice-rec owns this
// file permanently. ChatStore calls noteDidSend after a successful send.
@MainActor
protocol VoiceSendObserver {
    func noteDidSend(text: String)
}

/// Why a live recording is paused. Display copy comes from `notice`.
enum VoicePauseReason: String, Sendable, Equatable {
    /// The user tapped pause.
    case user
    /// A call/Siri/alarm interrupted: "Paused — tap to resume". Never
    /// auto-resumes — the user may be mid-call.
    case interrupted
    /// The input vanished mid-recording (unplugged mic, lost route).
    case routeLost
}

/// The composer's voice UI state. One value drives the middle area, the
/// trailing button, the pill and the banner, so they can't disagree.
enum VoicePhase: Equatable {
    case idle
    case recording
    case paused(VoicePauseReason)
    case transcribing
    /// Stopped, audio kept: play / transcribe / delete row.
    case review
}

/// The voice UI state machine (VOICE_PLAN.md §2–3). Owns the recorder +
/// the store, calls `any Transcriber`. Every failure keeps the audio and
/// offers Retry; deletion happens only on explicit user delete or the
/// sent-message rule (`noteDidSend`).
///
/// Constructed per frozen §7 with `(store:transcriber:settings:chatStore:)`;
/// the engine factory is an extra defaulted parameter (fakes in tests,
/// the `-PraxisFakeRecording` simulator in DEBUG UI tests).
@MainActor
@Observable
final class VoiceInputController: VoiceSendObserver {
    // MARK: Observed UI state

    private(set) var phase: VoicePhase = .idle
    /// The live or under-review recording (nil in idle/transcribing-from-banner).
    private(set) var activeRecording: VoiceRecording?
    /// 0…1 meter level, polled ~10/s while recording.
    private(set) var level: Float = 0
    /// Seconds captured (pauses excluded — the recorder's clock).
    private(set) var elapsed: TimeInterval = 0
    /// (fraction, part, parts) while transcribing.
    private(set) var transcriptionProgress: (fraction: Double, part: Int, parts: Int)?
    private(set) var transcribingID: UUID?
    /// "Long recording — 62 min" once past 60 min, then every 15. Warning
    /// only: there is deliberately no auto-stop.
    private(set) var lengthWarning: String?
    /// Mic permission denied/restricted: inline explanation + Open Settings.
    private(set) var permissionDenied = false
    /// "Couldn't start recording" (engine failure): inline error + dismiss.
    private(set) var startError: String?
    /// Cancel of a > 10 s recording waits on this destructive confirmation.
    var cancelConfirmation = false
    /// Last failure message + which recording offers Retry (nil id = the
    /// review row or a global notice, never a banner row).
    private(set) var errorMessage: String?
    private(set) var errorRecordingID: UUID?
    /// "Add your Groq API key…" — transcribe needs the key, recording doesn't.
    private(set) var transcribeHint: String?
    /// Recovery list (banner + rows), newest first. Live, transcribing and
    /// under-review recordings are excluded — they have their own UI.
    private(set) var recoverable: [VoiceRecording] = []
    /// AVAudioPlayer review playback.
    private(set) var playingID: UUID?

    /// The composer middle shows voice UI instead of the text field.
    /// Live/review/transcribing UI belongs to the originating chat only —
    /// other chats keep their field (plus the pill for live recordings),
    /// and stopping always happens where the recording started. The
    /// permission/start notices are global (no chat owns them).
    var showsRecordingUI: Bool {
        if permissionDenied || startError != nil { return true }
        switch phase {
        case .idle:
            return false
        case .recording, .paused, .transcribing, .review:
            guard let active = activeRecording, let selected = chatStore?.selectedID else { return false }
            return active.conversationID == selected
        }
    }

    /// The trailing red stop button: live recordings in their own chat.
    /// Review, transcribing and notices own their actions in the middle.
    var showsStopButton: Bool {
        (phase == .recording || isPausedPhase) && showsRecordingUI
    }

    /// A live recording from another chat: the pill ("tap to return").
    var pillRecording: VoiceRecording? {
        guard let activeRecording,
              phase == .recording || isPausedPhase,
              activeRecording.conversationID != chatStore?.selectedID else { return nil }
        return activeRecording
    }

    var isPausedPhase: Bool {
        if case .paused = phase { return true }
        return false
    }

    /// "Paused — tap to resume" style notice for the current pause reason.
    var pauseNotice: String? {
        guard case .paused(let reason) = phase else { return nil }
        switch reason {
        case .user: return "Paused — tap to resume"
        case .interrupted: return "Paused — tap to resume"
        case .routeLost: return "Microphone disconnected — tap to resume"
        }
    }

    // MARK: Dependencies (frozen §7 + engine factory)

    @ObservationIgnored let store: RecordingStore
    @ObservationIgnored let transcriber: any Transcriber
    @ObservationIgnored let settings: any VoiceSettingsReader
    @ObservationIgnored private weak var chatStore: ChatStore?
    @ObservationIgnored private let makeEngine: @MainActor () -> any VoiceRecorderEngine

    init(store: RecordingStore, transcriber: any Transcriber, settings: any VoiceSettingsReader,
         chatStore: ChatStore, makeEngine: (@MainActor () -> any VoiceRecorderEngine)? = nil) {
        self.store = store
        self.transcriber = transcriber
        self.settings = settings
        self.chatStore = chatStore
        #if DEBUG
        self.makeEngine = makeEngine ?? {
            if let fixture = Self.fakeFixtureURL() {
                SimulatedVoiceRecorder(fixtureURL: fixture, startOffset: Self.fakeElapsed())
            } else {
                AVAudioVoiceRecorder()
            }
        }
        #else
        self.makeEngine = makeEngine ?? { AVAudioVoiceRecorder() }
        #endif
        playbackDelegate.onFinish = { [weak self] in
            self?.player = nil
            self?.playingID = nil
        }
        refreshRecoverables()
    }

    /// Production wiring (final `voice` integration): the real Groq settings
    /// plus a transcriber that snapshots them fresh on every call, so a
    /// consent grant or a model/language change after launch takes effect on
    /// the next transcription (in particular the consent allow-path retry).
    /// DEBUG `-PraxisFakeTranscript` still swaps in the fake for UI tests.
    static func production(chatStore: ChatStore, services: AgentServices) -> VoiceInputController {
        #if DEBUG
        if let text = fakeTranscriptText() {
            return VoiceInputController(store: .production(), transcriber: FakeTranscriber(text: text),
                                        settings: FakeVoiceSettings(isConfigured: true), chatStore: chatStore)
        }
        #endif
        let settings = services.voice
        let consent = services.consent
        let live = LiveGroqTranscriber {
            settings.makeTranscriber(consentGranted: consent.isGranted(GroqEndpoints.host))
        }
        return VoiceInputController(store: .production(), transcriber: live,
                                    settings: settings, chatStore: chatStore)
    }

    // MARK: Machinery (not observed)

    @ObservationIgnored private var engine: (any VoiceRecorderEngine)?
    @ObservationIgnored private var starting = false
    @ObservationIgnored private var pollTimer: Timer?
    @ObservationIgnored private var lastSidecarSave = Date.distantPast
    @ObservationIgnored private var nextLengthWarning: TimeInterval = 3_600
    @ObservationIgnored private var transcriptionTask: Task<Void, Never>?
    @ObservationIgnored private var transcribeOrigin: TranscribeOrigin?
    @ObservationIgnored private var player: AVAudioPlayer?
    @ObservationIgnored private let playbackDelegate = VoicePlaybackDelegate()
    /// (recording, inserted text) pairs awaiting the sent-message rule.
    @ObservationIgnored private var insertedTranscripts: [(id: UUID, text: String)] = []

    private enum TranscribeOrigin {
        case active, review, banner
    }

    // MARK: Mic

    /// The mic button. No-op while voice UI is already up (stop/pause/
    /// review buttons own those states). Recording never depends on the
    /// Groq key — only transcribing does.
    func micTapped() {
        guard !showsRecordingUI else { return }
        guard transcriptionTask == nil else { return }
        // One live session: starting over a recording, a review or an
        // active transcription would orphan its engine or clobber its
        // phase. (Banner transcriptions leave the phase idle, so recording
        // during those stays allowed.)
        guard phase == .idle else { return }
        // Synchronous guard: a double-tap must not start two recordings
        // (the second would orphan the first engine mid-record). This runs
        // in the tap's own turn, before any suspension point.
        guard !starting else { return }
        starting = true
        stopPlayback()
        Task { await startFlow() }
    }

    private func startFlow() async {
        defer { starting = false }
        let engine = makeEngine()
        let granted = await engine.requestPermission()
        guard granted else {
            chatStore?.haptics.fire(.soft)
            permissionDenied = true
            return
        }
        permissionDenied = false
        startError = nil
        errorMessage = nil
        errorRecordingID = nil
        transcribeHint = nil

        var recording = VoiceRecording(conversationID: chatStore?.selectedID ?? UUID())
        engine.eventHandler = { [weak self] event in self?.handleEngineEvent(event) }
        do {
            try engine.start(fileURL: store.audioURL(for: recording))
        } catch {
            chatStore?.haptics.fire(.warning)
            startError = "Couldn't start recording"
            engine.stop()
            store.delete(id: recording.id)
            refreshRecoverables()
            return
        }
        self.engine = engine
        recording.state = .recording
        recording.duration = 0
        activeRecording = recording
        store.save(recording)
        lastSidecarSave = Date()
        nextLengthWarning = 3_600
        lengthWarning = nil
        elapsed = engine.currentTime
        level = 0
        phase = .recording
        chatStore?.haptics.fire(.light)
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.poll() }
        }
        refreshRecoverables()
    }

    /// Dismisses the denied / start-error cards.
    func dismissNotice() {
        permissionDenied = false
        startError = nil
    }

    // MARK: Pause / resume

    func pauseTapped() {
        guard phase == .recording else { return }
        pauseRecording(reason: .user)
    }

    func resumeTapped() {
        guard isPausedPhase, let engine else { return }
        do {
            try engine.resume()
        } catch {
            chatStore?.haptics.fire(.warning)
            errorMessage = "Couldn't resume recording — audio kept"
            errorRecordingID = nil
            return
        }
        if var active = activeRecording {
            active.state = .recording
            activeRecording = active
            store.save(active)
        }
        phase = .recording
        chatStore?.haptics.fire(.light)
    }

    private func pauseRecording(reason: VoicePauseReason) {
        guard phase == .recording else { return }
        engine?.pause()
        poll()
        if var active = activeRecording {
            active.state = .paused
            active.duration = elapsed
            activeRecording = active
            store.save(active)
            lastSidecarSave = Date()
        }
        phase = .paused(reason)
        level = 0
        chatStore?.haptics.fire(.soft)
    }

    private func handleEngineEvent(_ event: VoiceRecorderEvent) {
        guard phase == .recording || isPausedPhase else { return }
        switch event {
        case .interrupted:
            // A call, Siri, an alarm: pause, persist NOW, never discard.
            pauseRecording(reason: .interrupted)
        case .interruptionEnded:
            // Deliberately no auto-resume (VOICE_PLAN.md §2).
            break
        case .routeLost:
            pauseRecording(reason: .routeLost)
        case .routeRestored:
            // An input is back, but the user may have moved on: stay
            // paused, downgrade to the generic resume hint.
            if case .paused(.routeLost) = phase {
                phase = .paused(.user)
            }
        case .failed(let message):
            // Disk full / encode error: stop, keep the file, say so.
            stopEngineKeepingFile()
            if var active = activeRecording {
                active.state = .stopped
                activeRecording = active
                store.save(active)
            }
            errorMessage = "Recording stopped (\(message)) — audio kept"
            errorRecordingID = nil
            phase = .review
            refreshRecoverables()
        }
    }

    // MARK: Stop

    /// Primary action: stop, then transcribe into the draft.
    func stopAndTranscribe() {
        guard phase == .recording || isPausedPhase, var active = activeRecording else { return }
        stopEngineKeepingFile()
        // A banner transcription already in flight owns the single slot:
        // stop cleanly into review instead of dropping the transcribe.
        guard transcribingID == nil else {
            active.state = .stopped
            activeRecording = active
            store.save(active)
            phase = .review
            chatStore?.haptics.fire(.soft)
            refreshRecoverables()
            return
        }
        transcribe(active, origin: .active)
    }

    /// Stop and keep the audio: the review row (play / transcribe / delete).
    func stopAndReview() {
        guard phase == .recording || isPausedPhase, var active = activeRecording else { return }
        stopEngineKeepingFile()
        active.state = .stopped
        activeRecording = active
        store.save(active)
        phase = .review
        chatStore?.haptics.fire(.soft)
        refreshRecoverables()
    }

    /// Stops the engine, freezes duration into the sidecar. The file stays.
    private func stopEngineKeepingFile() {
        pollTimer?.invalidate()
        pollTimer = nil
        if let engine, var active = activeRecording {
            active.duration = engine.currentTime
            activeRecording = active
            store.save(active)
            lastSidecarSave = Date()
        }
        engine?.stop()
        engine = nil
        level = 0
    }

    // MARK: Cancel / delete

    /// ≤ 10 s discards at once; longer recordings need the destructive
    /// confirmation (`cancelConfirmation` drives the alert).
    func cancelTapped() {
        guard phase == .recording || isPausedPhase else { return }
        if elapsed > 10 {
            cancelConfirmation = true
        } else {
            discardActive()
        }
    }

    func discardConfirmed() {
        cancelConfirmation = false
        discardActive()
    }

    private func discardActive() {
        stopEngineKeepingFile()
        if let active = activeRecording {
            store.delete(id: active.id)
            insertedTranscripts.removeAll { $0.id == active.id }
        }
        activeRecording = nil
        phase = .idle
        elapsed = 0
        lengthWarning = nil
        errorMessage = nil
        errorRecordingID = nil
        chatStore?.haptics.fire(.soft)
        refreshRecoverables()
    }

    /// Explicit user delete — one of only two deletion paths (the other is
    /// the sent-message rule). Works from the review row and the recovery
    /// list alike.
    func deleteRecording(id: UUID) {
        if playingID == id { stopPlayback() }
        if transcribingID == id {
            // The task's late finish then no-ops (sidecar gone, origin nil).
            transcriptionTask?.cancel()
            transcriptionTask = nil
            transcribingID = nil
            transcriptionProgress = nil
            transcribeOrigin = nil
        }
        if activeRecording?.id == id {
            stopEngineKeepingFile()
            activeRecording = nil
            phase = .idle
            elapsed = 0
        }
        store.delete(id: id)
        insertedTranscripts.removeAll { $0.id == id }
        if errorRecordingID == id {
            errorMessage = nil
            errorRecordingID = nil
        }
        chatStore?.haptics.fire(.soft)
        refreshRecoverables()
    }

    // MARK: Transcribe

    /// Review-row and recovery-row Transcribe buttons.
    func transcribeTapped(id: UUID) {
        guard transcribingID == nil else { return }
        stopPlayback()
        if activeRecording?.id == id, phase == .review, let active = activeRecording {
            transcribe(active, origin: .review)
        } else if let recording = recoverable.first(where: { $0.id == id }) {
            transcribe(recording, origin: .banner)
        } else if let recording = store.load(id: id), recording.needsAttention {
            transcribe(recording, origin: .banner)
        }
    }

    /// voice-groq's consent allow-path calls this (via ChatStore's
    /// `voiceRetryTranscription`) to resume a consented transcription.
    func retryTranscription(id: UUID) {
        transcribeTapped(id: id)
    }

    func cancelTranscription() {
        transcriptionTask?.cancel()
    }

    private func transcribe(_ recording: VoiceRecording, origin: TranscribeOrigin) {
        guard transcribingID == nil else { return }
        guard store.audioExists(for: recording) else {
            // The audio is already gone: drop the orphaned sidecar, say so.
            store.delete(id: recording.id)
            errorMessage = "Audio file is missing — recording removed"
            errorRecordingID = nil
            if activeRecording?.id == recording.id {
                activeRecording = nil
                phase = .idle
            }
            refreshRecoverables()
            return
        }
        guard settings.isConfigured else {
            // Recording works without a key; transcribing routes to Settings.
            // Restow first: the engine already stopped, so the phase must
            // leave recording behind (review owns the retry).
            restow(id: recording.id, state: .stopped, origin: origin)
            transcribeHint = "Add your Groq API key to use voice input"
            chatStore?.haptics.fire(.soft)
            chatStore?.isSettingsPresented = true
            return
        }
        // One transcription at a time; the UI disables the other buttons.
        // Banner transcriptions leave activeRecording alone: a live
        // recording may be running while an old one transcribes.
        var inFlight = recording
        inFlight.state = .transcribing
        store.save(inFlight)
        if origin == .active || origin == .review {
            activeRecording = inFlight
        }
        transcribingID = recording.id
        transcribeOrigin = origin
        transcriptionProgress = (fraction: 0, part: 1, parts: 1)
        errorMessage = nil
        errorRecordingID = nil
        transcribeHint = nil
        if origin == .active || origin == .review {
            phase = .transcribing
        }
        refreshRecoverables()

        let audioURL = store.audioURL(for: recording)
        let fileName = recording.fileName
        transcriptionTask = Task {
            var transcript: VoiceTranscript?
            var failure: VoiceTranscriptionError?
            do {
                transcript = try await transcriber.transcribe(file: audioURL, fileName: fileName) {
                    [weak self] fraction, part, parts in
                    Task { @MainActor [weak self] in
                        self?.transcriptionProgress = (fraction, part, parts)
                    }
                }
            } catch is CancellationError {
                failure = .cancelled
            } catch let error as VoiceTranscriptionError {
                failure = error
            } catch {
                failure = .server(message: "Transcription failed")
            }
            await MainActor.run { [weak self] in
                self?.finishTranscription(id: recording.id, transcript: transcript, failure: failure)
            }
        }
    }

    private func finishTranscription(id: UUID, transcript: VoiceTranscript?, failure: VoiceTranscriptionError?) {
        transcriptionTask = nil
        transcribingID = nil
        transcriptionProgress = nil
        let origin = transcribeOrigin
        transcribeOrigin = nil

        if let failure {
            handleTranscriptionFailure(id: id, error: failure, origin: origin)
            return
        }
        guard let transcript else {
            handleTranscriptionFailure(id: id, error: .server(message: "Transcription failed"), origin: origin)
            return
        }
        let text = transcript.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            // The pipeline worked but heard nothing: keep the audio, offer
            // Retry like any other failure (it may be transient).
            handleTranscriptionFailure(id: id, error: .server(message: "Transcription was empty"), origin: origin)
            return
        }
        var done = store.load(id: id) ?? activeRecording ?? VoiceRecording(
            id: id, conversationID: UUID(), state: .transcribed, createdAt: Date(),
            duration: elapsed, fileName: id.uuidString + ".m4a", transcriptPreview: nil)
        done.state = .transcribed
        done.transcriptPreview = String(text.prefix(120))
        store.save(done)
        // Append, never replace: the draft is the user's.
        if let chatStore {
            chatStore.draft = chatStore.draft.isEmpty ? text : chatStore.draft + "\n" + text
        }
        insertedTranscripts.append((id: id, text: text))
        if insertedTranscripts.count > 20 { insertedTranscripts.removeFirst(insertedTranscripts.count - 20) }
        if activeRecording?.id == id { activeRecording = nil }
        if origin == .active || origin == .review {
            // A banner success mid-recording must not clear live progress.
            phase = .idle
            elapsed = 0
            lengthWarning = nil
        }
        chatStore?.haptics.fire(.success)
        refreshRecoverables()
    }

    private func handleTranscriptionFailure(id: UUID, error: VoiceTranscriptionError, origin: TranscribeOrigin?) {
        if case .cancelled = error {
            // User-cancelled: back to stopped, parts kept, no error shown.
            restow(id: id, state: .stopped, origin: origin)
            return
        }
        switch error {
        case .missingKey:
            restow(id: id, state: .stopped, origin: origin)
            transcribeHint = "Add your Groq API key to use voice input"
            chatStore?.haptics.fire(.soft)
            chatStore?.isSettingsPresented = true
        case .consentRequired(let host):
            // First upload to this host: hold for the consent sheet (the
            // same sheet as sends). Allowing grants + retries via
            // voice-groq's resolveConsent branch; declining keeps the
            // queued audio (their decline path is a no-op by agreement).
            restow(id: id, state: .queued, origin: origin)
            let recording = store.load(id: id) ?? (activeRecording?.id == id ? activeRecording : nil)
            if let chatStore, let recording {
                chatStore.pendingConsent = ConsentRequest(
                    host: host, providerName: "Groq", connectorNames: [],
                    conversationID: recording.conversationID,
                    action: .transcribe(recordingID: id))
            } else {
                showFailure("Voice upload needs consent for \(host)", id: id, origin: origin)
            }
        case .unauthorized:
            restow(id: id, state: .failed, origin: origin)
            showFailure("Check your Groq API key", id: id, origin: origin)
            chatStore?.isSettingsPresented = true
        case .tooLarge:
            restow(id: id, state: .failed, origin: origin)
            showFailure("This recording is too large to transcribe", id: id, origin: origin)
        case .rateLimited:
            restow(id: id, state: .failed, origin: origin)
            showFailure("Rate limited — try again shortly", id: id, origin: origin)
        case .offline:
            // Queued + persisted: Retry (or voice-groq's path monitor)
            // resumes it. The queue survives relaunch via the sidecar.
            restow(id: id, state: .queued, origin: origin)
            showFailure("You're offline — transcription is queued", id: id, origin: origin)
        case .server(let message):
            restow(id: id, state: .failed, origin: origin)
            showFailure(message, id: id, origin: origin)
        case .cancelled:
            restow(id: id, state: .stopped, origin: origin)
        }
        chatStore?.haptics.fire(.warning)
    }

    /// Returns the recording to a resting state after a failure/cancel.
    private func restow(id: UUID, state: VoiceRecordingState, origin: TranscribeOrigin?) {
        if var current = store.load(id: id) {
            current.state = state
            store.save(current)
            if activeRecording?.id == id { activeRecording = current }
        }
        if origin == .active || origin == .review {
            // The review row owns Retry/Delete/Play for these.
            phase = .review
        }
        refreshRecoverables()
    }

    /// Routes the message to the review row (active/review origins) or to
    /// the matching recovery row (banner origin).
    private func showFailure(_ message: String, id: UUID, origin: TranscribeOrigin?) {
        errorMessage = message
        errorRecordingID = origin == .banner ? id : nil
    }

    // MARK: Sent-message rule (VoiceSendObserver)

    /// Deletes recordings whose inserted transcript is contained in the
    /// sent text. Called by `ChatStore.send` after a successful send.
    /// Transcribed-but-unsent recordings stay until the user deletes them.
    func noteDidSend(text: String) {
        guard !insertedTranscripts.isEmpty else { return }
        let sent = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sent.isEmpty else { return }
        let due = insertedTranscripts.filter { !$0.text.isEmpty && sent.contains($0.text) }
        guard !due.isEmpty else { return }
        for pair in due {
            store.delete(id: pair.id)
        }
        insertedTranscripts.removeAll { pair in due.contains { $0.id == pair.id } }
        refreshRecoverables()
    }

    // MARK: Review playback

    func togglePlay(id: UUID) {
        if playingID == id {
            stopPlayback()
        } else {
            play(id: id)
        }
    }

    func play(id: UUID) {
        stopPlayback()
        let recording = activeRecording?.id == id ? activeRecording : (recoverable.first { $0.id == id } ?? store.load(id: id))
        guard let recording, store.audioExists(for: recording) else {
            errorMessage = "Couldn't play this recording"
            errorRecordingID = nil
            return
        }
        do {
            let player = try AVAudioPlayer(contentsOf: store.audioURL(for: recording))
            player.delegate = playbackDelegate
            player.play()
            self.player = player
            playingID = id
        } catch {
            errorMessage = "Couldn't play this recording"
            errorRecordingID = nil
        }
    }

    func stopPlayback() {
        player?.stop()
        player = nil
        playingID = nil
    }

    // MARK: Lifecycle

    /// Background/lock: persist the live sidecar (the audio is already on
    /// disk; the `audio` background mode keeps the recorder running).
    func appDidEnterBackground() {
        if let active = activeRecording, phase == .recording || isPausedPhase {
            var snap = active
            snap.duration = engine?.currentTime ?? elapsed
            store.save(snap)
        }
    }

    /// Meter + elapsed poll (~10/s). Elapsed is the recorder's clock, so
    /// pauses are excluded. Persists the sidecar every ~5 s; warns past
    /// 60 min (then every 15) without ever auto-stopping.
    private func poll() {
        guard let engine, phase == .recording || isPausedPhase else { return }
        engine.updateMeters()
        level = engine.isPaused ? 0 : engine.level
        elapsed = engine.currentTime
        if Date().timeIntervalSince(lastSidecarSave) > 5, var active = activeRecording {
            active.duration = elapsed
            activeRecording = active
            store.save(active)
            lastSidecarSave = Date()
        }
        if elapsed >= nextLengthWarning {
            lengthWarning = "Long recording — \(Int(elapsed / 60)) min"
            nextLengthWarning += 900
        }
    }

    /// Reloads the banner/list, excluding recordings that have their own
    /// UI (live, transcribing, under review in its own chat). A review left
    /// behind in another chat falls back to the banner — ChatScreen calls
    /// this on every chat switch so it can't get stuck either way.
    func refreshRecoverables() {
        var excluded: Set<UUID> = []
        if let active = activeRecording {
            if phase == .review, active.conversationID != chatStore?.selectedID {
                // Seen from another chat: the banner lists it.
            } else {
                excluded.insert(active.id)
            }
        }
        if let transcribing = transcribingID { excluded.insert(transcribing) }
        recoverable = store.scan(excluding: excluded)
    }
}

/// AVAudioPlayer's delegate must be an NSObject; this forwarder keeps
/// the controller a plain `@Observable` class.
@MainActor
final class VoicePlaybackDelegate: NSObject, AVAudioPlayerDelegate {
    var onFinish: (@MainActor () -> Void)?

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in self?.onFinish?() }
    }
}

// MARK: - Until voice-groq lands

/// Placeholder transcriber: recording works, transcribing routes to
/// Settings. voice-groq's `GroqTranscriber` replaces this in `production`.
struct UnconfiguredTranscriber: Transcriber, Sendable {
    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript {
        throw VoiceTranscriptionError.missingKey
    }
}

/// Placeholder settings reader (key state unknown until voice-groq's
/// `GroqVoiceSettings` lands, so transcribe routes to Settings).
struct UnconfiguredVoiceSettings: VoiceSettingsReader, Sendable {
    var isConfigured: Bool { false }
}

#if DEBUG
/// Scripted transcriber for tests: reports progress, honors cancellation,
/// returns `text`. UI tests pick it via `-PraxisFakeTranscript <text>`.
struct FakeTranscriber: Transcriber, Sendable {
    var text: String
    var language: String? = "en"
    var onTranscribe: (@Sendable (URL) -> Void)?

    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript {
        onTranscribe?(file)
        for fraction in [0.2, 0.5, 0.9] {
            try await Task.sleep(for: .milliseconds(80))
            try Task.checkCancellation()
            progress(fraction, 1, 1)
        }
        try Task.checkCancellation()
        progress(1.0, 1, 1)
        return VoiceTranscript(text: text, language: language, segments: [])
    }
}

/// Scripted settings reader (UI tests run "configured" so transcribe flows).
struct FakeVoiceSettings: VoiceSettingsReader, Sendable {
    var isConfigured: Bool
}

extension VoiceInputController {
    /// `-PraxisFakeTranscript <text>`: UI-test seam (plan §9). Present =
    /// use `FakeTranscriber`; the value is the returned transcript.
    static func fakeTranscriptText(arguments: [String] = ProcessInfo.processInfo.arguments) -> String? {
        guard let i = arguments.firstIndex(of: "-PraxisFakeTranscript") else { return nil }
        let next = arguments.index(after: i)
        if next < arguments.endIndex, !arguments[next].hasPrefix("-") {
            return arguments[next]
        }
        return "Test transcription"
    }

    /// `-PraxisFakeRecording <path>` (frozen, plan §9): when present, mic
    /// input is simulated and the bundled/absolute-path audio file stages
    /// as the result. Unit-testable via explicit arguments.
    static func fakeFixtureURL(arguments: [String] = ProcessInfo.processInfo.arguments,
                               bundle: Bundle = .main) -> URL? {
        guard let i = arguments.firstIndex(of: "-PraxisFakeRecording") else { return nil }
        let next = arguments.index(after: i)
        guard next < arguments.endIndex else { return nil }
        let path = arguments[next]
        if FileManager.default.fileExists(atPath: path) {
            return URL(fileURLWithPath: path)
        }
        let stem = (path as NSString).deletingPathExtension
        let ext = (path as NSString).pathExtension
        if !ext.isEmpty, let url = bundle.url(forResource: stem, withExtension: ext) {
            return url
        }
        return bundle.url(forResource: path, withExtension: "m4a")
    }

    /// `-PraxisFakeElapsed <seconds>`: the simulated recording starts with
    /// this much elapsed (cancel-confirm tests need > 10 s instantly).
    static func fakeElapsed(arguments: [String] = ProcessInfo.processInfo.arguments) -> TimeInterval {
        guard let i = arguments.firstIndex(of: "-PraxisFakeElapsed") else { return 0 }
        let next = arguments.index(after: i)
        guard next < arguments.endIndex, let value = TimeInterval(arguments[next]) else { return 0 }
        return max(0, value)
    }
}
#endif
