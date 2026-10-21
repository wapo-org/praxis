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
struct AgentMessageView: View {
    let source: String
    let isStreaming: Bool
    var onChipAction: (ChipAction) -> Void = { _ in }

    @State private var blocks: [MDBlock] = []
    @State private var streamStart = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { blocks = PraxisMarkdown.parse(source); streamStart = Date() }
        .onChange(of: source) { _, new in
            // Only the streaming tail re-parses; finished content is stable
            // because block views are keyed by offset + content hash.
            blocks = PraxisMarkdown.parse(new)
        }
    }

    @ViewBuilder
    private func blockView(_ block: MDBlock) -> some View {
        switch block {
        case .heading(_, let text):
            chipText(text)
                .lineSpacing(6)
                .textRenderer(ChipTextRenderer())
                .selectionLayer(text, lineSpacing: 6, enabled: !isStreaming, onLink: handleChipURL)
                .padding(.top, 8)
        case .paragraph(let text):
            paragraph(text)
        case .list(let ordered, let items):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(ordered ? "\(i + 1)." : "•")
                            .font(Type.inter(17))
                            .foregroundStyle(Praxis.mutedInk)
                            .monospacedDigit()
                        paragraph(item)
                    }
                }
            }
        case .quote(let text):
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(Praxis.secondaryInk)
                    .frame(width: 2)
                chipText(text)
                    .font(Type.inter(15, .callout))
                    .foregroundStyle(Praxis.secondaryInk)
                    .lineSpacing(9)
                    .textRenderer(ChipTextRenderer())
                    .selectionLayer(text, lineSpacing: 9, font: Type.inter(15, .callout),
                                    enabled: !isStreaming, onLink: handleChipURL)
                    .padding(.leading, 16)
            }
        case .code(let language, let code):
            CodeBlockView(language: language, code: code)
        case .rule:
            Rectangle().fill(Praxis.hairline).frame(height: 1)
        }
    }

    private func paragraph(_ text: AttributedString) -> some View {
        Group {
            if isStreaming {
                TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { timeline in
                    let elapsed = timeline.date.timeIntervalSince(streamStart)
                    chipText(text)
                        .bodyLineSpacing()
                        .textRenderer(ChipTextRenderer(revealedWords: elapsed * 26))
                }
            } else {
                chipText(text)
                    .bodyLineSpacing()
                    .textRenderer(ChipTextRenderer())
                    .selectionLayer(text, lineSpacing: 10, enabled: true, onLink: handleChipURL)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            handleChipURL(url)
            return .handled
        })
    }

    private func handleChipURL(_ url: URL) {
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

enum ChipAction {
    case file(name: String)
    case copied(String)
    case link(URL)
}

/// Code block (§8): fill-1, hairline, 12pt radius, mono 13/20, horizontal
/// scroll with feathered edges, language label + glass Copy capsule.
struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = false

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
                    withAnimation(Motion.snap) { copied = true }
                    Task { try? await Task.sleep(for: .seconds(1.2)); copied = false }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 10, weight: .semibold))
                            .contentTransition(.symbolEffect(.replace))
                        Text(copied ? "Copied" : "Copy")
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

            ZStack {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(code)
                        .font(Type.mono(13, .footnote))
                        .lineSpacing(7)
                        .foregroundStyle(Praxis.ink)
                        .padding(12)
                }
                HStack {
                    ProgressiveBlurScrim(edge: .leading, length: 16, maxRadius: 6)
                    Spacer()
                    ProgressiveBlurScrim(edge: .trailing, length: 16, maxRadius: 6)
                }
            }
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
                .frame(width: 44, height: 44)
                .contentShape(Circle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel(label)
    }
}
