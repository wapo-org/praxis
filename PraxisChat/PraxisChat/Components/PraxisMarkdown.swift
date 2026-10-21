import Foundation
import SwiftUI
import Markdown

// MARK: Custom text attributes (drawn by ChipTextRenderer, §9.2)

/// Layout-visible attribute values (read by `ChipTextRenderer` via
/// `run[Marker.self]`); the Keys register them on `AttributedString`.
struct PillMarker: TextAttribute {}
struct TileMarker: TextAttribute { var monogram: String = "" }
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
    case list(ordered: Bool, items: [AttributedString])
    case quote(AttributedString)
    case code(language: String?, code: String)
    case rule

    var id: String {
        switch self {
        case .heading(let l, let t): return "h\(l)-\(String(t.characters).hashValue)"
        case .paragraph(let t): return "p-\(String(t.characters).hashValue)"
        case .list(let o, let items): return "l\(o)-\(items.count)-\(items.map { String($0.characters) }.joined(separator: "|").hashValue)"
        case .quote(let t): return "q-\(String(t.characters).hashValue)"
        case .code(_, let c): return "c-\(c.hashValue)"
        case .rule: return "rule"
        }
    }
}

/// Parses with apple/swift-markdown and renders blocks natively so
/// typography and chips come out exact (spec §8). Chips are real inline
/// runs: CodePill via `` `code` ``, FileRef via `praxis-file://` links,
/// LinkRef via https links, integration tiles via `praxis-app://` links.
enum PraxisMarkdown {
    static func parse(_ source: String) -> [MDBlock] {
        let doc = Document(parsing: source)
        var blocks: [MDBlock] = []
        for child in doc.children {
            switch child {
            case let h as Heading:
                blocks.append(.heading(level: h.level, text: inlines(h.children, base: headingSize(h.level), serif: h.level <= 2)))
            case let p as Paragraph:
                blocks.append(.paragraph(inlines(p.children, base: 17)))
            case let ul as UnorderedList:
                blocks.append(.list(ordered: false, items: ul.listItems.map { itemText($0) }))
            case let ol as OrderedList:
                blocks.append(.list(ordered: true, items: ol.listItems.map { itemText($0) }))
            case let q as BlockQuote:
                let inner = q.children.compactMap { $0 as? Paragraph }.map { inlines($0.children, base: 15) }
                var joined = AttributedString()
                for (i, part) in inner.enumerated() {
                    if i > 0 { joined += AttributedString("\n") }
                    joined += part
                }
                blocks.append(.quote(joined))
            case let c as CodeBlock:
                blocks.append(.code(language: c.language, code: c.code.trimmingCharacters(in: .newlines)))
            case is ThematicBreak:
                blocks.append(.rule)
            default:
                break
            }
        }
        return blocks
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

    private static func itemText(_ item: ListItem) -> AttributedString {
        for child in item.children {
            if let p = child as? Paragraph { return inlines(p.children, base: 17) }
        }
        return AttributedString(item.format())
    }

    // MARK: Inline runs

    static func inlines(_ children: MarkupChildren, base: CGFloat, serif: Bool = false) -> AttributedString {
        var out = AttributedString()
        var wordIndex = 0.0
        for child in children {
            append(child, into: &out, base: base, serif: serif, bold: false, italic: false, wordIndex: &wordIndex)
        }
        return out
    }

    private static func append(_ markup: Markup, into out: inout AttributedString,
                               base: CGFloat, serif: Bool, bold: Bool, italic: Bool,
                               wordIndex: inout Double) {
        switch markup {
        case let t as Markdown.Text:
            var s = styled(t.string, base: base, serif: serif, bold: bold, italic: italic)
            stampFade(&s, wordIndex: &wordIndex)
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
            if let encoded = code.code.addingPercentEncoding(withAllowedCharacters: .alphanumerics) {
                s.link = URL(string: "praxis-code://\(encoded)")
            }
            out += s
        case let link as Markdown.Link:
            appendLink(link, into: &out, base: base, wordIndex: &wordIndex)
        case is SoftBreak, is LineBreak:
            out += AttributedString(" ")
        default:
            for c in markup.children { append(c, into: &out, base: base, serif: serif, bold: bold, italic: italic, wordIndex: &wordIndex) }
        }
    }

    private static func appendLink(_ link: Markdown.Link, into out: inout AttributedString, base: CGFloat, wordIndex: inout Double) {
        let title = link.children.compactMap { ($0 as? Markdown.Text)?.string }.joined()
        let dest = link.destination ?? ""
        if dest.hasPrefix("praxis-file://") {
            // FileRef (§9.2): 14pt file icon drawn as tile run + underlined mono name.
            let name = String(dest.dropFirst("praxis-file://".count)).removingPercentEncoding ?? title
            var icon = AttributedString(" ")
            icon[TileTextAttribute.self] = TileMarker(monogram: fileGlyph(for: name))
            icon.font = Type.inter(9, weight: .semibold, .caption2)
            icon.foregroundColor = Praxis.mutedInk
            icon.tracking = 12 // 14pt glyph + ~6pt gap in layout advance
            out += icon
            var s = AttributedString(title.isEmpty ? name : title)
            s.font = Type.mono(base * 0.86, .caption)
            s.foregroundColor = Praxis.ink
            s.underlineStyle = SwiftUI.Text.LineStyle.single
            s.underlineColor = UIColor(Praxis.ink).withAlphaComponent(0.4)
            s.link = URL(string: dest)
            out += s
        } else if dest.hasPrefix("praxis-app://") {
            // IntegrationAvatar (§9.2): 16pt tile + monogram, then the name.
            let name = title.isEmpty ? String(dest.dropFirst("praxis-app://".count)) : title
            var tile = AttributedString(String(name.prefix(1)))
            tile[TileTextAttribute.self] = TileMarker(monogram: String(name.prefix(1)))
            tile.font = Type.inter(9, weight: .semibold, .caption2)
            tile.foregroundColor = Color.clear // renderer centres the glyph
            tile.tracking = 14 // reserve the full 16pt tile in the line
            out += tile
            var s = AttributedString(" \(name)")
            s.font = Type.inter(base, weight: .medium)
            s.foregroundColor = Praxis.ink
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
            out += tile
            var s = AttributedString(" \(label)")
            s.font = Type.inter(base)
            s.foregroundColor = Praxis.ink
            s.underlineStyle = SwiftUI.Text.LineStyle.single
            s.underlineColor = UIColor(Praxis.ink).withAlphaComponent(0.4)
            // Route through the preview card instead of opening directly.
            let encoded = dest.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? dest
            s.link = URL(string: "praxis-link://\(encoded)")
            out += s
        } else {
            var s = styled(title, base: base, serif: false, bold: false, italic: false)
            stampFade(&s, wordIndex: &wordIndex)
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

    /// Word-order stamp driving the per-run streaming reveal (§10).
    private static func stampFade(_ s: inout AttributedString, wordIndex: inout Double) {
        let words = s.characters.split(separator: " ").count
        s[ChipFadeAttribute.self] = FadeMarker(index: wordIndex)
        wordIndex += Double(max(words, 1))
    }
}
