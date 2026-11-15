import SwiftUI

/// Attaches layout markers via customAttribute for Text.Layout renderers.
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

/// Equatable parsed message view; stable block IDs avoid re-renders on stream.
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

/// Renders one block per lazy row so transcript height estimates stay accurate.
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

/// Observes LiveText per streaming row so only the active row animates.
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
            // Only ticks 30 Hz timeline while the reveal front crosses rows.
            let moving = !reduceMotion && live.isRevealing
                && motion.touches(item.fadeStart, item.fadeEnd + ChipTextRenderer.fadeSpan)
            TimelineView(.animation(minimumInterval: RevealMotion.frameInterval, paused: !moving)) { context in
                let front = moving ? motion.value(at: context.date) : motion.to
                MarkdownBlockView(item: item,
                                  revealed: clampedReveal(front, for: item, reduceMotion: reduceMotion),
                                  selectable: !live.isStreaming, onLink: { ChipAction.handle($0, onChipAction) })
                    .equatable()
            }
        }
    }
}

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

/// Clamps reveal range per block so only the active row animates.
private func clampedReveal(_ revealed: Double, for item: MDBlockItem, reduceMotion: Bool) -> Double {
    guard revealed.isFinite, !reduceMotion else { return .infinity }
    return min(max(revealed, item.fadeStart), item.fadeEnd + ChipTextRenderer.fadeSpan)
}

/// Equatable per block so finished paragraphs skip body during streaming.
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

/// Uses AnyView to permit recursive nested block layouts.
private struct MarkdownBlockContent: View {
    let block: MDBlock
    let renderer: ChipTextRenderer
    let selectable: Bool
    var onLink: (URL) -> Void
    var inQuote = false
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

    /// Keeps single text structure so enabling selection never resets reveal.
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

/// Single horizontal ScrollView avoids ViewThatFits re-measure thrash.
struct MarkdownTableView: View {
    let table: MDTable
    let renderer: ChipTextRenderer
    @State private var containerWidth: CGFloat = 0
    @State private var contentWidth: CGFloat = 0

    /// Masks and gestures share the same frame so scroll toggling never oscillates.
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

/// Caches column widths and equalizes row heights across cells.
struct TableGrid: Layout {
    let columns: Int
    var minWidth: CGFloat = 0
    static let maxColumnWidth: CGFloat = 220

    struct Cache {
        var natural: [CGFloat] = []
        /// Caches layout for last width since sizing and placing query repeatedly.
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

    /// Caps columns to scroll overflow; expands wrapped columns first with extra space.
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

            // Alpha-mask edges replace live blur views that slowed scrolling.
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
