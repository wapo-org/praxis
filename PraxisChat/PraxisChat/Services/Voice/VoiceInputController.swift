import Foundation
import AVFoundation
import Observation

// Frozen VoiceSendObserver contract: ChatStore calls noteDidSend after a successful send.
@MainActor
protocol VoiceSendObserver {
    func noteDidSend(text: String)
}

enum VoicePauseReason: String, Sendable, Equatable {
    case user
    /// System interruption (call/Siri/alarm); never auto-resumes because user may be mid-call.
    case interrupted
    case routeLost
}

/// Single source of truth driving composer middle, trailing button, pill, and recovery banner.
enum VoicePhase: Equatable {
    case idle
    case recording
    case paused(VoicePauseReason)
    case transcribing
    case review
}

/// Voice state machine: preserves audio on every failure; deletes only via user or noteDidSend.
@MainActor
@Observable
final class VoiceInputController: VoiceSendObserver {
    // MARK: Observed UI state

    private(set) var phase: VoicePhase = .idle
    /// Live or under-review recording; nil when idle or transcribing from the recovery banner.
    private(set) var activeRecording: VoiceRecording?
    private(set) var level: Float = 0
    /// Recorded duration in seconds, excluding paused intervals.
    private(set) var elapsed: TimeInterval = 0
    private(set) var transcriptionProgress: (fraction: Double, part: Int, parts: Int)?
    private(set) var transcribingID: UUID?
    /// Advisory warning past 60 min (then every 15 min); recording never auto-stops.
    private(set) var lengthWarning: String?
    private(set) var permissionDenied = false
    private(set) var startError: String?
    /// Guards destructive cancel confirmation for recordings longer than 10 s.
    var cancelConfirmation = false
    /// Failure message; nil errorRecordingID targets the review row or global notice, never a banner.
    private(set) var errorMessage: String?
    private(set) var errorRecordingID: UUID?
    /// Hint shown when transcribing without a key; recording itself never requires a key.
    private(set) var transcribeHint: String?
    /// Recoverable banner items newest-first; excludes live, in-chat review, and transcribed items.
    private(set) var recoverable: [VoiceRecording] = []
    /// All stored recordings except live ones, including transcribed-but-unsent for deletion.
    private(set) var listRecordings: [VoiceRecording] = []
    private(set) var playingID: UUID?

    /// Shows voice UI only in the originating chat (except global permission/start error notices).
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

    var showsStopButton: Bool {
        (phase == .recording || isPausedPhase) && showsRecordingUI
    }

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

    /// Review-row error only; banner failures carry a recording ID and never appear here.
    var reviewError: String? {
        errorRecordingID == nil ? errorMessage : nil
    }

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
    @ObservationIgnored private var cloudMode = false
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

    /// Wires live settings with per-call snapshotting so consent/model changes apply on next call.
    static func production(chatStore: ChatStore, services: AgentServices) -> VoiceInputController {
        #if DEBUG
        if let text = fakeTranscriptText() {
            return VoiceInputController(store: .production(), transcriber: FakeTranscriber(text: text),
                                        settings: FakeVoiceSettings(isConfigured: true), chatStore: chatStore)
        }
        #endif
        let settings = services.voice
        let consent = services.consent
        // Relay is created before controller init; handler is wired right after before any events flow.
        let relay = TranscriptionEventRelay()
        let live = LiveGroqTranscriber {
            settings.makeTranscriber(consentGranted: consent.isGranted(GroqEndpoints.host))
        } onEvent: { relay.send($0) }
        let controller = VoiceInputController(store: .production(), transcriber: live,
                                              settings: settings, chatStore: chatStore)
        let weakController = WeakVoiceController(controller: controller)
        relay.setHandler { event in
            Task { @MainActor in weakController.controller?.handleTranscriptionEvent(event) }
        }
        return controller
    }

    /// Cloud production controller with session-only uploads; ignores GroqVoiceSettings and Keychain.
    static func production(chatStore: ChatStore, cloudServices: CloudServices) -> VoiceInputController {
        #if DEBUG
        if let text = fakeTranscriptText() {
            let controller = VoiceInputController(store: .production(), transcriber: FakeTranscriber(text: text),
                                                  settings: FakeVoiceSettings(isConfigured: true), chatStore: chatStore)
            controller.cloudMode = true
            return controller
        }
        #endif
        let relay = TranscriptionEventRelay()
        let transcriber = LiveCloudVoiceTranscriber {
            CloudVoiceTranscriber(client: cloudServices.client,
                                  model: cloudServices.preferences?.voice.model ?? "whisper-large-v3-turbo",
                                  language: cloudServices.preferences?.voice.language,
                                  onEvent: { relay.send($0) })
        }
        let controller = VoiceInputController(store: .production(), transcriber: transcriber, settings: cloudServices, chatStore: chatStore)
        controller.cloudMode = true
        let weakController = WeakVoiceController(controller: controller)
        relay.setHandler { event in Task { @MainActor in weakController.controller?.handleTranscriptionEvent(event) } }
        return controller
    }

    // MARK: Transcription queue events (review fix F4)

    /// Sendable weak wrapper letting off-main-actor relays reach the controller without cycles.
    private struct WeakVoiceController: Sendable {
        weak var controller: VoiceInputController?
    }

    /// Transient queue status notice while transcribing; cleared on progress updates and completion.
    private(set) var transcriptionNotice: String?

    /// Persists .queued on waitingForNetwork so relaunches offer Retry while the active call waits.
    func handleTranscriptionEvent(_ event: TranscriptionEvent) {
        guard transcribingID != nil else { return }
        switch event {
        case .waitingForNetwork:
            if let id = transcribingID, var current = store.load(id: id) {
                current.state = .queued
                store.save(current)
                if activeRecording?.id == id { activeRecording = current }
                refreshRecoverables()
            }
            transcriptionNotice = "Waiting for network…"
        case .retrying(_, let after):
            transcriptionNotice = "Retrying in \(max(1, Int(after.rounded())))s…"
        }
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
    @ObservationIgnored private var insertedTranscripts: [(id: UUID, text: String, conversationID: UUID)] = []

    private enum TranscribeOrigin {
        case active, review, banner
    }

    // MARK: Mic

    /// No-op while voice UI is active; recording never requires an API key.
    func micTapped() {
        guard !showsRecordingUI else { return }
        // Blocks new recordings during non-banner transcriptions; banner uploads run in a separate slot.
        if transcriptionTask != nil, transcribeOrigin != .banner { return }
        guard phase == .idle else { return }
        // Synchronous guard before any await to prevent double-taps from starting two engines.
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
            pauseRecording(reason: .interrupted)
        case .interruptionEnded:
            // Deliberately does not auto-resume after an interruption ends.
            break
        case .routeLost:
            pauseRecording(reason: .routeLost)
        case .routeRestored:
            // Keeps recording paused when input returns, switching to the generic resume hint.
            if case .paused(.routeLost) = phase {
                phase = .paused(.user)
            }
        case .failed(let message):
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

    func stopAndTranscribe() {
        guard phase == .recording || isPausedPhase, var active = activeRecording else { return }
        stopEngineKeepingFile()
        // Falls back to review when the single transcription slot is occupied by a banner upload.
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

    /// Discards <= 10 s recordings immediately; longer ones require destructive confirmation.
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

    func deleteRecording(id: UUID) {
        if playingID == id { stopPlayback() }
        if transcribingID == id {
            // Clears origin first so any late completion of the cancelled task becomes a no-op.
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

    /// Resumes transcription, including from ChatStore's post-consent retry path.
    func retryTranscription(id: UUID) {
        transcribeTapped(id: id)
    }

    func cancelTranscription() {
        transcriptionTask?.cancel()
    }

    private func transcribe(_ recording: VoiceRecording, origin: TranscribeOrigin) {
        guard transcribingID == nil else { return }
        guard store.audioExists(for: recording) else {
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
            // Restows to .stopped first because the engine already stopped and review owns the retry.
            restow(id: recording.id, state: .stopped, origin: origin)
            transcribeHint = cloudMode ? "Configure voice input on your cloud server in Settings" : "Add your Groq API key to use voice input"
            chatStore?.haptics.fire(.soft)
            chatStore?.settingsPage = .voice
            chatStore?.isSettingsPresented = true
            return
        }
        // Only one transcription runs at a time; banner uploads must not disturb activeRecording.
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
                        self?.transcriptionNotice = nil
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
        // Nil transcribeOrigin means deleted mid-flight; bail out so sidecar/draft never resurrect.
        guard transcribeOrigin != nil else {
            refreshRecoverables()
            return
        }
        transcriptionTask = nil
        transcribingID = nil
        transcriptionProgress = nil
        transcriptionNotice = nil
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
            // Treats empty transcription as a retryable failure and preserves the audio.
            handleTranscriptionFailure(id: id, error: .server(message: "Transcription was empty"), origin: origin)
            return
        }
        // Match activeRecording by ID so a banner completion never mutates a live recording.
        let activeMatch = activeRecording?.id == id ? activeRecording : nil
        var done = store.load(id: id) ?? activeMatch ?? VoiceRecording(
            id: id, conversationID: UUID(), state: .transcribed, createdAt: Date(),
            duration: elapsed, fileName: id.uuidString + ".m4a", transcriptPreview: nil)
        done.state = .transcribed
        done.transcriptPreview = String(text.prefix(120))
        store.save(done)
        // Deposits transcript into the recording's originating chat even if the user switched chats.
        if let chatStore {
            chatStore.depositToDraft(text: text, conversationID: done.conversationID)
        }
        insertedTranscripts.append((id: id, text: text, conversationID: done.conversationID))
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
            restow(id: id, state: .stopped, origin: origin)
            return
        }
        switch error {
        case .missingKey:
            restow(id: id, state: .stopped, origin: origin)
            transcribeHint = cloudMode ? "Configure voice input on your cloud server in Settings" : "Add your Groq API key to use voice input"
            chatStore?.haptics.fire(.soft)
            chatStore?.isSettingsPresented = true
        case .consentRequired(let host):
            // Holds recording as .queued for consent; allowing retries it while declining preserves audio.
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
            showFailure(cloudMode ? "Sign in to your cloud server to transcribe" : "Check your Groq API key", id: id, origin: origin)
            chatStore?.isSettingsPresented = true
        case .tooLarge:
            restow(id: id, state: .failed, origin: origin)
            showFailure("This recording is too large to transcribe", id: id, origin: origin)
        case .rateLimited:
            restow(id: id, state: .failed, origin: origin)
            showFailure("Rate limited — try again shortly", id: id, origin: origin)
        case .offline:
            // Persists .queued in the sidecar so Retry or network recovery can resume across launches.
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

    private func restow(id: UUID, state: VoiceRecordingState, origin: TranscribeOrigin?) {
        if var current = store.load(id: id) {
            current.state = state
            store.save(current)
            if activeRecording?.id == id { activeRecording = current }
        }
        if origin == .active || origin == .review {
            phase = .review
        }
        refreshRecoverables()
    }

    private func showFailure(_ message: String, id: UUID, origin: TranscribeOrigin?) {
        errorMessage = message
        errorRecordingID = origin == .banner ? id : nil
    }

    // MARK: Sent-message rule (VoiceSendObserver)

    /// Deletes recordings matched in a send from their own deposit chat; never wipes other chats.
    func noteDidSend(text: String) {
        guard !insertedTranscripts.isEmpty else { return }
        let sent = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sent.isEmpty else { return }
        let from = chatStore?.selectedID
        let due = insertedTranscripts.filter {
            !$0.text.isEmpty && $0.conversationID == from && sent.contains($0.text)
        }
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

    /// Persists sidecar metadata on backgrounding while the audio background mode keeps recording.
    func appDidEnterBackground() {
        if let active = activeRecording, phase == .recording || isPausedPhase {
            var snap = active
            snap.duration = engine?.currentTime ?? elapsed
            store.save(snap)
        }
    }

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

    /// Reloads banner/list on chat switch; scan exclusion shields active sidecars from normalization.
    func refreshRecoverables() {
        var bannerExcluded: Set<UUID> = []
        if let active = activeRecording {
            if phase != .review || active.conversationID == chatStore?.selectedID {
                bannerExcluded.insert(active.id)
            }
        }
        if let transcribing = transcribingID { bannerExcluded.insert(transcribing) }
        recoverable = stitched(excluding: bannerExcluded, includeTranscribed: false)

        var listExcluded: Set<UUID> = []
        if let active = activeRecording, phase == .recording || isPausedPhase {
            // Excludes live recording from Settings list so users cannot delete or upload a growing file.
            listExcluded.insert(active.id)
        }
        if let transcribing = transcribingID { listExcluded.insert(transcribing) }
        listRecordings = stitched(excluding: listExcluded, includeTranscribed: true)
    }

    private func stitched(excluding: Set<UUID>, includeTranscribed: Bool) -> [VoiceRecording] {
        var list = store.scan(excluding: excluding, includeTranscribed: includeTranscribed)
        if let tid = transcribingID,
           !list.contains(where: { $0.id == tid }),
           let inFlight = store.load(id: tid) ?? (activeRecording?.id == tid ? activeRecording : nil) {
            list.append(inFlight)
        }
        return list.sorted { $0.createdAt > $1.createdAt }
    }
}

/// NSObject delegate proxy so VoiceInputController stays a plain @Observable class.
@MainActor
final class VoicePlaybackDelegate: NSObject, AVAudioPlayerDelegate {
    var onFinish: (@MainActor () -> Void)?

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in self?.onFinish?() }
    }
}

// MARK: - Until voice-groq lands

/// Placeholder transcriber that routes transcription attempts to Settings when unconfigured.
struct UnconfiguredTranscriber: Transcriber, Sendable {
    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript {
        throw VoiceTranscriptionError.missingKey
    }
}

/// Placeholder VoiceSettingsReader reporting unconfigured so transcription routes to Settings.
struct UnconfiguredVoiceSettings: VoiceSettingsReader, Sendable {
    var isConfigured: Bool { false }
}

#if DEBUG
/// Test transcriber honoring cancellation; enabled in UI tests via -PraxisFakeTranscript.
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

struct FakeVoiceSettings: VoiceSettingsReader, Sendable {
    var isConfigured: Bool
}

extension VoiceInputController {
    static func fakeTranscriptText(arguments: [String] = ProcessInfo.processInfo.arguments) -> String? {
        guard let i = arguments.firstIndex(of: "-PraxisFakeTranscript") else { return nil }
        let next = arguments.index(after: i)
        if next < arguments.endIndex, !arguments[next].hasPrefix("-") {
            return arguments[next]
        }
        return "Test transcription"
    }

    /// Parses -PraxisFakeRecording fixture path to bypass real mic capture in UI tests.
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

    /// Seeds simulated elapsed seconds so >10 s cancel-confirmation UI tests run instantly.
    static func fakeElapsed(arguments: [String] = ProcessInfo.processInfo.arguments) -> TimeInterval {
        guard let i = arguments.firstIndex(of: "-PraxisFakeElapsed") else { return 0 }
        let next = arguments.index(after: i)
        guard next < arguments.endIndex, let value = TimeInterval(arguments[next]) else { return 0 }
        return max(0, value)
    }
}
#endif
