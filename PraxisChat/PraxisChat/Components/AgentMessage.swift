import SwiftUI

/// Builds one `Text` from attributed runs, attaching layout markers via
/// `customAttribute` — the channel `Text.Layout` exposes to renderers.
func chipText(_ attributed: AttributedString) -> Text {
    var result: Text?
    for segment in PraxisMarkdown.chipSegments(in: attributed) {
        var t = Text(segment.text)
        if segment.kind == .pill { t = t.customAttribute(PillMarker()) }
        if let monogram = segment.tileMonogram { t = t.customAttribute(TileMarker(monogram: monogram)) }
        if let fade = segment.fadeIndex { t = t.customAttribute(FadeMarker(index: fade)) }
        result = result.map { Text("\($0)\(t)") } ?? t
    }
    return result ?? Text("")
}

/// Long-read agent message: no bubble, no avatar, prose on canvas (§8).
/// Block identities are stable; finished blocks never re-animate (§10).
/// Equatable on content, so streaming into one message never re-renders
/// the finished messages above it. Finished messages parse once (cached).
struct AgentMessageView: View, Equatable {
    let source: String
    let isStreaming: Bool
    var onChipAction: (ChipAction) -> Void = { _ in }

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.isStreaming == rhs.isStreaming && lhs.source == rhs.source
    }

    var body: some View {
        MarkdownBlocksView(document: MarkdownCache.document(for: source), revealed: .infinity,
                           selectable: !isStreaming, onChipAction: onChipAction)
    }
}

/// One finished markdown block as its own transcript row: long answers
/// are many small lazy rows instead of one tall one, so the transcript's
/// height estimates for rows it hasn't drawn stay close to the truth.
struct MarkdownRowView: View, Equatable {
    let item: MDBlockItem
    let selectable: Bool
    var onChipAction: (ChipAction) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.item == rhs.item && lhs.selectable == rhs.selectable
    }

    var body: some View {
        MarkdownBlockView(item: item, revealed: .infinity, selectable: selectable,
                          onLink: { ChipAction.handle($0, onChipAction) })
            .equatable()
    }
}

/// One block of a message still streaming (or just finished streaming):
/// reads its `LiveText`, so tokens re-render the rows of that message and
/// nothing else. The reveal front is the LiveText's; each row clamps it to
/// its own range, so only the row under the front animates.
struct LiveMarkdownRowView: View, Equatable {
    let live: LiveText
    let index: Int
    var onChipAction: (ChipAction) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.live === rhs.live && lhs.index == rhs.index
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let blocks = live.document.blocks
        if blocks.indices.contains(index) {
            let item = blocks[index]
            let motion = live.motion
            // Only the row the front is crossing ticks (30 Hz, until the
            // front settles); the others draw once per chunk at most.
            let moving = !reduceMotion && live.isRevealing
                && motion.touches(item.fadeStart, item.fadeEnd + ChipTextRenderer.fadeSpan)
            TimelineView(.animation(minimumInterval: RevealMotion.frameInterval, paused: !moving)) { context in
                // Paused, the front is wherever it rests (an untouched row
                // clamps any point of the motion to the same value).
                let front = moving ? motion.value(at: context.date) : motion.to
                MarkdownBlockView(item: item,
                                  revealed: clampedReveal(front, for: item, reduceMotion: reduceMotion),
                                  selectable: !live.isStreaming, onLink: { ChipAction.handle($0, onChipAction) })
                    .equatable()
            }
        }
    }
}

/// The block column shared by finished and live messages.
private struct MarkdownBlocksView: View {
    let document: MDDocument
    let revealed: Double
    let selectable: Bool
    var onChipAction: (ChipAction) -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(document.blocks) { item in
                MarkdownBlockView(item: item, revealed: clampedReveal(revealed, for: item, reduceMotion: reduceMotion),
                                  selectable: selectable, onLink: { ChipAction.handle($0, onChipAction) })
                    .equatable()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            ChipAction.handle(url, onChipAction)
            return .handled
        })
    }
}

/// Per-block reveal: blocks the front has passed hold a constant "fully
/// shown" value and blocks it hasn't reached hold their start, so only the
/// block under the front animates (and redraws) per frame. Finite on both
/// sides: a block that grows again animates from where it was, never from
/// infinity.
private func clampedReveal(_ revealed: Double, for item: MDBlockItem, reduceMotion: Bool) -> Double {
    guard revealed.isFinite, !reduceMotion else { return .infinity }
    return min(max(revealed, item.fadeStart), item.fadeEnd + ChipTextRenderer.fadeSpan)
}

/// One block. Equatable on (block revision, its clamped reveal, whether
/// selection is on): finished paragraphs skip `body` entirely while the
/// stream continues below them.
struct MarkdownBlockView: View, Equatable {
    let item: MDBlockItem
    let revealed: Double
    let selectable: Bool
    var onLink: (URL) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.item == rhs.item && lhs.revealed == rhs.revealed && lhs.selectable == rhs.selectable
    }

    var body: some View {
        MarkdownBlockContent(block: item.block, renderer: ChipTextRenderer(revealedLength: revealed),
                             selectable: selectable, onLink: onLink)
    }
}

/// Draws one block, and — through `AnyView`, the only way a view can
/// contain itself — the blocks nested in it: a list item's sub-list or
/// code fence, a quote's list, a table inside a list.
private struct MarkdownBlockContent: View {
    let block: MDBlock
    let renderer: ChipTextRenderer
    let selectable: Bool
    var onLink: (URL) -> Void
    /// Inside a quote prose is 15pt with looser leading.
    var inQuote = false
    /// List nesting, for the bullet glyph.
    var depth = 0

    var body: some View {
        switch block {
        case .heading(_, let text):
            chipText(text)
                .lineSpacing(6)
                .textRenderer(renderer)
                .selectionLayer(text, lineSpacing: 6, enabled: selectable, onLink: onLink)
                .padding(.top, 8)
        case .paragraph(let text):
            paragraph(text)
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        marker(ordered: ordered, number: start + i, checked: item.checked)
                        VStack(alignment: .leading, spacing: 8) {
                            if !item.text.characters.isEmpty {
                                paragraph(item.text)
                            }
                            ForEach(Array(item.children.enumerated()), id: \.offset) { _, child in
                                nested(child, depth: depth + 1)
                            }
                        }
                    }
                }
            }
        case .quote(let blocks):
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(Praxis.secondaryInk)
                    .frame(width: 2)
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, child in
                        nested(child, depth: depth, inQuote: true)
                    }
                }
                .padding(.leading, 16)
            }
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
                .transition(.praxisReveal)
        case .table(let table):
            MarkdownTableView(table: table, renderer: renderer)
        case .rule:
            Rectangle().fill(Praxis.hairline).frame(height: 1)
        }
    }

    private func nested(_ child: MDBlock, depth: Int, inQuote: Bool? = nil) -> AnyView {
        AnyView(MarkdownBlockContent(block: child, renderer: renderer, selectable: selectable, onLink: onLink,
                                     inQuote: inQuote ?? self.inQuote, depth: depth))
    }

    /// "3." for ordered items (from the list's own start), a bullet that
    /// changes with depth, or a checkbox for task items.
    @ViewBuilder
    private func marker(ordered: Bool, number: Int, checked: Bool?) -> some View {
        let size: CGFloat = inQuote ? 15 : 17
        if let checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .font(.system(size: size * 0.82))
                .foregroundStyle(checked ? Praxis.secondaryInk : Praxis.mutedInk)
                .accessibilityLabel(checked ? "Done" : "Not done")
        } else {
            Text(ordered ? "\(number)." : ["•", "◦", "▪︎"][min(depth, 2)])
                .font(Type.inter(size))
                .foregroundStyle(Praxis.mutedInk)
                .monospacedDigit()
        }
    }

    /// One structure for streaming and finished prose: flipping
    /// `selectable` only enables the selection mirror, it never swaps the
    /// text view (which used to pop any words the reveal hadn't reached).
    @ViewBuilder
    private func paragraph(_ text: AttributedString) -> some View {
        if inQuote {
            chipText(text)
                .font(Type.inter(15, .callout))
                .lineSpacing(9)
                .textRenderer(renderer)
                .selectionLayer(text, lineSpacing: 9, font: Type.inter(15, .callout),
                                enabled: selectable, onLink: onLink)
        } else {
            chipText(text)
                .bodyLineSpacing()
                .textRenderer(renderer)
                .selectionLayer(text, lineSpacing: 10, enabled: selectable, onLink: onLink)
        }
    }
}

/// A GFM table (§8 surfaces): fill-1 header, hairline rules, 12pt radius
/// like a code block. Narrow tables span the column; a table wider than
/// it (long cells wrap at `TableGrid.maxColumnWidth` first) scrolls
/// sideways with feathered edges, never squeezing cells to one word a
/// line. Cells reveal with the stream like any other text.
///
/// One horizontal scroll view, not a `ViewThatFits`: fitting tried every
/// branch and re-measured every cell for every proposal. The grid gets
/// the measured column width as its minimum instead, and only a grid
/// wider than that scrolls.
struct MarkdownTableView: View {
    let table: MDTable
    let renderer: ChipTextRenderer
    /// The column width, measured on the outer container; the grid below
    /// spans at least this, so narrow tables look as they did unrolled.
    @State private var containerWidth: CGFloat = 0
    /// The grid's own width; wider than the container means sideways scroll.
    @State private var contentWidth: CGFloat = 0

    /// The grid overflows the column: scrolling and the feathered edge are
    /// on. Both only mask and gesture the same frames, so flipping them
    /// never re-measures and the two widths below settle, never oscillate.
    private var scrolls: Bool {
        containerWidth > 0 && contentWidth > containerWidth + 0.5
    }

    var body: some View {
        tableBody
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { containerWidth = $0 }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Praxis.hairline, lineWidth: 1))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Table, \(table.columnCount) columns, \(table.rows.count) rows")
    }

    /// The feathered edge only when the grid overflows: narrow tables keep
    /// the crisp corners they had unrolled.
    @ViewBuilder
    private var tableBody: some View {
        if scrolls {
            scroller.fadeEdges(.horizontal, length: 12)
        } else {
            scroller
        }
    }

    private var scroller: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            grid
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
        }
        .scrollDisabled(!scrolls)
    }

    private var grid: some View {
        TableGrid(columns: table.columnCount, minWidth: containerWidth) {
            ForEach(0..<table.columnCount, id: \.self) { column in
                cell(table.header[column], column: column, row: -1)
            }
            ForEach(Array(table.rows.enumerated()), id: \.offset) { r, row in
                ForEach(0..<table.columnCount, id: \.self) { column in
                    cell(row[column], column: column, row: r)
                }
            }
        }
    }

    private func cell(_ text: AttributedString, column: Int, row: Int) -> some View {
        let alignment = table.alignments[column]
        return chipText(text)
            .lineSpacing(4)
            .multilineTextAlignment(alignment.text)
            .textRenderer(renderer)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: Alignment(horizontal: alignment.horizontal, vertical: .top))
            .background(row < 0 ? Praxis.fill1 : Color.clear)
            .overlay(alignment: .bottom) {
                // Rules between rows; the border closes the last one.
                if row < table.rows.count - 1 {
                    Rectangle().fill(Praxis.hairline).frame(height: 1)
                }
            }
    }
}

private extension MDAlignment {
    var horizontal: HorizontalAlignment {
        switch self { case .leading: .leading; case .center: .center; case .trailing: .trailing }
    }
    var text: TextAlignment {
        switch self { case .leading: .leading; case .center: .center; case .trailing: .trailing }
    }
}

/// Lays cells out row-major in columns sized to their content. Asked for
/// its ideal width (how a horizontal scroll view asks) it answers with
/// every column at its natural width, capped at `maxColumnWidth`,
/// stretched to `minWidth` when narrower; given a wider proposal it
/// fills it, growing the columns that wrapped first. Each row is as tall
/// as its tallest cell, and every cell in it is offered that height, so
/// backgrounds and rules line up.
struct TableGrid: Layout {
    let columns: Int
    /// The column width the table spans when its cells are narrower.
    var minWidth: CGFloat = 0
    static let maxColumnWidth: CGFloat = 220

    struct Cache {
        var natural: [CGFloat] = []
        /// The last width served, with its answer: sizing and placing ask
        /// repeatedly for the same width, and only a new width (or new
        /// cells, which reset the cache) re-measures.
        var key: CGFloat = -.infinity
        var widths: [CGFloat] = []
        var heights: [CGFloat] = []
    }

    func makeCache(subviews: Subviews) -> Cache {
        var natural = Array(repeating: CGFloat(0), count: columns)
        for (i, cell) in subviews.enumerated() {
            natural[i % columns] = max(natural[i % columns], ceil(cell.sizeThatFits(.unspecified).width))
        }
        return Cache(natural: natural)
    }

    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        cache = makeCache(subviews: subviews)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let (widths, heights) = layout(proposal: proposal.width, subviews: subviews, cache: &cache)
        return CGSize(width: widths.reduce(0, +), height: heights.reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let (widths, heights) = layout(proposal: bounds.width, subviews: subviews, cache: &cache)
        var y = bounds.minY
        for (r, height) in heights.enumerated() {
            var x = bounds.minX
            for c in 0..<columns {
                let index = r * columns + c
                guard index < subviews.count else { break }
                subviews[index].place(at: CGPoint(x: x, y: y), anchor: .topLeading,
                                      proposal: ProposedViewSize(width: widths[c], height: height))
                x += widths[c]
            }
            y += height
        }
    }

    /// Columns and rows for a width, cached: the served width is the
    /// proposal floored at `minWidth` (an unspecified proposal with no
    /// minimum sizes the capped naturals, as before).
    private func layout(proposal: CGFloat?, subviews: Subviews, cache: inout Cache) -> ([CGFloat], [CGFloat]) {
        let finite = proposal.flatMap { $0.isFinite ? $0 : nil } ?? 0
        let key = max(finite, minWidth)
        if key == cache.key && cache.widths.count == columns && !cache.heights.isEmpty {
            return (cache.widths, cache.heights)
        }
        let widths = Self.columnWidths(natural: cache.natural, proposed: key > 0 ? key : nil)
        let heights = rowHeights(widths: widths, subviews: subviews)
        cache.key = key
        cache.widths = widths
        cache.heights = heights
        return (widths, heights)
    }

    private func rowHeights(widths: [CGFloat], subviews: Subviews) -> [CGFloat] {
        guard columns > 0 else { return [] }
        let rows = (subviews.count + columns - 1) / columns
        return (0..<rows).map { r in
            (0..<columns).reduce(CGFloat(0)) { tallest, c in
                let index = r * columns + c
                guard index < subviews.count else { return tallest }
                return max(tallest, ceil(subviews[index].sizeThatFits(ProposedViewSize(width: widths[c], height: nil)).height))
            }
        }
    }

    /// Column widths for a proposal: natural widths capped at
    /// `maxColumnWidth` when the proposal is nil or too narrow (the table
    /// then scrolls); otherwise the space left over goes first to columns
    /// the cap made wrap, then evenly to all.
    static func columnWidths(natural: [CGFloat], proposed: CGFloat?) -> [CGFloat] {
        var widths = natural.map { min($0, maxColumnWidth) }
        guard let proposed, proposed.isFinite, !widths.isEmpty else { return widths }
        var extra = proposed - widths.reduce(0, +)
        guard extra > 0 else { return widths }
        let wrapped = natural.indices.filter { natural[$0] > widths[$0] }
        let deficit = wrapped.reduce(CGFloat(0)) { $0 + natural[$1] - widths[$1] }
        if deficit > 0 {
            let share = min(1, extra / deficit)
            for i in wrapped { widths[i] += (natural[i] - widths[i]) * share }
            extra -= min(extra, deficit)
        }
        if extra > 0 {
            for i in widths.indices { widths[i] += extra / CGFloat(widths.count) }
        }
        return widths
    }
}

enum ChipAction {
    case file(name: String)
    case copied(String)
    case link(URL)

    /// Routes a chip link (custom schemes) to the screen's handler.
    @MainActor
    static func handle(_ url: URL, _ onChipAction: (ChipAction) -> Void) {
        switch url.scheme {
        case "praxis-file":
            onChipAction(.file(name: url.host() ?? ""))
        case "praxis-code":
            let value = (url.host() ?? "").removingPercentEncoding ?? ""
            UIPasteboard.general.string = value
            onChipAction(.copied(value))
        case "praxis-link":
            let raw = String(url.absoluteString.dropFirst("praxis-link://".count))
                .removingPercentEncoding ?? ""
            if let target = URL(string: raw) { onChipAction(.link(target)) }
        case "https", "http":
            onChipAction(.link(url))
        default:
            break
        }
    }
}

/// Code block (§8): fill-1, hairline, 12pt radius, mono 13/20, horizontal
/// scroll with feathered edges, language label + glass Copy capsule.
struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false
    @State private var resetCopied: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language?.uppercased() ?? "CODE")
                    .font(Type.mono(10, weight: .medium, .caption2))
                    .tracking(0.8)
                    .foregroundStyle(Praxis.mutedInk)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    withAnimation(Motion.pop) { copied = true }
                    resetCopied?.cancel()
                    resetCopied = Task {
                        try? await Task.sleep(for: .seconds(1.2))
                        guard !Task.isCancelled else { return }
                        withAnimation(Motion.snap) { copied = false }
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 10, weight: .semibold))
                            .contentTransition(.symbolEffect(.replace))
                            .symbolEffect(.bounce, value: copied)
                        Text(copied ? "Copied" : "Copy")
                            .contentTransition(.opacity)
                            .font(Type.inter(11, weight: .medium, .caption2))
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                }
                .buttonStyle(.glass)
                .accessibilityLabel("Copy code")
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)

            // Feathered edges via an alpha mask: two live blur views per
            // code block made every transcript scroll pay for them.
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(Type.mono(13, .footnote))
                    .lineSpacing(7)
                    .foregroundStyle(Praxis.ink)
                    .padding(12)
            }
            .fadeEdges(.horizontal, length: 12)
        }
        .background(Praxis.fill1, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Praxis.hairline, lineWidth: 1))
    }
}

/// Quiet action row under a finished message (§8): 44pt targets, muted,
/// glass circle only while pressed.
struct MessageActionRow: View {
    let onCopy: () -> Void
    let onRetry: () -> Void
    let feedback: Turn.Feedback
    let onFeedback: (Turn.Feedback) -> Void
    let shareText: String

    var body: some View {
        HStack(spacing: 4) {
            actionButton("doc.on.doc", label: "Copy", action: onCopy)
            actionButton("arrow.counterclockwise", label: "Retry", action: onRetry)
            actionButton("hand.thumbsup", label: "Good response", filled: feedback == .up) {
                onFeedback(feedback == .up ? .none : .up)
            }
            actionButton("hand.thumbsdown", label: "Bad response", filled: feedback == .down) {
                onFeedback(feedback == .down ? .none : .down)
            }
            ShareLink(item: shareText) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 14))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel("Share")
            Spacer()
        }
        .foregroundStyle(Praxis.mutedInk)
    }

    private func actionButton(_ symbol: String, label: String, filled: Bool = false,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol + (filled ? ".fill" : ""))
                .font(.system(size: 14))
                .contentTransition(.symbolEffect(.replace))
                .symbolEffect(.bounce, value: filled)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel(label)
    }
}
