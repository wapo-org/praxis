import XCTest
@testable import PraxisChat

final class MarkdownChipTests: XCTestCase {

    func testCodeSpanBecomesCodePillRun() {
        let blocks = PraxisMarkdown.parse("Pair it with `safeAreaBar` so the composer works.")
        guard case .paragraph(let text) = blocks.first else {
            return XCTFail("expected a paragraph, got \(blocks)")
        }
        let pillRuns = text.runs.filter { $0[PillTextAttribute.self] != nil }
        XCTAssertEqual(pillRuns.count, 1)
        XCTAssertEqual(pillRuns.first.map { String(text[$0.range].characters) }, "safeAreaBar")
    }

    func testFileRefAndLinkRefRunsAreMarked() {
        let blocks = PraxisMarkdown.parse(
            "See [ComposerView.swift](praxis-file://ComposerView.swift) and the [agent activity spec](https://wapo-dp.vercel.app/#/components/agent-activity).")
        guard case .paragraph(let text) = blocks.first else {
            return XCTFail("expected a paragraph, got \(blocks)")
        }
        let tiles = text.runs.compactMap { $0[TileTextAttribute.self]?.monogram }
        XCTAssertTrue(tiles.contains("file-code-2"), "file tile glyph missing: \(tiles)")
        XCTAssertTrue(tiles.contains("A"), "link monogram tile missing: \(tiles)")
        let fileRun = text.runs.first { String(text[$0.range].characters) == "ComposerView.swift" }
        XCTAssertEqual(fileRun?.link?.scheme, "praxis-file")
    }

    func testChipSegmentsCarryLayoutMarkers() {
        // Renderer reads Text.Layout markers via Text.customAttribute, so segments must classify chips.
        let blocks = PraxisMarkdown.parse("Run `xcodebuild build` in [GitHub](praxis-app://GitHub).")
        guard case .paragraph(let text) = blocks.first else {
            return XCTFail("expected a paragraph, got \(blocks)")
        }
        let kinds = PraxisMarkdown.chipSegments(in: text).map(\.kind)
        XCTAssertTrue(kinds.contains(.pill), "missing pill segment: \(kinds)")
        XCTAssertTrue(kinds.contains(.tile), "missing tile segment: \(kinds)")
    }

    func testDurationFormatting() {
        XCTAssertEqual(DurationFormatter.format(22), "22s")
        XCTAssertEqual(DurationFormatter.format(231), "3m 51s")
    }
}
