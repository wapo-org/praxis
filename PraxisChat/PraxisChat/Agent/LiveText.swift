import Foundation
import Observation
import SwiftUI

/// The text of one streaming markdown block, observed only by the rows
/// that render it: a streamed token re-renders that message and nothing
/// else — not its turn, not the transcript (which only reads
/// `blockCount`, so it re-renders once per new paragraph). Parsing
/// happens here, once per update and incrementally; the reveal front
/// lives and advances here too, so a row recreated mid-stream (scroll
/// recycling, switching chats) picks up where the reveal was instead of
/// fading the whole answer in again.
@MainActor
@Observable
final class LiveText {
    let id: UUID
    private(set) var document = MDDocument.empty
    private(set) var isStreaming = true
    /// Number of parsed blocks: the transcript's one row per block.
    private(set) var blockCount = 0
    /// Reveal target in characters: the parsed length plus the fade span.
    private(set) var revealed: Double = 0
    /// How the drawn front travels to `revealed`. Rows sample it on a
    /// 30 Hz timeline instead of animating it every display frame.
    private(set) var motion = RevealMotion.idle
    /// The front is still moving: rows' timelines run only while true.
    private(set) var isRevealing = false
    @ObservationIgnored private var settleTask: Task<Void, Never>?

    @ObservationIgnored private var parser = IncrementalMarkdown()

    init(id: UUID) {
        self.id = id
    }

    var source: String { parser.source }

    func append(_ text: String) {
        guard !text.isEmpty else { return }
        parser.append(text)
        document = parser.document
        documentChanged()
    }

    /// The block closed with its final source (trimmed). One full parse
    /// (cached, so the block renders from it after eviction too) checks
    /// the incremental result: markdown can restyle an earlier block
    /// after the fact (a setext underline turns a paragraph into a
    /// heading). When nothing differs the streamed blocks are kept, so
    /// finished paragraphs don't redraw.
    func finish(_ source: String) {
        let full = MarkdownCache.document(for: source)
        let same = full.blocks.count == document.blocks.count
            && zip(full.blocks, document.blocks).allSatisfy { $0.block.id == $1.block.id && $0.fadeEnd == $1.fadeEnd }
        if !same { document = full }
        isStreaming = false
        documentChanged()
    }

    private func documentChanged() {
        if blockCount != document.blocks.count { blockCount = document.blocks.count }
        let target = document.revealLength + ChipTextRenderer.fadeSpan
        guard target > revealed else { return }
        motion = motion.retargeted(to: target, at: Date())
        revealed = target
        if !isRevealing { isRevealing = true }
        guard settleTask == nil else { return }
        // One sleeper per motion burst (not per chunk): it waits until the
        // latest retarget has settled, then pauses the rows' timelines.
        settleTask = Task { [weak self] in
            while let wait = self?.motion.end.timeIntervalSinceNow, wait > 0 {
                try? await Task.sleep(for: .seconds(wait))
            }
            self?.isRevealing = false
            self?.settleTask = nil
        }
    }
}

/// The streaming reveal's soft front: the critically damped spring the
/// front used to be animated with (`.spring(response: 0.45,
/// dampingFraction: 1)`), solved in closed form. It retargets on every
/// chunk keeping its position and speed, so the front glides instead of
/// stepping. As a `withAnimation` it redrew the paragraph under the front
/// every display frame (60–120 Hz) for as long as text streamed; sampled
/// by the rows' 30 Hz timeline it redraws along the same curve, and stops
/// once the front settles.
struct RevealMotion: Equatable {
    var from: Double
    var velocity: Double
    var to: Double
    var start: Date

    static let idle = RevealMotion(from: 0, velocity: 0, to: 0, start: .distantPast)
    /// Natural frequency of a spring with a 0.45 s response.
    static let omega = 2 * Double.pi / 0.45
    /// The rows' redraw interval while the front moves.
    static let frameInterval: TimeInterval = 1.0 / 30.0
    /// By then the remaining distance is < 0.02% of the jump: snap to it.
    static let settleTime: TimeInterval = 0.8

    var end: Date { start.addingTimeInterval(Self.settleTime) }

    func value(at date: Date) -> Double {
        let t = date.timeIntervalSince(start)
        guard t > 0 else { return from }
        guard date < end else { return to }
        let d0 = from - to
        return to + (d0 + (velocity + Self.omega * d0) * t) * exp(-Self.omega * t)
    }

    func speed(at date: Date) -> Double {
        let t = date.timeIntervalSince(start)
        guard t > 0 else { return velocity }
        guard date < end else { return 0 }
        let c = velocity + Self.omega * (from - to)
        return (velocity - Self.omega * c * t) * exp(-Self.omega * t)
    }

    func retargeted(to target: Double, at date: Date) -> RevealMotion {
        RevealMotion(from: value(at: date), velocity: speed(at: date), to: target, start: date)
    }

    /// Whether the front crosses `range` on its way (rows outside it hold
    /// a constant clamped value and need no timeline).
    func touches(_ lower: Double, _ upper: Double) -> Bool {
        min(from, to) < upper && max(from, to) > lower
    }
}
