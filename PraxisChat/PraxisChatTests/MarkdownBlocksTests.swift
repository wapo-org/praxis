import XCTest
@testable import PraxisChat

/// Block-level markdown: GFM tables, and the blocks that used to vanish
/// (nested list content, task items, quotes holding lists, raw HTML).
final class MarkdownBlocksTests: XCTestCase {

    private func plain(_ s: AttributedString) -> String { String(s.characters) }

    private func table(_ source: String) -> MDTable? {
        for block in PraxisMarkdown.parse(source) { if case .table(let t) = block { return t } }
        return nil
    }

    // MARK: Tables

    func testTableParsesHeaderRowsAndAlignment() throws {
        let t = try XCTUnwrap(table("""
            Intro paragraph.

            | Day | Meal | Calories |
            |:----|:----:|---------:|
            | Mon | Oats | 350 |
            | Tue | **Eggs** and `toast` | 420 |
            """))
        XCTAssertEqual(t.columnCount, 3)
        XCTAssertEqual(t.alignments, [.leading, .center, .trailing])
        XCTAssertEqual(t.header.map(plain), ["Day", "Meal", "Calories"])
        XCTAssertEqual(t.rows.map { $0.map(plain) }, [["Mon", "Oats", "350"], ["Tue", "Eggs and toast", "420"]])
        // Inline formatting survives in cells: the code span is a pill.
        XCTAssertTrue(t.rows[1][1].runs.contains { $0[PillTextAttribute.self] != nil })
    }

    func testTableIsItsOwnBlockBetweenParagraphs() {
        let blocks = PraxisMarkdown.parse("Here's a table:\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nWant changes?")
        XCTAssertEqual(blocks.count, 3)
        guard case .paragraph = blocks[0], case .table = blocks[1], case .paragraph = blocks[2] else {
            return XCTFail("expected paragraph, table, paragraph: \(blocks.map(\.id))")
        }
    }

    func testRaggedRowsArePaddedAndTrimmedToTheHeader() throws {
        let t = try XCTUnwrap(table("| A | B | C |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |"))
        XCTAssertEqual(t.rows.map(\.count), [3, 3])
        XCTAssertEqual(t.rows[0].map(plain), ["1", "", ""])
        XCTAssertEqual(t.rows[1].map(plain), ["1", "2", "3"])
        XCTAssertEqual(t.alignments, [.leading, .leading, .leading], "no colons: leading")
    }

    func testHeaderIsBoldAndBodyIsNot() throws {
        let t = try XCTUnwrap(table("| Name |\n|---|\n| Ada |"))
        XCTAssertEqual(t.header[0].runs.first?.font, Type.inter(15, weight: .semibold))
        XCTAssertEqual(t.rows[0][0].runs.first?.font, Type.inter(15, weight: .regular))
    }

    func testBreakTagInACellIsALineBreak() throws {
        let t = try XCTUnwrap(table("| Notes |\n|---|\n| one<br>two |"))
        XCTAssertEqual(plain(t.rows[0][0]), "one\ntwo")
    }

    func testTableCellsStampTheRevealInOrder() throws {
        let t = try XCTUnwrap(table("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |"))
        let fades = (t.header + t.rows.flatMap { $0 }).compactMap { $0.runs.first?[ChipFadeAttribute.self]?.index }
        XCTAssertEqual(fades, fades.sorted(), "cells reveal left to right, top to bottom")
        XCTAssertEqual(t.lastRowFadeStart, fades[4], "the last row starts at its first cell")
    }

    func testColumnWidthsFillTheProposalOrCapForScrolling() {
        let natural: [CGFloat] = [40, 600, 80]
        // Ideal (nil) and too-narrow proposals: capped, the table scrolls.
        XCTAssertEqual(TableGrid.columnWidths(natural: natural, proposed: nil), [40, TableGrid.maxColumnWidth, 80])
        XCTAssertEqual(TableGrid.columnWidths(natural: natural, proposed: 200), [40, TableGrid.maxColumnWidth, 80])
        // A wider proposal goes to the wrapped column first, then evenly.
        let wide = TableGrid.columnWidths(natural: natural, proposed: 400)
        XCTAssertEqual(wide.reduce(0, +), 400, accuracy: 0.01)
        XCTAssertEqual(wide[0], 40, accuracy: 0.01)
        XCTAssertEqual(wide[1], 280, accuracy: 0.01)
        let wider = TableGrid.columnWidths(natural: [40, 60], proposed: 300)
        XCTAssertEqual(wider, [140, 160])
    }

    // MARK: Streaming tables

    func testStreamingHidesTheHeaderUntilItIsATable() {
        var md = IncrementalMarkdown("Plan:\n\n| Day | Meal |")
        XCTAssertEqual(md.document.blocks.count, 1, "a lone header row is not shown as pipes")
        md.append("\n|---|---|\n| Mon | Oa")
        guard case .table(let t)? = md.document.blocks.last?.block else {
            return XCTFail("expected a table once the delimiter row arrived")
        }
        XCTAssertTrue(t.rows.isEmpty, "the half-typed row waits")
        md.append("ts |\n")
        guard case .table(let done)? = md.document.blocks.last?.block else { return XCTFail() }
        XCTAssertEqual(done.rows.map { $0.map(plain) }, [["Mon", "Oats"]])
    }

    func testStreamingRevealStopsBeforeTheHeldBackRow() {
        let md = IncrementalMarkdown("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4")
        guard case .table(let t)? = md.document.blocks.last?.block else { return XCTFail() }
        XCTAssertEqual(t.rows.count, 1)
        let full = PraxisMarkdown.document("| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4")
        XCTAssertLessThan(md.document.revealLength, full.revealLength)
    }

    // MARK: Blocks that used to disappear

    func testNestedListContentIsKept() {
        let blocks = PraxisMarkdown.parse("""
            1. First
               - nested a
               - nested b
            2. Second

               ```swift
               let x = 1
               ```
            """)
        guard case .list(true, 1, let items) = blocks.first else { return XCTFail("\(blocks)") }
        XCTAssertEqual(items.map { plain($0.text) }, ["First", "Second"])
        guard case .list(false, _, let nested)? = items[0].children.first else {
            return XCTFail("nested list dropped")
        }
        XCTAssertEqual(nested.map { plain($0.text) }, ["nested a", "nested b"])
        guard case .code(let language, let code)? = items[1].children.first else {
            return XCTFail("code fence in a list item dropped")
        }
        XCTAssertEqual(language, "swift")
        XCTAssertEqual(code, "let x = 1")
    }

    func testOrderedListKeepsItsStartAndTaskItemsTheirState() {
        guard case .list(true, 3, _) = PraxisMarkdown.parse("3. three\n4. four").first else {
            return XCTFail("start number lost")
        }
        guard case .list(false, _, let items) = PraxisMarkdown.parse("- [x] done\n- [ ] todo\n- plain").first else {
            return XCTFail()
        }
        XCTAssertEqual(items.map(\.checked), [true, false, nil])
        XCTAssertEqual(items.map { plain($0.text) }, ["done", "todo", "plain"])
    }

    func testQuoteKeepsListsAndCode() {
        guard case .quote(let inner) = PraxisMarkdown.parse("> Note:\n>\n> - one\n> - two\n>\n> ```\n> x\n> ```").first else {
            return XCTFail()
        }
        XCTAssertEqual(inner.count, 3)
        guard case .paragraph = inner[0], case .list = inner[1], case .code = inner[2] else {
            return XCTFail("\(inner.map(\.id))")
        }
    }

    func testHTMLBlockReadsAsItsText() {
        let blocks = PraxisMarkdown.parse("<details>\n<summary>More</summary>\nHidden &amp; shown\n</details>\n\n<!-- note -->")
        XCTAssertEqual(blocks.count, 1, "the comment shows nothing")
        guard case .paragraph(let text) = blocks.first else { return XCTFail("\(blocks)") }
        XCTAssertEqual(plain(text), "More\nHidden & shown")
    }

    func testStrikethroughAndImagesAreNotLost() {
        guard case .paragraph(let text) = PraxisMarkdown.parse("~~old~~ new ![chart](https://x.dev/c.png)").first else {
            return XCTFail()
        }
        XCTAssertTrue(text.runs.contains { $0.strikethroughStyle != nil && String(text[$0.range].characters) == "old" })
        XCTAssertTrue(plain(text).contains("chart"), "an image reads as a link with its alt text")
    }
}
