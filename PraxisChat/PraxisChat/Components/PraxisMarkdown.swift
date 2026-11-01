import Foundation
import SwiftUI
import Markdown
import Synchronization

// MARK: Custom text attributes (drawn by ChipTextRenderer, §9.2)

/// Layout-visible attribute values (read by `ChipTextRenderer` via
/// `run[Marker.self]`); the Keys register them on `AttributedString`.
struct PillMarker: TextAttribute {}
struct TileMarker: TextAttribute { var monogram: String = "" }
/// `index` is the run's character offset within the whole message, so the
/// streaming reveal sweeps one continuous front across every paragraph.
struct FadeMarker: TextAttribute { var index: Double = 0 }

enum PillTextAttribute: AttributedStringKey {
    typealias Value = PillMarker
    static let name = "praxis.pill"
}

enum TileTextAttribute: AttributedStringKey {
    typealias Value = TileMarker
    static let name = "praxis.tile"
}

enum ChipFadeAttribute: AttributedStringKey {
    typealias Value = FadeMarker
    static let name = "praxis.fadeIndex"
}

extension AttributeScopes {
    /// Registers the chip attributes so they survive into `Text` layout
    /// and can be read back by `ChipTextRenderer`.
    struct PraxisAttributes: AttributeScope {
        let praxisPill: PillTextAttribute
        let praxisTile: TileTextAttribute
        let praxisFade: ChipFadeAttribute
    }
}

// MARK: Block model — stable identities so finished blocks never re-layout (§8)

enum MDBlock: Identifiable {
    case heading(level: Int, text: AttributedString)
    case paragraph(AttributedString)
    case list(ordered: Bool, start: Int, items: [MDListItem])
    /// Paragraphs (at the quote's size) and whatever else the quote holds.
    case quote([MDBlock])
    case code(language: String?, code: String)
    case table(MDTable)
    case rule

    var id: String {
        switch self {
        case .heading(let l, let t): return "h\(l)-\(String(t.characters).hashValue)"
        case .paragraph(let t): return "p-\(String(t.characters).hashValue)"
        case .list(let o, let start, let items):
            return "l\(o)-\(start)-\(items.count)-\(items.map(\.signature).joined(separator: "|").hashValue)"
        case .quote(let blocks): return "q-\(blocks.map(\.id).joined(separator: "|").hashValue)"
        case .code(_, let c): return "c-\(c.hashValue)"
        case .table(let t): return "t-\(t.signature.hashValue)"
        case .rule: return "rule"
        }
    }
}

/// One list item: its first paragraph, an optional task-list checkbox,
/// and whatever else the item holds (a nested list, a code fence, more
/// paragraphs) — none of which may silently disappear.
struct MDListItem {
    var text: AttributedString
    /// `nil` = a plain item, otherwise a task-list item (`- [x]`).
    var checked: Bool?
    var children: [MDBlock] = []

    var signature: String {
        "\(String(text.characters))\(checked.map { $0 ? "x" : "o" } ?? "")[\(children.map(\.id).joined(separator: ","))]"
    }
}

enum MDAlignment: Equatable, Sendable { case leading, center, trailing }

/// A GFM table: a header row, per-column alignment, inline-formatted
/// cells. Rows are padded or trimmed to the header's width.
struct MDTable {
    var alignments: [MDAlignment]
    var header: [AttributedString]
    var rows: [[AttributedString]]
    /// Reveal offset where the last body row's text starts (a streaming
    /// tail that drops its unfinished row stops the reveal there).
    var lastRowFadeStart: Double = 0

    var columnCount: Int { alignments.count }
    var cellCount: Int { columnCount * (rows.count + 1) }

    var signature: String {
        (header + rows.flatMap { $0 }).map { String($0.characters) }.joined(separator: "\u{1F}")
            + "|\(alignments.map { "\($0)" }.joined())"
    }

    /// The table without its last body row (nil when there is none).
    var droppingLastRow: MDTable? {
        guard !rows.isEmpty else { return nil }
        var copy = self
        copy.rows.removeLast()
        return copy
    }
}

/// One rendered block plus what the views need to skip work: its fade
/// range (so the reveal can be clamped per block) and a revision that
/// changes only when the block is re-parsed (so equality is O(1)).
struct MDBlockItem: Identifiable, Equatable {
    /// Position in the message. Streaming only appends blocks or grows
    /// the last one, so positions are stable identities.
    let id: Int
    let revision: Int
    let block: MDBlock
    /// Fade offsets covered by this block: `fadeStart..<fadeEnd`.
    let fadeStart: Double
    let fadeEnd: Double

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.revision == rhs.revision
    }
}

/// Parses with apple/swift-markdown and renders blocks natively so
/// typography and chips come out exact (spec §8). Chips are real inline
/// runs: CodePill via `` `code` ``, FileRef via `praxis-file://` links,
/// LinkRef via https links, integration tiles via `praxis-app://` links.
/// Parsed message: blocks plus the reveal length (characters stamped with
/// fade markers) the streaming reveal animates toward.
struct MDDocument {
    let blocks: [MDBlockItem]
    let revealLength: Double

    static let empty = MDDocument(blocks: [], revealLength: 0)
}

/// Finished messages parse once, ever: scrolling a long answer back into
/// view must never re-run the markdown parser. Streaming text is parsed
/// incrementally by its `LiveText` instead.
@MainActor
enum MarkdownCache {
    private static var documents: [String: MDDocument] = [:]

    static func document(for source: String) -> MDDocument {
        if let hit = documents[source] { return hit }
        let doc = PraxisMarkdown.document(source)
        if documents.count >= 256 { documents.removeAll(keepingCapacity: true) }
        documents[source] = doc
        return doc
    }
}

/// Streaming parse that keeps finished blocks. Every top-level block but
/// the last is final once a later block has started, so each append
/// re-parses only from the start of the last block: a long answer costs
/// O(last block) per update instead of O(message).
struct IncrementalMarkdown {
    private(set) var source = ""
    /// UTF-8 offset of the first block that may still change.
    private var tailOffset = 0
    private var stable: [MDBlockItem] = []
    private var stableCursor = 0.0
    private(set) var document = MDDocument.empty

    init(_ source: String = "") {
        self.source = source
        if !source.isEmpty { reparseTail() }
    }

    mutating func append(_ text: String) {
        guard !text.isEmpty else { return }
        source += text
        reparseTail()
    }

    private mutating func reparseTail() {
        let tail = source[source.utf8.index(source.utf8.startIndex, offsetBy: tailOffset)...]
        var cursor = stableCursor
        let children = PraxisMarkdown.children(of: Document(parsing: String(tail)), cursor: &cursor)

        // Promote everything before the last child; the tail then starts
        // at the last child's first line. A child without a source range
        // simply stays in the tail (re-parsed again next time).
        var live = children[...]
        if children.count >= 2, let line = children.last?.line,
           let offset = Self.utf8Offset(ofLine: line, in: tail) {
            for child in children.dropLast() {
                if let item = child.item(id: stable.count) { stable.append(item) }
            }
            stableCursor = children[children.count - 1].fadeStart
            tailOffset += offset
            live = children.suffix(1)
        }
        var blocks = stable
        for child in live {
            if let item = child.item(id: blocks.count) { blocks.append(item) }
        }
        // A table streams in row by row: hold back what isn't one yet.
        if let last = blocks.last, let held = Self.holdingBack(last, tail: source[source.utf8.index(source.utf8.startIndex, offsetBy: tailOffset)...]) {
            blocks.removeLast()
            if let item = held.item { blocks.append(item) }
            cursor = held.revealLength
        }
        document = MDDocument(blocks: blocks, revealLength: cursor)
    }

    /// The streaming tail block as it should show, when that isn't the
    /// whole of it: a header row (a paragraph of `| … |` until its
    /// delimiter row arrives) shows nothing; a table shows only the rows
    /// that are complete. The reveal stops where the held-back text starts.
    private static func holdingBack(_ item: MDBlockItem, tail: Substring)
        -> (item: MDBlockItem?, revealLength: Double)? {
        guard !tail.hasSuffix("\n") else { return nil }
        switch item.block {
        case .paragraph where tail.drop(while: \.isWhitespace).hasPrefix("|"):
            return (nil, item.fadeStart)
        case .table(let table):
            guard let complete = table.droppingLastRow else { return nil }
            return (MDBlockItem(id: item.id, revision: item.revision, block: .table(complete),
                                fadeStart: item.fadeStart, fadeEnd: table.lastRowFadeStart),
                    table.lastRowFadeStart)
        default:
            return nil
        }
    }

    /// UTF-8 offset of the first byte of 1-based `line` within `text`.
    private static func utf8Offset(ofLine line: Int, in text: Substring) -> Int? {
        guard line > 1 else { return 0 }
        var remaining = line - 1
        var offset = 0
        for byte in text.utf8 {
            offset += 1
            if byte == UInt8(ascii: "\n") {
                remaining -= 1
                if remaining == 0 { return offset }
            }
        }
        return nil
    }
}

enum PraxisMarkdown {
    /// Revisions are unique per parse, so blocks from different parses
    /// never compare equal and re-used blocks always do.
    private static let revisions = Atomic<Int>(0)

    static func parse(_ source: String) -> [MDBlock] {
        document(source).blocks.map(\.block)
    }

    static func document(_ source: String) -> MDDocument {
        var cursor = 0.0
        let children = children(of: Document(parsing: source), cursor: &cursor)
        var blocks: [MDBlockItem] = []
        for child in children {
            if let item = child.item(id: blocks.count) { blocks.append(item) }
        }
        return MDDocument(blocks: blocks, revealLength: cursor)
    }

    /// A parsed top-level child: its block (nil for markup we don't
    /// render), first source line and fade range.
    struct Child {
        let block: MDBlock?
        let line: Int?
        let fadeStart: Double
        let fadeEnd: Double
        let revision: Int

        func item(id: Int) -> MDBlockItem? {
            block.map { MDBlockItem(id: id, revision: revision, block: $0, fadeStart: fadeStart, fadeEnd: fadeEnd) }
        }
    }

    static func children(of doc: Document, cursor: inout Double) -> [Child] {
        var out: [Child] = []
        for child in doc.children {
            let start = cursor
            let block = block(for: child, base: 17, cursor: &cursor)
            out.append(Child(block: block, line: child.range?.lowerBound.line, fadeStart: start, fadeEnd: cursor,
                             revision: revisions.add(1, ordering: .relaxed).newValue))
        }
        return out
    }

    /// One block-level node, at any depth (a list item's or a quote's
    /// children come through here too). `base` is the prose size: 17 in
    /// the message, 15 inside a quote. Nil only for markup with nothing
    /// to read (an HTML comment, an empty `<br>`): anything else the
    /// parser hands us renders, if only as its plain text.
    static func block(for markup: Markup, base: CGFloat, cursor: inout Double) -> MDBlock? {
        switch markup {
        case let h as Heading:
            return .heading(level: h.level, text: inlines(h.children, base: headingSize(h.level), serif: h.level <= 2, cursor: &cursor))
        case let p as Paragraph:
            return .paragraph(inlines(p.children, base: base, cursor: &cursor))
        case let ul as UnorderedList:
            return .list(ordered: false, start: 1, items: ul.listItems.map { listItem($0, base: base, cursor: &cursor) })
        case let ol as OrderedList:
            return .list(ordered: true, start: Int(ol.startIndex),
                         items: ol.listItems.map { listItem($0, base: base, cursor: &cursor) })
        case let q as BlockQuote:
            return .quote(q.children.compactMap { block(for: $0, base: 15, cursor: &cursor) })
        case let c as CodeBlock:
            return .code(language: c.language, code: c.code.trimmingCharacters(in: .newlines))
        case let t as Markdown.Table:
            return .table(table(t, cursor: &cursor))
        case is ThematicBreak:
            return .rule
        case let html as HTMLBlock:
            // Raw HTML reads as its text: models wrap prose in `<p>`,
            // `<details>`, `<center>`. Tags and comments alone show nothing.
            guard let text = htmlText(html.rawHTML) else { return nil }
            var s = styled(text, base: base, serif: false, bold: false, italic: false)
            stampFade(&s, cursor: &cursor)
            return .paragraph(s)
        default:
            // Directives and other extensions: their source, as prose.
            let text = markup.format().trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            var s = styled(text, base: base, serif: false, bold: false, italic: false)
            stampFade(&s, cursor: &cursor)
            return .paragraph(s)
        }
    }

    /// A list item: its first paragraph is the item's line; everything
    /// after it (a nested list, a code fence, more paragraphs, a table)
    /// renders under that line.
    private static func listItem(_ item: ListItem, base: CGFloat, cursor: inout Double) -> MDListItem {
        var children = Array(item.children)
        var text = AttributedString()
        if let first = children.first as? Paragraph {
            text = inlines(first.children, base: base, cursor: &cursor)
            children.removeFirst()
        }
        let checked: Bool? = switch item.checkbox {
        case .checked?: true
        case .unchecked?: false
        case nil: nil
        }
        return MDListItem(text: text, checked: checked,
                          children: children.compactMap { block(for: $0, base: base, cursor: &cursor) })
    }

    /// A GFM table at the column count the delimiter row set; bold header.
    static func table(_ table: Markdown.Table, cursor: inout Double) -> MDTable {
        let alignments: [MDAlignment] = table.columnAlignments.map {
            switch $0 {
            case .center?: .center
            case .right?: .trailing
            case .left?, nil: .leading
            }
        }
        let columns = max(alignments.count, table.head.childCount)
        func row(_ cells: some Sequence<Markdown.Table.Cell>, bold: Bool) -> [AttributedString] {
            var out = cells.prefix(columns).map { inlines($0.children, base: 15, bold: bold, cursor: &cursor) }
            while out.count < columns { out.append(AttributedString()) }
            return out
        }
        let header = row(table.head.cells, bold: true)
        var rows: [[AttributedString]] = []
        var lastRowFadeStart = cursor
        for bodyRow in table.body.rows {
            lastRowFadeStart = cursor
            rows.append(row(bodyRow.cells, bold: false))
        }
        return MDTable(alignments: alignments + Array(repeating: .leading, count: columns - alignments.count),
                       header: header, rows: rows, lastRowFadeStart: lastRowFadeStart)
    }

    /// HTML as the text it shows: tags and comments out, `<br>` as a line
    /// break, the common entities decoded. Nil when nothing is left.
    static func htmlText(_ html: String) -> String? {
        var text = html.replacingOccurrences(of: #"<!--[\s\S]*?-->"#, with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"<br\s*/?>"#, with: "\n", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
        for (entity, char) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&amp;", "&")] {
            text = text.replacingOccurrences(of: entity, with: char)
        }
        text = text.split(separator: "\n", omittingEmptySubsequences: true)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        return text.isEmpty ? nil : text
    }

    // MARK: Chip segments (bridge to Text.Layout markers)

    enum ChipSegmentKind: Equatable { case plain, pill, tile, fade }

    struct ChipSegment {
        let text: AttributedString
        let kind: ChipSegmentKind
        let tileMonogram: String?
        let fadeIndex: Double?
    }

    /// Splits an attributed paragraph into per-run segments, classifying
    /// chip runs. `AgentMessageView` turns each segment into a `Text`
    /// carrying the matching `Text.customAttribute` marker, which is the
    /// only channel `Text.Layout` runs expose to a `TextRenderer`.
    static func chipSegments(in attributed: AttributedString) -> [ChipSegment] {
        attributed.runs.map { run in
            let slice = AttributedString(attributed[run.range])
            let tile = run[TileTextAttribute.self]
            let kind: ChipSegmentKind =
                run[PillTextAttribute.self] != nil ? .pill
                : tile != nil ? .tile
                : run[ChipFadeAttribute.self] != nil ? .fade
                : .plain
            return ChipSegment(
                text: slice, kind: kind,
                tileMonogram: tile?.monogram,
                fadeIndex: run[ChipFadeAttribute.self]?.index)
        }
    }

    private static func headingSize(_ level: Int) -> CGFloat {
        switch level { case 1: return 26; case 2: return 22; default: return 17 }
    }

    // MARK: Inline runs

    static func inlines(_ children: MarkupChildren, base: CGFloat, serif: Bool = false) -> AttributedString {
        var cursor = 0.0
        return inlines(children, base: base, serif: serif, cursor: &cursor)
    }

    static func inlines(_ children: MarkupChildren, base: CGFloat, serif: Bool = false, bold: Bool = false,
                        cursor: inout Double) -> AttributedString {
        var out = AttributedString()
        for child in children {
            append(child, into: &out, base: base, serif: serif, bold: bold, italic: false, wordIndex: &cursor)
        }
        return out
    }

    private static func append(_ markup: Markup, into out: inout AttributedString,
                               base: CGFloat, serif: Bool, bold: Bool, italic: Bool,
                               wordIndex: inout Double) {
        switch markup {
        case let t as Markdown.Text:
            var s = styled(t.string, base: base, serif: serif, bold: bold, italic: italic)
            stampFade(&s, cursor: &wordIndex)
            out += s
        case let e as Emphasis:
            for c in e.children { append(c, into: &out, base: base, serif: serif, bold: bold, italic: true, wordIndex: &wordIndex) }
        case let s as Strong:
            for c in s.children { append(c, into: &out, base: base, serif: serif, bold: true, italic: italic, wordIndex: &wordIndex) }
        case let code as InlineCode:
            var s = AttributedString(code.code)
            s.font = Type.mono(base * 0.86, weight: .regular, .caption)
            s.foregroundColor = Praxis.ink
            s[PillTextAttribute.self] = PillMarker()
            stampFade(&s, cursor: &wordIndex)
            if let encoded = code.code.addingPercentEncoding(withAllowedCharacters: .alphanumerics) {
                s.link = URL(string: "praxis-code://\(encoded)")
            }
            out += s
        case let link as Markdown.Link:
            appendLink(title: link.plainText, destination: link.destination ?? "", into: &out, base: base, cursor: &wordIndex)
        case let image as Markdown.Image:
            // No inline images in prose: the picture reads as a link to it.
            let alt = image.plainText
            appendLink(title: alt.isEmpty ? "Image" : alt, destination: image.source ?? "", into: &out, base: base, cursor: &wordIndex)
        case let strike as Strikethrough:
            var inner = AttributedString()
            for c in strike.children { append(c, into: &inner, base: base, serif: serif, bold: bold, italic: italic, wordIndex: &wordIndex) }
            inner.strikethroughStyle = .single
            out += inner
        case let symbol as SymbolLink:
            // ``Symbol`` (DocC): shown like inline code.
            var s = AttributedString(symbol.destination ?? "")
            s.font = Type.mono(base * 0.86, weight: .regular, .caption)
            s.foregroundColor = Praxis.ink
            s[PillTextAttribute.self] = PillMarker()
            stampFade(&s, cursor: &wordIndex)
            out += s
        case let html as InlineHTML:
            // `<br>` is how models break a line inside a table cell; other
            // tags (`<sub>`, `<kbd>`) drop and their text reads as is.
            if html.rawHTML.range(of: #"^<br\s*/?>$"#, options: [.regularExpression, .caseInsensitive]) != nil {
                out += AttributedString("\n")
            }
        case is LineBreak:
            out += AttributedString("\n")
        case is SoftBreak:
            out += AttributedString(" ")
        default:
            for c in markup.children { append(c, into: &out, base: base, serif: serif, bold: bold, italic: italic, wordIndex: &wordIndex) }
        }
    }

    private static func appendLink(title: String, destination dest: String, into out: inout AttributedString,
                                   base: CGFloat, cursor: inout Double) {
        if dest.hasPrefix("praxis-file://") {
            // FileRef (§9.2): 14pt file icon drawn as tile run + underlined mono name.
            let name = String(dest.dropFirst("praxis-file://".count)).removingPercentEncoding ?? title
            var icon = AttributedString(" ")
            icon[TileTextAttribute.self] = TileMarker(monogram: fileGlyph(for: name))
            icon.font = Type.inter(9, weight: .semibold, .caption2)
            icon.foregroundColor = Praxis.mutedInk
            icon.tracking = 12 // 14pt glyph + ~6pt gap in layout advance
            stampFade(&icon, cursor: &cursor)
            out += icon
            var s = AttributedString(title.isEmpty ? name : title)
            s.font = Type.mono(base * 0.86, .caption)
            s.foregroundColor = Praxis.ink
            s.underlineStyle = SwiftUI.Text.LineStyle.single
            s.underlineColor = UIColor(Praxis.ink).withAlphaComponent(0.4)
            s.link = URL(string: dest)
            stampFade(&s, cursor: &cursor)
            out += s
        } else if dest.hasPrefix("praxis-app://") {
            // IntegrationAvatar (§9.2): 16pt tile + monogram, then the name.
            let name = title.isEmpty ? String(dest.dropFirst("praxis-app://".count)) : title
            var tile = AttributedString(String(name.prefix(1)))
            tile[TileTextAttribute.self] = TileMarker(monogram: String(name.prefix(1)))
            tile.font = Type.inter(9, weight: .semibold, .caption2)
            tile.foregroundColor = Color.clear // renderer centres the glyph
            tile.tracking = 14 // reserve the full 16pt tile in the line
            stampFade(&tile, cursor: &cursor)
            out += tile
            var s = AttributedString(" \(name)")
            s.font = Type.inter(base, weight: .medium)
            s.foregroundColor = Praxis.ink
            stampFade(&s, cursor: &cursor)
            out += s
        } else if dest.hasPrefix("http") {
            // LinkRef (§9.2): monogram tile + underlined title/domain.
            let host = URL(string: dest)?.host() ?? dest
            let label = title.isEmpty ? host : title
            var tile = AttributedString(String(label.prefix(1)).uppercased())
            tile[TileTextAttribute.self] = TileMarker(monogram: String(label.prefix(1)).uppercased())
            tile.font = Type.inter(9, weight: .semibold, .caption2)
            tile.foregroundColor = Color.clear // renderer centres the glyph
            tile.tracking = 14 // reserve the full 16pt tile in the line
            stampFade(&tile, cursor: &cursor)
            out += tile
            var s = AttributedString(" \(label)")
            s.font = Type.inter(base)
            s.foregroundColor = Praxis.ink
            s.underlineStyle = SwiftUI.Text.LineStyle.single
            s.underlineColor = UIColor(Praxis.ink).withAlphaComponent(0.4)
            // Route through the preview card instead of opening directly.
            let encoded = dest.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? dest
            s.link = URL(string: "praxis-link://\(encoded)")
            stampFade(&s, cursor: &cursor)
            out += s
        } else {
            var s = styled(title, base: base, serif: false, bold: false, italic: false)
            stampFade(&s, cursor: &cursor)
            out += s
        }
    }

    private static func fileGlyph(for name: String) -> String {
        if name.hasSuffix(".json") { return "file-json-2" }
        if name.hasSuffix(".md") || name.hasSuffix(".txt") { return "file-text" }
        return "file-code-2"
    }

    private static func styled(_ string: String, base: CGFloat, serif: Bool, bold: Bool, italic: Bool) -> AttributedString {
        var s = AttributedString(string)
        if serif {
            s.font = Type.serif(base, weight: bold ? .semibold : .semibold)
        } else {
            var f = Type.inter(base, weight: bold ? .semibold : .regular)
            if italic { f = f.italic() }
            s.font = f
        }
        s.foregroundColor = Praxis.ink
        return s
    }

    /// Character-offset stamp driving the streaming reveal (§10). The
    /// renderer adds each glyph's offset within the run, so a long plain
    /// run still reveals word by word instead of all at once.
    private static func stampFade(_ s: inout AttributedString, cursor: inout Double) {
        s[ChipFadeAttribute.self] = FadeMarker(index: cursor)
        cursor += Double(max(s.characters.count, 1))
    }
}
