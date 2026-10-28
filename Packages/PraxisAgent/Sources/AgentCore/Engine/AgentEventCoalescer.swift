import Foundation
import Synchronization

/// Merges bursts of streaming events (text, reasoning, tool input, console
/// output) and releases them at most once per `interval`, so the UI does
/// one update per frame instead of one per token. Non-mergeable events
/// flush whatever is pending first, so ordering is preserved. The flush
/// timer only runs while something is buffered: a run waiting on the
/// network or a long tool call costs no wake-ups.
public enum AgentEventCoalescer {
    public static func coalesce(_ upstream: AsyncStream<AgentEvent>,
                                interval: Duration = .milliseconds(33)) -> AsyncStream<AgentEvent> {
        AsyncStream(bufferingPolicy: .unbounded) { continuation in
            let buffer = Buffer(continuation, interval: interval)
            let reader = Task {
                for await event in upstream { buffer.push(event) }
                buffer.flush()
                buffer.cancelTimer()
                buffer.finish()
            }
            continuation.onTermination = { _ in
                reader.cancel()
                buffer.cancelTimer()
            }
        }
    }

    private final class Buffer: Sendable {
        private struct State {
            var pending: AgentEvent?
            /// Scheduled when an event is buffered; flushes `interval` later.
            var timer: Task<Void, Never>?
        }

        // Locking: `emit` is always taken before `state`, and the stream
        // is only touched while holding `emit`. `state` is held solely to
        // compute what to emit — never across `yield`/`finish`/`cancel`.
        // That used to deadlock: cancelling the consumer runs `onTermination`
        // (-> `cancelTimer`) synchronously while holding the consumer task's
        // status lock, and `yield` takes that same lock to resume the
        // consumer — so yielding while holding `state` wedged both threads.
        // Holding `emit` across compute-then-yield also keeps the reader's
        // pushes and the timer's flushes ordered with respect to each other.
        private let state = Mutex(State())
        private let emit = Mutex(())
        private let continuation: AsyncStream<AgentEvent>.Continuation
        private let interval: Duration

        init(_ continuation: AsyncStream<AgentEvent>.Continuation, interval: Duration) {
            self.continuation = continuation
            self.interval = interval
        }

        func push(_ event: AgentEvent) {
            emit.withLock {
                let due = state.withLock { s -> [AgentEvent] in
                    var due: [AgentEvent] = []
                    if let current = s.pending {
                        if let merged = AgentEventCoalescer.merge(current, event) {
                            s.pending = merged
                            return []
                        }
                        due.append(current)
                        s.pending = nil
                    }
                    if AgentEventCoalescer.isMergeable(event) {
                        s.pending = event
                        if s.timer == nil {
                            let interval = interval
                            s.timer = Task { [self] in
                                try? await Task.sleep(for: interval)
                                if !Task.isCancelled { flush(timerFired: true) }
                            }
                        }
                    } else {
                        due.append(event)
                    }
                    return due
                }
                for event in due { continuation.yield(event) }
            }
        }

        func flush(timerFired: Bool = false) {
            emit.withLock {
                let due = state.withLock { s -> AgentEvent? in
                    defer { if timerFired { s.timer = nil } }
                    let due = s.pending
                    s.pending = nil
                    return due
                }
                if let due { continuation.yield(due) }
            }
        }

        func cancelTimer() {
            let timer = state.withLock { s -> Task<Void, Never>? in
                defer { s.timer = nil }
                return s.timer
            }
            timer?.cancel()
        }

        /// Serialized with emission so no computed batch can be yielded
        /// after the finish and dropped.
        func finish() {
            emit.withLock { continuation.finish() }
        }
    }

    static func isMergeable(_ e: AgentEvent) -> Bool {
        switch e {
        case .textDelta, .reasoningDelta, .toolInputDelta: return true
        case .toolProgress(_, .output): return true
        default: return false
        }
    }

    static func merge(_ a: AgentEvent, _ b: AgentEvent) -> AgentEvent? {
        switch (a, b) {
        case (.textDelta(let x, let t1), .textDelta(let y, let t2)) where x == y:
            return .textDelta(blockID: x, text: t1 + t2)
        case (.reasoningDelta(let x, let t1), .reasoningDelta(let y, let t2)) where x == y:
            return .reasoningDelta(blockID: x, text: t1 + t2)
        case (.toolInputDelta(let x, let j1), .toolInputDelta(let y, let j2)) where x == y:
            return .toolInputDelta(id: x, json: j1 + j2)
        case (.toolProgress(let x, .output(let l1)), .toolProgress(let y, .output(let l2))) where x == y:
            return .toolProgress(id: x, .output(l1 + l2))
        default:
            return nil
        }
    }
}
