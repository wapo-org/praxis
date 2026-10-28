import Foundation
import AVFoundation

/// Events a recording engine reports to the controller. The engine never
/// decides policy (pause vs stop vs message) — it reports, the controller
/// acts, so fakes can drive the same state machine in tests.
enum VoiceRecorderEvent: Sendable, Equatable {
    /// Interruption began (call, Siri, alarm): controller pauses + persists.
    case interrupted
    /// Interruption ended. The controller does NOT auto-resume (the user
    /// may be mid-call); it offers resume.
    case interruptionEnded
    /// The input vanished (e.g. unplugged headset mic, route lost): pause
    /// with "Microphone disconnected — tap to resume", keep the file.
    case routeLost
    /// An input is available again after a loss.
    case routeRestored
    /// The recorder failed (disk full, encode error): stop, keep the file.
    case failed(message: String)
}

/// The surface `VoiceInputController` needs from audio input. Production
/// is `AVAudioVoiceRecorder`; tests inject a fake; UI tests use the DEBUG
/// `SimulatedVoiceRecorder` via `-PraxisFakeRecording`. All main-actor:
/// AVAudioRecorder is driven from one thread only.
@MainActor
protocol VoiceRecorderEngine: AnyObject {
    var isRecording: Bool { get }
    var isPaused: Bool { get }
    /// Seconds of audio captured (pauses excluded), for elapsed time.
    var currentTime: TimeInterval { get }
    /// 0…1 level after `updateMeters()`, for the meter.
    var level: Float { get }
    var eventHandler: (@MainActor (VoiceRecorderEvent) -> Void)? { get set }

    /// Mic permission. Real engine asks AVAudioSession; fakes answer.
    func requestPermission() async -> Bool
    /// Starts recording straight to `fileURL` (AAC 16 kHz mono ~32 kbps).
    func start(fileURL: URL) throws
    func pause()
    func resume() throws
    func stop()
    /// Refreshes `level` (and `currentTime`); the controller polls ~10/s.
    func updateMeters()
}

/// `AVAudioRecorder` wrapper (VOICE_PLAN.md §2): session, interruptions,
/// routes, metering. Writes DIRECTLY to the final `.m4a` — the file on
/// disk is the crash-safe truth; the sidecar only describes it.
@MainActor
final class AVAudioVoiceRecorder: NSObject, VoiceRecorderEngine, AVAudioRecorderDelegate {
    private(set) var isRecording = false
    private(set) var isPaused = false
    private(set) var level: Float = 0
    var eventHandler: (@MainActor (VoiceRecorderEvent) -> Void)?

    var currentTime: TimeInterval { recorder?.currentTime ?? 0 }

    private var recorder: AVAudioRecorder?
    /// Set once in init (before publication), read in deinit; removal is
    /// thread-safe, so no isolation needed.
    private nonisolated(unsafe) var observers: [NSObjectProtocol] = []

    /// AAC 16 kHz mono ~32 kbps → ~14 MB/hour (plan §2). The server
    /// downsamples to 16 kHz mono anyway, so nothing is lost.
    private static func audioSettings() -> [String: Any] {
        [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32_000,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
    }

    override init() {
        super.init()
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) {
                [weak self] note in
                // Notification isn't Sendable: pull the reason out here
                // (main queue already) and hop with a plain value.
                let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
                Task { @MainActor [weak self] in self?.handleInterruption(rawValue: raw) }
            },
            center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) {
                [weak self] note in
                let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
                Task { @MainActor [weak self] in self?.handleRouteChange(rawValue: raw) }
            },
        ]
    }

    deinit {
        // Tokens hold weak self and removal is thread-safe; the recorder
        // lives as long as the controller anyway (app lifetime).
        let captured = observers
        for token in captured { NotificationCenter.default.removeObserver(token) }
    }

    // MARK: Permission

    func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    // MARK: Transport

    func start(fileURL: URL) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [])
        try session.setActive(true, options: [])
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        // A stale file at this URL must not be appended to or resurrected.
        try? FileManager.default.removeItem(at: fileURL)
        let recorder = try AVAudioRecorder(url: fileURL, settings: Self.audioSettings())
        recorder.delegate = self
        recorder.isMeteringEnabled = true
        guard recorder.record() else {
            try? session.setActive(false, options: [.notifyOthersOnDeactivation])
            throw VoiceRecorderStartError.couldNotStart
        }
        self.recorder = recorder
        isRecording = true
        isPaused = false
        level = 0
    }

    func pause() {
        guard isRecording, !isPaused else { return }
        recorder?.pause()
        isPaused = true
    }

    func resume() throws {
        guard isRecording, isPaused else { return }
        // The route may have changed while paused (AirPods case): wake
        // the session again so recording restarts on the current input.
        try AVAudioSession.sharedInstance().setActive(true, options: [])
        guard recorder?.record() == true else {
            throw VoiceRecorderStartError.couldNotStart
        }
        isPaused = false
    }

    func stop() {
        guard isRecording else { return }
        recorder?.stop()
        recorder = nil
        isRecording = false
        isPaused = false
        level = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    func updateMeters() {
        guard let recorder, isRecording, !isPaused else {
            if !isRecording { level = 0 }
            return
        }
        recorder.updateMeters()
        // averagePower: silence ≈ -50 dB … loud ≈ 0 dB. Clamp + curve so
        // speech sits mid-meter instead of pinned.
        let power = recorder.averagePower(forChannel: 0)
        let clamped = max(0, min(1, (power + 50) / 50))
        level = pow(clamped, 1.5)
    }

    // MARK: Interruptions + routes

    private func handleInterruption(rawValue: UInt?) {
        guard isRecording else { return }
        guard let raw = rawValue,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            eventHandler?(.interrupted)
        case .ended:
            eventHandler?(.interruptionEnded)
        @unknown default:
            break
        }
    }

    private func handleRouteChange(rawValue: UInt?) {
        guard isRecording else { return }
        guard let raw = rawValue,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        switch reason {
        case .oldDeviceUnavailable:
            // Keep recording when the new route still has an input
            // (device switch); pause only when no input remains.
            let inputs = AVAudioSession.sharedInstance().currentRoute.inputs
            if inputs.isEmpty {
                eventHandler?(.routeLost)
            }
        case .newDeviceAvailable:
            eventHandler?(.routeRestored)
        default:
            break
        }
    }

    // MARK: AVAudioRecorderDelegate

    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor [weak self] in
            self?.eventHandler?(.failed(message: error?.localizedDescription ?? "Encoding failed"))
        }
    }

    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        guard !flag else { return }
        Task { @MainActor [weak self] in
            guard let self, self.isRecording else { return }
            self.eventHandler?(.failed(message: "Recording stopped unexpectedly"))
        }
    }
}

/// `start`/`resume` failures. Never carries paths or session internals.
enum VoiceRecorderStartError: Error, Sendable {
    case couldNotStart
}

#if DEBUG
/// No-mic engine for UI tests (`-PraxisFakeRecording <path>`, plan §9).
/// Behaves like a live recording — elapsed ticks, the meter swings — but
/// captures nothing; `stop()` stages the bundled audio file as the result.
/// Permission is always granted, so tests never see a system prompt.
@MainActor
final class SimulatedVoiceRecorder: VoiceRecorderEngine {
    private(set) var isRecording = false
    private(set) var isPaused = false
    private(set) var level: Float = 0
    var eventHandler: (@MainActor (VoiceRecorderEvent) -> Void)?

    /// The fixture to stage on stop (nil → a silent placeholder file).
    let fixtureURL: URL?
    private var startedAt: Date?
    private var accumulated: TimeInterval
    private var tick: Timer?

    /// - `startOffset`: `-PraxisFakeElapsed` — begin with this much
    ///   elapsed already (cancel-confirm tests need > 10 s without
    ///   waiting 10 s).
    init(fixtureURL: URL?, startOffset: TimeInterval = 0) {
        self.fixtureURL = fixtureURL
        self.accumulated = max(0, startOffset)
    }

    var currentTime: TimeInterval {
        guard let startedAt else { return accumulated }
        return accumulated + Date().timeIntervalSince(startedAt)
    }

    func requestPermission() async -> Bool { true }

    func start(fileURL: URL) throws {
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        // Reserve the file: a real recording is already on disk while it runs.
        try? FileManager.default.removeItem(at: fileURL)
        _ = FileManager.default.createFile(atPath: fileURL.path, contents: Data())
        pendingURL = fileURL
        startedAt = Date()
        isRecording = true
        isPaused = false
        tick = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.swingMeter() }
        }
    }

    func pause() {
        guard isRecording, !isPaused else { return }
        accumulated = currentTime
        startedAt = nil
        isPaused = true
    }

    func resume() throws {
        guard isRecording, isPaused else { return }
        startedAt = Date()
        isPaused = false
    }

    func stop() {
        guard isRecording else { return }
        accumulated = currentTime
        startedAt = nil
        isRecording = false
        isPaused = false
        level = 0
        tick?.invalidate()
        tick = nil
        // Stage the fixture as the recorded audio.
        if let staged = pendingURL {
            try? FileManager.default.removeItem(at: staged)
            if let fixtureURL, FileManager.default.fileExists(atPath: fixtureURL.path) {
                try? FileManager.default.copyItem(at: fixtureURL, to: staged)
            } else {
                _ = FileManager.default.createFile(atPath: staged.path, contents: Data())
            }
            pendingURL = nil
        }
    }

    func updateMeters() {
        guard isRecording, !isPaused else {
            if !isRecording { level = 0 }
            return
        }
        swingMeter()
    }

    private var pendingURL: URL?

    private func swingMeter() {
        guard isRecording, !isPaused else { return }
        let t = Date().timeIntervalSinceReferenceDate
        level = 0.25 + 0.55 * Float(abs(sin(t * 2.3) * 0.6 + sin(t * 5.1) * 0.4))
    }
}
#endif
