import XCTest
import AgentCore
@testable import PraxisChat

/// Incremental markdown must match a full parse and stay linear in time per streaming flush.
@MainActor
final class StreamingPerformanceTests: XCTestCase {

    static let longAnswer: String = {
        var parts: [String] = []
        var i = 0
        while parts.joined(separator: "\n\n").utf8.count < 20_000 {
            i += 1
            parts.append("## Section \(i)")
            parts.append("Paragraph \(i) explains the change in [ComposerView.swift](praxis-file://ComposerView.swift) with `sensoryFeedback` and a link to [the spec](https://wapo-dp.vercel.app/#/materials). It keeps going for a while so the block is realistically long and wraps over several lines.")
            parts.append("- first point \(i)\n- second point with `code`\n- third point")
            if i % 3 == 0 { parts.append("> A quote that sits between paragraphs \(i).") }
            if i % 4 == 0 { parts.append("```swift\nlet value = \(i)\nprint(value)\n```") }
        }
        return parts.joined(separator: "\n\n")
    }()

    static func chunks(of text: String, size: Int = 24) -> [String] {
        var out: [String] = []
        var current = ""
        for (n, character) in text.enumerated() {
            current.append(character)
            if current.count >= size - (n % 7) { out.append(current); current = "" }
        }
        if !current.isEmpty { out.append(current) }
        return out
    }

    func testIncrementalParseMatchesFullParse() {
        var parser = IncrementalMarkdown()
        let source = Self.longAnswer
        for chunk in Self.chunks(of: source, size: 40) { parser.append(chunk) }
        let full = PraxisMarkdown.document(source)
        XCTAssertEqual(parser.document.blocks.map(\.block.id), full.blocks.map(\.block.id))
        XCTAssertEqual(parser.document.revealLength, full.revealLength)
        XCTAssertEqual(parser.document.blocks.map(\.fadeEnd), full.blocks.map(\.fadeEnd))
    }

    func testFinishedBlocksKeepTheirRevision() {
        var parser = IncrementalMarkdown()
        parser.append("# Title\n\nFirst paragraph.\n\nSecond")
        let before = parser.document.blocks
        parser.append(" paragraph keeps growing")
        let after = parser.document.blocks
        XCTAssertEqual(before.count, 3)
        XCTAssertEqual(before[0], after[0], "finished heading is reused, not re-parsed")
        XCTAssertEqual(before[1], after[1])
        XCTAssertNotEqual(before[2], after[2], "the growing tail block re-parses")
    }

    func testLiveTextFinishFixesARestyledBlock() {
        let live = LiveText(id: UUID())
        live.append("Title\n")
        live.append("\nBody")
        live.finish("Title\n=====\n\nBody")
        guard case .heading? = live.document.blocks.first?.block else {
            return XCTFail("final parse should win: \(live.document.blocks.map(\.block))")
        }
        XCTAssertFalse(live.isStreaming)
    }

    func testLiveTextCountsBlocksAndAdvancesReveal() {
        let live = LiveText(id: UUID())
        live.append("# Title\n\nFirst")
        XCTAssertEqual(live.blockCount, 2)
        XCTAssertGreaterThanOrEqual(live.revealed, live.document.revealLength)
        live.append(" paragraph\n\nSecond")
        XCTAssertEqual(live.blockCount, 3)
        live.finish("# Title\n\nFirst paragraph\n\nSecond")
        XCTAssertEqual(live.blockCount, live.document.blocks.count)
        XCTAssertGreaterThanOrEqual(live.revealed, live.document.revealLength)
    }

    func testStreamingReplayPerformance() {
        let deltas = Self.chunks(of: Self.longAnswer)
        let batches = stride(from: 0, to: deltas.count, by: 8).map { Array(deltas[$0..<min($0 + 8, deltas.count)]) }
        measure(metrics: [XCTClockMetric()]) {
            var reducer = TurnReducer()
            var turn = Turn(userText: "Write it all")
            var live: LiveText?
            let now = Date()
            for batch in batches {
                var change = TurnReducer.Change()
                for text in batch {
                    change.merge(reducer.reduce(.textDelta(blockID: "1.0", text: text), into: &turn, at: now))
                }
                if let id = change.openedText.first { live = LiveText(id: id) }
                live?.append(change.appendedText.map(\.text).joined())
            }
            _ = reducer.reduce(.textFinished(blockID: "1.0"), into: &turn, at: now)
            XCTAssertEqual(live?.source.count, Self.longAnswer.count)
        }
    }

    func testFullReparseBaselinePerformance() {
        let deltas = Self.chunks(of: Self.longAnswer)
        let batches = stride(from: 0, to: deltas.count, by: 8).map { deltas[$0..<min($0 + 8, deltas.count)].joined() }
        measure(metrics: [XCTClockMetric()]) {
            var source = ""
            for batch in batches {
                source += batch
                _ = PraxisMarkdown.document(source)
            }
        }
    }

    // MARK: Reveal cadence (no per-display-frame animation)

    func testRevealMotionIsContinuousAndSettles() {
        let t0 = Date(timeIntervalSinceReferenceDate: 1000)
        let first = RevealMotion.idle.retargeted(to: 100, at: t0)
        XCTAssertEqual(first.value(at: t0), 0)
        let mid = t0.addingTimeInterval(0.1)
        let second = first.retargeted(to: 250, at: mid)
        XCTAssertEqual(second.value(at: mid), first.value(at: mid), accuracy: 1e-9)
        XCTAssertEqual(second.speed(at: mid), first.speed(at: mid), accuracy: 1e-9)
        var previous = second.value(at: mid)
        var date = mid
        while date < second.end {
            date = date.addingTimeInterval(RevealMotion.frameInterval)
            let value = second.value(at: date)
            XCTAssertGreaterThanOrEqual(value, previous - 1e-9)
            XCTAssertLessThanOrEqual(value, 250 + 1e-6)
            previous = value
        }
        XCTAssertEqual(second.value(at: second.end), 250)
        XCTAssertEqual(second.value(at: second.end.addingTimeInterval(-0.01)), 250, accuracy: 0.5,
                       "snapping at the settle time must be invisible")
    }

    /// 30 Hz reveal timelines run only while the front moves so settled answers cost zero frames.
    func testLiveTextStopsRevealingAfterTheFrontSettles() async throws {
        let live = LiveText(id: UUID())
        XCTAssertFalse(live.isRevealing)
        live.append("# Title\n\nFirst paragraph")
        XCTAssertTrue(live.isRevealing)
        XCTAssertEqual(live.motion.to, live.revealed)
        live.finish("# Title\n\nFirst paragraph")
        let deadline = Date().addingTimeInterval(3)
        while live.isRevealing, Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertFalse(live.isRevealing)
        XCTAssertEqual(live.motion.value(at: Date()), live.revealed)
    }

    /// Pulse and shimmer run in Core Animation on the render server, not as SwiftUI app frames.
    func testAmbientMotionRunsInCoreAnimation() {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 200, height: 100))
        let pulse = PulsingIconView()
        pulse.configure(name: "search", size: 14)
        let shimmer = ShimmerTextView(frame: CGRect(x: 0, y: 40, width: 150, height: 18))
        shimmer.configure(text: "Currently working…", font: .systemFont(ofSize: 13))
        window.addSubview(pulse)
        window.addSubview(shimmer)
        shimmer.layoutIfNeeded()
        XCTAssertNotNil(pulse.layer.animation(forKey: "pulse"))
        XCTAssertEqual(shimmer.layer.sublayers?.compactMap { $0.mask?.animation(forKey: "sweep") }.count, 1)
        pulse.removeFromSuperview()
        XCTAssertNil(pulse.layer.animation(forKey: "pulse"), "leaving the window ends the animation")
    }
}
