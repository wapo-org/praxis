import SwiftUI

/// The Praxis AgentActivity object (spec §9) — one expanding object,
/// three levels. Disclosure header → step rows → command card.
/// Hit areas ≥44pt; VoiceOver reads as a disclosure group.
struct AgentActivityView: View {
    let activity: ActivityData
    let turnID: UUID
    var onToggle: (Bool) -> Void = { _ in }
    var onCommandToggle: (UUID, Bool) -> Void = { _, _ in }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if activity.isExpanded {
                steps
                    // Opacity only: sliding from the top edge made the
                    // rows spill over whatever sits above the header.
                    .transition(.opacity)
            }
        }
        .clipped()
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.reflow, value: activity.isExpanded)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(activity.isRunning ? "Agent activity, currently working" : "Agent activity, \(activity.label)")
    }

    // Level 1 — disclosure header
    private var header: some View {
        Button {
            onToggle(!activity.isExpanded)
        } label: {
            HStack(spacing: 8) {
                LucideIcon(name: "chevron-right", size: 14)
                    .foregroundStyle(Praxis.mutedInk)
                    .rotationEffect(.degrees(activity.isExpanded ? 90 : 0))
                Group {
                    if activity.isRunning && !reduceMotion {
                        ShimmerLabel(text: activity.label)
                    } else {
                        Text(activity.label)
                            .contentTransition(.numericText())
                    }
                }
                .font(Type.inter(13, weight: .medium, .caption))
                .foregroundStyle(Praxis.mutedInk)
                .lineLimit(1)
                .truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.99))
        .accessibilityLabel(activity.isExpanded ? "Hide agent activity" : "Show agent activity")
        .accessibilityValue(activity.label)
    }

    // Level 2 — step rows (4pt below header, 4pt between rows)
    private var steps: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(activity.steps) { step in
                StepRow(step: step) { expanded in
                    onCommandToggle(step.id, expanded)
                }
                .transition(.opacity)
            }
        }
        .padding(.top, 4)
    }
}

private struct StepRow: View {
    let step: Step
    var onCommandToggle: (Bool) -> Void = { _ in }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if step.command != nil {
                Button { onCommandToggle(!(step.command?.isExpanded ?? false)) } label: { rowContent }
                    .buttonStyle(PressScaleStyle(scale: 0.99))
                    .accessibilityLabel((step.command?.isExpanded ?? false)
                        ? "Hide command details: \(step.finalSummary)"
                        : "Show command details: \(step.finalSummary)")
            } else {
                rowContent
            }

            // Micro-traces flush left with the row icon (no indent)
            if !step.traces.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(step.traces) { trace in
                        HStack(alignment: .top, spacing: 8) {
                            LucideIcon(name: trace.kind == .skill ? "wrench" : "waypoints", size: 14)
                                .foregroundStyle(Praxis.mutedInk)
                                .frame(height: 16)
                            if trace.kind == .image, let data = trace.thumbnailData {
                                HStack(spacing: 8) {
                                    AttachmentThumbnail(
                                        attachment: Attachment(kind: .screenshot, name: trace.text, imageData: data),
                                        size: 56)
                                    Text(trace.text)
                                        .font(Type.mono(12, .caption))
                                        .lineSpacing(4)
                                        .foregroundStyle(Praxis.mutedInk)
                                }
                            } else {
                                Text(trace.text)
                                    .font(Type.mono(12, .caption))
                                    .lineSpacing(4)
                                    .foregroundStyle(Praxis.mutedInk)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            // Level 3 — command card (4pt above, 8pt below)
            if let command = step.command, command.isExpanded {
                CommandView(command: command)
                    .padding(.top, 4)
                    .padding(.bottom, 8)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 4)))
            }
        }
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.reflow,
                   value: step.command?.isExpanded)
        .onAppear { pulse = true }
    }

    private var rowContent: some View {
        HStack(alignment: .center, spacing: 8) {
            LucideIcon(name: step.kind.lucide, size: 14)
                .foregroundStyle(Praxis.mutedInk)
                .frame(height: 18)
                .opacity(step.isRunning && !reduceMotion ? (pulse ? 0.45 : 1) : 1)
                .animation(step.isRunning && !reduceMotion
                    ? .easeInOut(duration: 0.8).repeatForever(autoreverses: true) : Motion.snap,
                    value: pulse)
            Text(step.isRunning ? step.runningSummary : step.finalSummary)
                .font(Type.inter(13, .caption))
                .lineSpacing(5)
                .foregroundStyle(Praxis.mutedInk)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentTransition(.opacity)
            if step.command != nil {
                LucideIcon(name: "chevron-right", size: 14)
                    .foregroundStyle(Praxis.mutedInk)
                    .rotationEffect(.degrees((step.command?.isExpanded ?? false) ? 90 : 0))
            }
        }
        .padding(.vertical, 4)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .animation(Motion.snap, value: step.command?.isExpanded)
    }
}

/// Soft shimmer sweeping the running header every ~1.6s (§10).
private struct ShimmerLabel: View {
    let text: String
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1.0 / 30.0)) { tl in
            let phase = (tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.6)) / 1.6
            Text(text)
                .foregroundStyle(
                    LinearGradient(
                        colors: [Praxis.mutedInk, Praxis.ink, Praxis.mutedInk],
                        startPoint: UnitPoint(x: phase * 2 - 1, y: 0.5),
                        endPoint: UnitPoint(x: phase * 2, y: 0.5))
                )
        }
    }
}
