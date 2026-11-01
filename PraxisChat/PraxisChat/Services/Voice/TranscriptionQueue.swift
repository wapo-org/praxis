import Foundation
import Network

/// Is there a usable network right now, and if not, suspend until there is.
/// `NWPathMonitor`-backed in production, scripted in tests.
protocol NetworkStatusReader: Sendable {
    func isUsable() async -> Bool
    /// Returns when the path is usable. Throws `CancellationError` when the
    /// waiting task is cancelled. Never returns while unusable.
    func waitForUsable() async throws
}

/// `NWPathMonitor` as a `NetworkStatusReader`. The monitor dies with the
/// actor (release stops callbacks); no explicit cancel needed.
actor PathMonitorNetworkStatus: NetworkStatusReader {
    private let monitor: NWPathMonitor
    private var usable = false
    private var waiters: [UUID: CheckedContinuation<Void, Error>] = [:]

    init(queueLabel: String = "PraxisChat.voiceNetwork") {
        monitor = NWPathMonitor()
        let queue = DispatchQueue(label: queueLabel)
        monitor.pathUpdateHandler = { [weak self] path in
            let usable = path.status == .satisfied
            Task { await self?.update(usable: usable) }
        }
        monitor.start(queue: queue)
    }

    private func update(usable: Bool) {
        self.usable = usable
        guard usable, !waiters.isEmpty else { return }
        let pending = waiters
        waiters.removeAll()
        for continuation in pending.values { continuation.resume() }
    }

    func isUsable() async -> Bool { usable }

    func waitForUsable() async throws {
        if usable { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                waiters[id] = continuation
                // Already cancelled while storing: resume right away so no
                // waiter dangles (the onCancel below may have run first).
                if Task.isCancelled {
                    waiters.removeValue(forKey: id)
                    continuation.resume(throwing: CancellationError())
                }
            }
        } onCancel: {
            Task { await self.cancelWaiter(id) }
        }
    }

    private func cancelWaiter(_ id: UUID) {
        guard let continuation = waiters.removeValue(forKey: id) else { return }
        continuation.resume(throwing: CancellationError())
    }
}

/// Retry/backoff/offline policy around Groq uploads. One `run` retries 429s
/// (honouring `retry-after`), 5xx and transient network failures with
/// exponential backoff (1 s, 2 s, 4 s … max 60 s, ~5 attempts), and suspends
/// — without consuming attempts — while the network is unusable. Auth,
/// consent, key, oversize and cancellation errors pass straight through:
/// 413-halving is the transcriber's job (it owns the parts), and auth/user
/// errors must surface, never spin.
actor TranscriptionQueue {
    enum QueueEvent: Sendable, Equatable {
        case waitingForNetwork
        case retrying(attempt: Int, after: TimeInterval)
    }

    static let maxAttempts = 5
    static let maxDelay: TimeInterval = 60

    private let network: any NetworkStatusReader
    private let sleep: @Sendable (Duration) async throws -> Void

    init(network: (any NetworkStatusReader)? = nil,
         sleep: (@Sendable (Duration) async throws -> Void)? = nil) {
        self.network = network ?? PathMonitorNetworkStatus()
        self.sleep = sleep ?? { try await Task.sleep(for: $0) }
    }

    /// Delay before attempt `attempt` (1-based): the server's `retry-after`
    /// when given, else exponential backoff, capped at 60 s. Pure.
    nonisolated static func backoffDelay(attempt: Int, retryAfter: TimeInterval?) -> TimeInterval {
        if let after = retryAfter, after.isFinite, after >= 0 { return min(after, maxDelay) }
        return min(pow(2.0, Double(max(0, attempt - 1))), maxDelay)
    }

    func run<T: Sendable>(_ operation: @Sendable () async throws -> T,
                          onEvent: (@Sendable (QueueEvent) -> Void)? = nil) async throws -> T {
        var attempt = 0
        while true {
            do {
                return try await operation()
            } catch is CancellationError {
                throw CancellationError()
            } catch let error as VoiceTranscriptionError {
                switch error {
                case .rateLimited(let retryAfter):
                    attempt += 1
                    guard attempt < Self.maxAttempts else { throw error }
                    try await pause(attempt: attempt, retryAfter: retryAfter, onEvent: onEvent)
                case .server:
                    attempt += 1
                    guard attempt < Self.maxAttempts else { throw error }
                    try await pause(attempt: attempt, retryAfter: nil, onEvent: onEvent)
                case .offline:
                    if await network.isUsable() {
                        // A blip with the path up: bounded backoff, not a wait.
                        attempt += 1
                        guard attempt < Self.maxAttempts else { throw error }
                        try await pause(attempt: attempt, retryAfter: nil, onEvent: onEvent)
                    } else {
                        // Sustained outage: suspend (no attempt consumed)
                        // and auto-retry when the path is usable again. The
                        // controller shows "Waiting for network…" and restows
                        // the sidecar `.queued` (persisted: a relaunch lists
                        // it with Retry, and the part cache resumes), so the
                        // wait is never a silent stuck "Transcribing…".
                        // Cancel stays responsive: it throws CancellationError.
                        onEvent?(.waitingForNetwork)
                        try await network.waitForUsable()
                    }
                case .missingKey, .consentRequired, .unauthorized, .tooLarge, .cancelled:
                    throw error
                }
            }
        }
    }

    private func pause(attempt: Int, retryAfter: TimeInterval?,
                       onEvent: (@Sendable (QueueEvent) -> Void)?) async throws {
        let delay = Self.backoffDelay(attempt: attempt, retryAfter: retryAfter)
        onEvent?(.retrying(attempt: attempt, after: delay))
        try await sleep(.milliseconds(Int(delay * 1000)))
    }
}
