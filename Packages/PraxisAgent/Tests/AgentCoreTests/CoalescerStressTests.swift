import Foundation
import Testing
@testable import AgentCore

/// Cancel-under-load stress for AgentEventCoalescer: rapid
/// produce/consume/cancel cycles must never hang, must keep event order,
/// and must not lose merged text. Each iteration runs under a watchdog so
/// a deadlock FAILS instead of hanging the suite.
@Suite struct CoalescerStressTests {
    /// Runs `body` with a watchdog: if it doesn't finish within `limit`,
    /// records a failure and returns nil instead of hanging forever.
    private func withWatchdog<T: Sendable>(
        _ what: String, limit: Duration = .seconds(10),
        body: @escaping @Sendable () async -> T
    ) async -> T? {
        let box = DoneBox()
        let task = Task {
            let result = await body()
            await box.mark()
            return result
        }
        let deadline = ContinuousClock.now + limit
        while await !box.done {
            if ContinuousClock.now > deadline {
                Issue.record("DEADLOCK? \(what) did not finish within \(limit)")
                task.cancel()
                return nil
            }
            try? await Task.sleep(for: .milliseconds(20))
        }
        return await task.value
    }

    @Test func rapidProduceConsumeCancelNeverHangs() async {
        for i in 0..<500 {
            var rng = XorShift(seed: 0x9E3779B9 &* UInt64(i &+ 1))
            // Same block = merge-heavy; alternating = every push flushes
            // the pending event first (yield-heavy, no merging possible).
            let alternating = i % 2 == 1
            // Two thirds of iterations cancel the consumer mid-stream at
            // a random moment; the rest drain fully and assert exactly.
            let cancel = i % 3 != 0
            let delay = cancel ? Duration.microseconds(rng.next(in: 0..<2000)) : nil
            guard let (sent, received) = await withWatchdog("iteration \(i)") {
                await Self.runOnce(alternating: alternating, cancelAfter: delay)
            } else {
                return
            }
            let sentJoined = sent.joined()
            var receivedJoined = ""
            for event in received {
                guard case .textDelta(_, let text) = event else {
                    Issue.record("iteration \(i): unexpected event \(event)")
                    return
                }
                receivedJoined += text
            }
            if delay == nil {
                #expect(receivedJoined == sentJoined)
                if alternating { #expect(received.count == sent.count) }
            } else {
                // Cancelled mid-stream: what arrived must be an exact
                // prefix of what was sent (order kept, nothing lost).
                #expect(sentJoined.hasPrefix(receivedJoined))
            }
        }
    }

    /// One burst: a fast producer pushes `count` text deltas, a pump-like
    /// consumer (no cancellation check, like EventInbox.pump) reads the
    /// coalesced stream, and the consumer task is cancelled after
    /// `cancelAfter` (nil = drain fully).
    private static func runOnce(alternating: Bool, cancelAfter: Duration?) async -> ([String], [AgentEvent]) {
        let count = 200
        let sent = (0..<count).map { "t\($0);" }
        let (upstream, uc) = AsyncStream<AgentEvent>.makeStream()
        let coalesced = AgentEventCoalescer.coalesce(upstream, interval: .milliseconds(1))
        let producer = Task {
            for (j, text) in sent.enumerated() {
                let block = alternating ? (j % 2 == 0 ? "a" : "b") : "a"
                uc.yield(.textDelta(blockID: block, text: text))
            }
            uc.finish()
        }
        let consumer = Task<[AgentEvent], Never> {
            var out: [AgentEvent] = []
            for await event in coalesced { out.append(event) }
            return out
        }
        if let cancelAfter {
            try? await Task.sleep(for: cancelAfter)
            consumer.cancel()
        }
        let received = await consumer.value
        await producer.value
        return (sent, received)
    }
}

private actor DoneBox {
    var done = false
    func mark() { done = true }
}

/// Deterministic PRNG so a failing iteration reproduces.
private struct XorShift: Sendable {
    var state: UInt64
    init(seed: UInt64) { state = seed == 0 ? 0x2545F4914F6CDD1D : seed }
    mutating func next() -> UInt64 {
        var x = state
        x ^= x << 13
        x ^= x >> 7
        x ^= x << 17
        state = x
        return x
    }
    mutating func next(in range: Range<Int64>) -> Int64 {
        let span = UInt64(range.upperBound - range.lowerBound)
        return range.lowerBound + Int64(next() % span)
    }
}
