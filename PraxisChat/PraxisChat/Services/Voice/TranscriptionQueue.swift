import Foundation
import Network

protocol NetworkStatusReader: Sendable {
    func isUsable() async -> Bool
    /// Suspends until the network path is usable or throws CancellationError on task cancel.
    func waitForUsable() async throws
}

/// Deallocating the actor stops NWPathMonitor callbacks without needing explicit cancellation.
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
                // Re-checks cancellation after storing continuation because onCancel may have already fired.
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

/// Retries 429/5xx/transient errors with backoff and suspends offline without burning attempts.
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

    /// Computes delay for 1-based attempt using retryAfter or exponential backoff, capped at 60 s.
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
                        attempt += 1
                        guard attempt < Self.maxAttempts else { throw error }
                        try await pause(attempt: attempt, retryAfter: nil, onEvent: onEvent)
                    } else {
                        // Notifies UI before suspending so offline waits persist .queued without consuming attempts.
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
