import SwiftUI

/// Level 3 — command execution view (spec §9). Card radius 8, hairline,
/// fill-1, clipped. Output shows a live tail with a feathered top edge;
/// "Show all" expands it inline. There is deliberately no nested vertical
/// ScrollView: one inside the transcript captured scroll drags that
/// started on it and never handed them back.
///
/// The model keeps at most `CommandData.maxLines` lines; older ones are
/// only counted. Everything but the newest line renders as one `Text`,
/// so a long log is one layout, not a view per line. The running clock
/// reads `startedAt` from the model: a card recreated mid-run keeps time.
struct CommandView: View {
    let command: CommandData
    @State private var showAll = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let tailCount = 8
    private var hiddenCount: Int { showAll ? 0 : max(command.lines.count - Self.tailCount, 0) }
    private var visibleLines: ArraySlice<String> { command.lines.dropFirst(hiddenCount) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Command line
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("$").font(Type.mono(12, weight: .semibold)).foregroundStyle(Praxis.mutedInk)
                Text(command.code)
                    .font(Type.mono(12, .caption))
                    .lineSpacing(6)
                    .foregroundStyle(Praxis.ink)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)

            // Meta row
            HStack(spacing: 12) {
                if command.isRunning {
                    TimelineView(.periodic(from: .now, by: 0.1)) { tl in
                        HStack(spacing: 12) {
                            Text("RUNNING")
                                .font(Type.mono(10, weight: .medium, .caption2)).tracking(0.8)
                                .foregroundStyle(Praxis.mutedInk)
                            Text(DurationFormatter.live(max(tl.date.timeIntervalSince(command.startedAt ?? tl.date), 0)))
                                .font(Type.mono(10, .caption2)).tracking(0.4)
                                .foregroundStyle(Praxis.mutedInk).monospacedDigit()
                        }
                    }
                } else if let exit = command.exitCode {
                    Text("EXIT \(exit)")
                        .font(Type.mono(10, weight: .medium, .caption2)).tracking(0.8)
                        .foregroundStyle(exit == 0 ? Praxis.success : Praxis.destructive)
                    Text(DurationFormatter.live(command.duration))
                        .font(Type.mono(10, .caption2)).tracking(0.4)
                        .foregroundStyle(Praxis.mutedInk).monospacedDigit()
                }
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .padding(.bottom, 10)

            if !command.lines.isEmpty {
                Rectangle().fill(Praxis.hairline).frame(height: 1)
                VStack(alignment: .leading, spacing: 2) {
                    if showAll && command.droppedLineCount > 0 {
                        Text("\(command.droppedLineCount) earlier lines not kept")
                            .font(Type.mono(10, weight: .medium, .caption2)).tracking(0.4)
                            .foregroundStyle(Praxis.mutedInk)
                    }
                    if visibleLines.count > 1 {
                        outputText(visibleLines.dropLast().joined(separator: "\n"))
                    }
                    // The newest line fades in on its own; when the next
                    // one lands it joins the static block in place.
                    if let newest = visibleLines.last {
                        outputText(newest)
                            .id(command.totalLineCount)
                            .appearFade()
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .fadeEdges(.vertical, length: 16, leading: hiddenCount > 0, trailing: false)

                if hiddenCount > 0 || (showAll && command.lines.count > Self.tailCount) {
                    let total = command.totalLineCount
                    Button {
                        withAnimation(reduceMotion ? Motion.reduced : Motion.reflow) { showAll.toggle() }
                    } label: {
                        Text(showAll ? "Show less" : "Show all \(total) lines")
                            .font(Type.mono(10, weight: .medium, .caption2)).tracking(0.4)
                            .foregroundStyle(Praxis.mutedInk)
                            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                            .padding(.horizontal, 12)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(PressScaleStyle(scale: 0.99))
                }
            } else if let result = command.result, !result.isEmpty, !command.isRunning {
                // No console output: the return value stands in for it.
                Rectangle().fill(Praxis.hairline).frame(height: 1)
                outputText(result)
                    .lineLimit(12)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
        }
        .background(Praxis.fill1, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Praxis.hairline, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    /// Line gap matches the gap between separate lines (2pt), so the
    /// static block and the newest line read as one log.
    private func outputText(_ text: String) -> some View {
        Text(text)
            .font(Type.mono(11, .caption2))
            .lineSpacing(2)
            .foregroundStyle(Praxis.mutedInk)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
