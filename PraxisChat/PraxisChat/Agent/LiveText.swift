import Foundation
import Observation
import SwiftUI

/// Holds incremental parse and reveal state per block so streaming skips transcript diffs.
@MainActor
@Observable
final class LiveText {
    let id: UUID
    private(set) var document = MDDocument.empty
    private(set) var isStreaming = true
    private(set) var blockCount = 0
    private(set) var revealed: Double = 0
    /// Sampled on a 30 Hz timeline instead of every display frame.
    private(set) var motion = RevealMotion.idle
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

    /// Reparses finished source once to catch cross-block restyling like setext headings.
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
        // Single debounced sleeper pauses row timelines after the reveal settles.
        settleTask = Task { [weak self] in
            while let wait = self?.motion.end.timeIntervalSinceNow, wait > 0 {
                try? await Task.sleep(for: .seconds(wait))
            }
            self?.isRevealing = false
            self?.settleTask = nil
        }
    }
}

/// Closed-form critically damped spring sampled at 30 Hz so scrolling stays cheap.
struct RevealMotion: Equatable {
    var from: Double
    var velocity: Double
    var to: Double
    var start: Date

    static let idle = RevealMotion(from: 0, velocity: 0, to: 0, start: .distantPast)
    static let omega = 2 * Double.pi / 0.45
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

    func touches(_ lower: Double, _ upper: Double) -> Bool {
        min(from, to) < upper && max(from, to) > lower
    }
}
