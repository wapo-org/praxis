import SwiftUI

/// Where older history was condensed for the model: a thin hairline
/// divider with a quiet caption, "Earlier messages summarized". Tapping it
/// shows the summary read-only — what the model now remembers of
/// everything above. The thread itself stays whole.
struct CompactionMarkerRow: View, Equatable {
    let marker: CompactionMarker
    @State private var showsSummary = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.marker == rhs.marker }

    private var canOpen: Bool {
        switch marker.state {
        case .done: !marker.summary.isEmpty
        case .failed: true
        case .running: false
        }
    }

    var body: some View {
        Button { showsSummary = true } label: { label }
            .buttonStyle(PressScaleStyle())
            .disabled(!canOpen)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(CompactionActivity.accessibilityLabel(marker))
            .accessibilityHint(canOpen ? (marker.state == .done ? "Shows what the model remembers of earlier messages" : "Shows why") : "")
            .accessibilityAddTraits(canOpen ? .isButton : [])
            .accessibilityRemoveTraits(canOpen ? [] : .isButton)
            .accessibilityIdentifier("compactionMarker")
            .sheet(isPresented: $showsSummary) { CompactionSummarySheet(marker: marker) }
    }

    private var label: some View {
        HStack(spacing: 10) {
            hairline
            HStack(spacing: 6) {
                if marker.state == .running {
                    ProgressView().controlSize(.mini).tint(Praxis.mutedInk)
                } else {
                    Image(systemName: marker.state == .done ? "rectangle.compress.vertical" : "exclamationmark.circle")
                        .font(.system(size: 11, weight: .medium))
                }
                Text(CompactionActivity.title(marker))
                    .font(Type.inter(12, weight: .medium, .caption))
                    .lineLimit(1)
                if canOpen {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                }
            }
            .foregroundStyle(Praxis.mutedInk)
            .layoutPriority(1)
            hairline
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .animation(reduceMotion ? Motion.reduced : Motion.snap, value: marker.state)
    }

    private var hairline: some View {
        Rectangle().fill(Praxis.hairline).frame(height: 1).frame(maxWidth: .infinity)
    }
}

/// The compaction summary, read-only.
struct CompactionSummarySheet: View {
    let marker: CompactionMarker
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(intro)
                        .font(Type.inter(15, .body))
                        .foregroundStyle(Praxis.secondaryInk)
                        .lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)
                    if case .failed(let reason) = marker.state {
                        Text(reason)
                            .font(Type.inter(13, .footnote))
                            .foregroundStyle(Praxis.mutedInk)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    } else {
                        if let sizes = CompactionActivity.sizes(before: marker.tokensBefore, after: marker.tokensAfter) {
                            Text("\(marker.date.formatted(date: .abbreviated, time: .shortened)) · \(sizes)")
                                .font(Type.inter(12, .caption))
                                .foregroundStyle(Praxis.mutedInk)
                        }
                        SettingsCard {
                            Text(Self.rendered(marker.summary))
                                .font(Type.inter(15, .body))
                                .foregroundStyle(Praxis.ink)
                                .lineSpacing(5)
                                .textSelection(.enabled)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(16)
                                .accessibilityIdentifier("compactionSummary")
                        }
                    }
                }
                .padding(20)
            }
            .background(Praxis.canvas)
            .navigationTitle(marker.state == .done ? "What the model remembers" : "Summary failed")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var intro: String {
        if case .failed = marker.state {
            return "Praxis tried to condense the earlier messages to fit the model's context window but couldn't, so the run carried on with the full history."
        }
        return "To stay within the model's context window, the messages above this point were condensed into the summary below. The model now sees this summary instead of them; your full thread stays here."
    }

    /// Inline markdown (bold, code, links) with the summary's own line breaks.
    static func rendered(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}

#Preview("Compaction marker") {
    VStack(spacing: 24) {
        CompactionMarkerRow(marker: CompactionMarker(key: "a", state: .running))
        CompactionMarkerRow(marker: CompactionMarker(key: "b", state: .done, summary: "The user is auditing **glass contrast**; fixes so far: composer, tray.",
                                                     tokensBefore: 120_000, tokensAfter: 9_000))
        CompactionMarkerRow(marker: CompactionMarker(key: "c", state: .failed("Couldn't summarize earlier messages: HTTP 500")))
    }
    .padding(20)
    .background(Praxis.canvas)
}
