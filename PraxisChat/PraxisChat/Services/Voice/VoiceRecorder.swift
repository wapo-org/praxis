import Foundation
import AVFoundation

/// Engine reports raw events without policy decisions so controller state can be test-driven.
enum VoiceRecorderEvent: Sendable, Equatable {
    case interrupted
    case interruptionEnded
    case routeLost
    case routeRestored
    case failed(message: String)
}

/// Main-actor audio input abstraction because AVAudioRecorder must be driven from one thread.
@MainActor
protocol VoiceRecorderEngine: AnyObject {
    var isRecording: Bool { get }
    var isPaused: Bool { get }
    /// Captured audio duration in seconds, excluding paused time.
    var currentTime: TimeInterval { get }
    /// Normalized 0...1 input level refreshed by updateMeters().
    var level: Float { get }
    var eventHandler: (@MainActor (VoiceRecorderEvent) -> Void)? { get set }

    func requestPermission() async -> Bool
    /// Streams AAC 16 kHz mono (~32 kbps) directly to fileURL.
    func start(fileURL: URL) throws
    func pause()
    func resume() throws
    func stop()
    func updateMeters()
}

/// AVAudioRecorder wrapper streaming directly to final .m4a so disk audio is crash-safe truth.
@MainActor
final class AVAudioVoiceRecorder: NSObject, VoiceRecorderEngine, AVAudioRecorderDelegate {
    private(set) var isRecording = false
    private(set) var isPaused = false
    private(set) var level: Float = 0
    var eventHandler: (@MainActor (VoiceRecorderEvent) -> Void)?

    var currentTime: TimeInterval { recorder?.currentTime ?? 0 }

    private var recorder: AVAudioRecorder?
    /// Written in init and removed in deinit (thread-safe), justifying nonisolated(unsafe).
    private nonisolated(unsafe) var observers: [NSObjectProtocol] = []

    /// AAC 16 kHz mono (~32 kbps, ~14 MB/hr) matches server downsampling with minimal size.
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
                // Extracts Sendable integer before Task hop because Notification is non-Sendable.
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
        // Captures observers for thread-safe removal in deinit without crossing actor isolation.
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
        // Reactivates AVAudioSession so route changes during pause (e.g., AirPods) take effect.
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
        // Maps averagePower (-50 dB silence to 0 dB peak) on a curve so speech stays mid-meter.
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
            // Keeps recording across input device switches; pauses only when no audio input remains.
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

/// Start/resume error type that never exposes file paths or audio session internals.
enum VoiceRecorderStartError: Error, Sendable {
    case couldNotStart
}

#if DEBUG
/// No-mic UI test engine (-PraxisFakeRecording) that auto-grants mic and stages a fixture on stop.
@MainActor
final class SimulatedVoiceRecorder: VoiceRecorderEngine {
    private(set) var isRecording = false
    private(set) var isPaused = false
    private(set) var level: Float = 0
    var eventHandler: (@MainActor (VoiceRecorderEvent) -> Void)?

    /// Audio fixture staged on stop, or nil to generate a silent placeholder file.
    let fixtureURL: URL?
    private var startedAt: Date?
    private var accumulated: TimeInterval
    private var tick: Timer?

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
