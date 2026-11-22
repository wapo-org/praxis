import SwiftUI
import AgentCore

/// Three-level expandable activity row; pending approvals surface even when folded.
struct AgentActivityView: View, Equatable {
    let activity: ActivityData
    let turnID: UUID
    var onToggle: (Bool) -> Void = { _ in }
    var onCommandToggle: (UUID, Bool) -> Void = { _, _ in }
    var onApproval: (String, ApprovalDecision) -> Void = { _, _ in }

    /// Ignore closures in Equatable so streaming skips unaffected activity rows.
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.turnID == rhs.turnID && lhs.activity == rhs.activity
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            // Keep sign-in bar visible even when collapsed.
            ConnectorSignInBar(steps: activity.steps)
            if activity.isExpanded {
                steps
                    // Opacity-only exit avoids spilling over above rows or ghosting under text.
                    .transition(.asymmetric(
                        insertion: .opacity.animation(Motion.reveal.delay(Motion.handoff)),
                        removal: .opacity.animation(Motion.exit)))
            } else {
                ForEach(activity.steps.filter(\.isWaitingOnUser)) { step in
                    ApprovalStack(step: step, onApproval: onApproval)
                        .padding(.top, 4)
                }
            }
        }
        .clipped()
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.reflow, value: activity.isExpanded)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(activity.isRunning ? "Agent activity, currently working" : "Agent activity, \(activity.label)")
    }

    private var header: some View {
        Button {
            onToggle(!activity.isExpanded)
        } label: {
            HStack(spacing: 8) {
                LucideIcon(name: "chevron-right", size: 14)
                    .foregroundStyle(Praxis.mutedInk)
                    .rotationEffect(.degrees(activity.isExpanded ? 90 : 0))
                    .animation(reduceMotion ? Motion.reduced : Motion.snap, value: activity.isExpanded)
                // Swap working and done labels sequentially so numeric morph never overlaps.
                ZStack(alignment: .leading) {
                    Group {
                        if activity.isRunning && !reduceMotion {
                            ShimmerText(text: activity.label)
                        } else {
                            Text(activity.label)
                        }
                    }
                    .id(activity.label)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(y: 3))
                            .animation(Motion.reveal.delay(Motion.handoff)),
                        removal: .opacity.animation(Motion.exit)))
                }
                .font(Type.inter(13, weight: .medium, .caption))
                .foregroundStyle(Praxis.mutedInk)
                .lineLimit(1)
                .truncationMode(.tail)
                .fixedSize(horizontal: true, vertical: false)
                .animation(Motion.reveal, value: activity.label)
                // Overlay live step label so next call fades in cleanly in place.
                ZStack(alignment: .leading) {
                    if !activity.isExpanded, let step = activity.liveStep {
                        LiveStepLine(step: step)
                            .id(step.id)
                            .transition(.asymmetric(
                                insertion: .opacity.animation(Motion.reveal),
                                removal: .opacity.animation(Motion.exit)))
                    }
                }
            }
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle(scale: 0.99))
        .accessibilityLabel(activity.isExpanded ? "Hide agent activity" : "Show agent activity")
        .accessibilityValue(headerValue)
    }

    private var headerValue: String {
        guard !activity.isExpanded, let step = activity.liveStep else { return activity.label }
        return "\(activity.label) \(step.accessibilityLine)"
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(activity.steps) { step in
                StepRow(step: step, onToggle: { open in
                    onCommandToggle(step.id, open)
                }, onApproval: onApproval)
                // Opacity fade avoids animating height against bottom transcript anchor.
                .appearFade()
            }
        }
    }
}

private struct StepRow: View {
    let step: Step
    var onToggle: (Bool) -> Void = { _ in }
    var onApproval: (String, ApprovalDecision) -> Void = { _, _ in }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var isOpen: Bool { step.isOpen }
    private var canOpen: Bool { step.hasDetails }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if canOpen {
                Button { onToggle(!isOpen) } label: { line }
                    .buttonStyle(PressScaleStyle(scale: 0.99))
                    .accessibilityLabel(buttonLabel)
                    .accessibilityValue(isOpen ? "Expanded" : "Collapsed")
                    .accessibilityHint(isOpen ? "Hides the details" : "Shows the details")
                    .accessibilityIdentifier("activityStep")
            } else {
                line
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(step.accessibilityLine)
                    .accessibilityIdentifier("activityStep")
            }

            ApprovalStack(step: step, onApproval: onApproval)
                .padding(.top, 4)

            if isOpen && canOpen {
                StepDetails(step: step)
                    .transition(reduceMotion ? .opacity : .asymmetric(
                        insertion: .opacity.animation(Motion.reveal),
                        removal: .opacity.animation(Motion.exit)))
            }
        }
        // Clip to animating frame so details expand cleanly without overdraw.
        .clipped()
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.reflow, value: isOpen)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.reflow, value: step.isWaitingOnUser)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : Motion.reflow,
                   value: step.codeApprovals.map(\.requestID))
    }

    private var buttonLabel: String {
        if step.command != nil {
            return "\(isOpen ? "Hide" : "Show") command details: \(step.finalSummary)"
        }
        return step.accessibilityLine
    }

    private var line: some View {
        HStack(alignment: .center, spacing: 8) {
            // Isolates Core Animation pulse so stopped runs draw zero idle frames.
            if step.isRunning && !reduceMotion {
                PulsingLucideIcon(name: step.kind.lucide, size: 14)
                    .frame(width: 14, height: 18)
            } else {
                LucideIcon(name: step.kind.lucide, size: 14)
                    .foregroundStyle(Praxis.mutedInk)
                    .frame(height: 18)
            }
            lineText
                .font(Type.inter(13, .caption))
                .lineLimit(1)
                .truncationMode(.tail)
                .foregroundStyle(Praxis.mutedInk)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentTransition(.opacity)
            if let tag = step.statusTag {
                Text(tag)
                    .font(Type.inter(11, weight: .medium, .caption2))
                    .foregroundStyle(step.status == .failed ? Praxis.destructive : Praxis.mutedInk)
                    .lineLimit(1)
                    .fixedSize()
            }
            if canOpen {
                LucideIcon(name: "chevron-right", size: 12)
                    .foregroundStyle(Praxis.mutedInk.opacity(0.7))
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
                    .animation(reduceMotion ? Motion.reduced : Motion.snap, value: isOpen)
            }
        }
        .padding(.vertical, 2)
        .frame(minHeight: 28)
        .contentShape(Rectangle())
    }

    private var lineText: Text { Text(stepLine: step) }
}

private extension Text {
    init(stepLine step: Step) {
        let body = Text(step.lineBody)
        if let source = step.source {
            self = Text("\(Text("\(source) · ").fontWeight(.medium))\(body)")
        } else {
            self = body
        }
    }
}

private struct LiveStepLine: View {
    let step: Step

    var body: some View {
        HStack(spacing: 6) {
            Text("·")
            LucideIcon(name: step.kind.lucide, size: 12)
            Text(stepLine: step)
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .font(Type.inter(13, .caption))
        .foregroundStyle(Praxis.mutedInk.opacity(0.8))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityHidden(true)
    }
}

private struct StepDetails: View {
    let step: Step

    private var resultLabel: String {
        if step.status == .failed { return "Error" }
        return step.kind == .think ? "Thinking" : "Result"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let note = step.outcomeNote {
                Text(note)
                    .font(Type.inter(12, .caption))
                    .lineSpacing(3)
                    .foregroundStyle(Praxis.secondaryInk)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let command = step.command {
                CommandView(command: command)
            }
            if let arguments = step.arguments, !arguments.isEmpty {
                DetailBlock(label: "Call", text: arguments, lines: 14)
            }
            if let result = step.result, !result.isEmpty {
                DetailBlock(label: resultLabel, text: result, lines: step.kind == .think ? 20 : 14,
                            isError: step.status == .failed)
            }
            if !step.visibleTraces.isEmpty {
                TraceList(traces: step.visibleTraces, droppedCount: step.droppedTraceCount,
                          fromCode: step.command != nil)
            }
        }
        .padding(.leading, 22)
        .padding(.top, 2)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
    }
}

/// Clamped line count avoids nested scrolling inside transcript.
private struct DetailBlock: View {
    let label: String
    let text: String
    let lines: Int
    var isError = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(Type.mono(10, weight: .medium, .caption2))
                .tracking(0.8)
                .foregroundStyle(isError ? Praxis.destructive : Praxis.mutedInk)
            Text(text)
                .font(Type.mono(11, .caption2))
                .lineSpacing(3)
                .lineLimit(lines)
                .truncationMode(.tail)
                .foregroundStyle(Praxis.secondaryInk)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(Praxis.fill2.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityLabel(label)
                .accessibilityValue(text)
        }
    }
}

private struct TraceList: View {
    let traces: [Trace]
    let droppedCount: Int
    let fromCode: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if droppedCount > 0 {
                Text("\(droppedCount) earlier traces not kept")
                    .font(Type.mono(10, weight: .medium, .caption2)).tracking(0.4)
                    .foregroundStyle(Praxis.mutedInk)
            }
            if fromCode && traces.contains(where: { $0.kind == .api }) {
                Text("CALLS FROM CODE")
                    .font(Type.mono(10, weight: .medium, .caption2))
                    .tracking(0.8)
                    .foregroundStyle(Praxis.mutedInk)
            }
            ForEach(traces) { trace in
                HStack(alignment: .top, spacing: 8) {
                    LucideIcon(name: trace.kind == .skill ? "wrench" : "waypoints", size: 14)
                        .foregroundStyle(Praxis.mutedInk)
                        .frame(height: 16)
                    if trace.kind == .image, let attachment = trace.attachment {
                        HStack(spacing: 8) {
                            AttachmentThumbnail(attachment: attachment, size: 56)
                            Text(trace.text)
                                .font(Type.mono(12, .caption))
                                .lineSpacing(4)
                                .foregroundStyle(Praxis.mutedInk)
                        }
                    } else {
                        Text(trace.text)
                            .font(Type.mono(11, .caption2))
                            .lineSpacing(3)
                            .lineLimit(3)
                            .truncationMode(.tail)
                            .foregroundStyle(Praxis.mutedInk)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }
}

private struct ApprovalStack: View {
    let step: Step
    var onApproval: (String, ApprovalDecision) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if step.isWaitingOnUser {
            VStack(alignment: .leading, spacing: 4) {
                if let approval = step.approval {
                    card(approval)
                }
                ForEach(step.codeApprovals, id: \.requestID) { card($0) }
            }
        }
    }

    private func card(_ approval: PendingApproval) -> some View {
        ApprovalCard(approval: approval, onDecision: { onApproval(approval.requestID, $0) })
            .padding(.bottom, 8)
            .transition(reduceMotion ? .opacity : .asymmetric(
                insertion: .opacity.animation(Motion.reveal),
                removal: .opacity.animation(Motion.exit)))
    }
}

private struct ApprovalCard: View {
    let approval: PendingApproval
    var onDecision: (ApprovalDecision) -> Void

    private var fromCode: Bool { approval.parentCallID != nil }

    private var origin: String {
        let tool = ([approval.sourceName, approval.toolName].compactMap { $0 }).joined(separator: " · ")
        return fromCode ? "From code: \(tool)" : tool
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                LucideIcon(name: fromCode ? "file-code-2" : approval.sourceName == nil ? "waypoints" : "link-2", size: 12)
                Text(origin)
                    .font(Type.mono(10, weight: .medium, .caption2))
                    .tracking(0.4)
                    .lineLimit(1)
            }
            .foregroundStyle(Praxis.mutedInk)

            VStack(alignment: .leading, spacing: 2) {
                Text(approval.title)
                    .font(Type.inter(15, weight: .semibold, .body))
                    .foregroundStyle(Praxis.ink)
                Text(approval.reason)
                    .font(Type.inter(13, .footnote))
                    .foregroundStyle(Praxis.secondaryInk)
                if fromCode {
                    Text("The code above is calling this tool. It waits for your answer.")
                        .font(Type.inter(13, .footnote))
                        .foregroundStyle(Praxis.mutedInk)
                }
            }

            if !approval.arguments.isEmpty, approval.arguments != "{}" {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(approval.arguments)
                        .font(Type.mono(11, .caption2))
                        .lineSpacing(5)
                        .foregroundStyle(Praxis.secondaryInk)
                        .fixedSize(horizontal: true, vertical: true)
                        .padding(10)
                }
                .fadeEdges(.horizontal, length: 10)
                .background(Praxis.fill2.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityLabel("Arguments")
                .accessibilityValue(approval.arguments)
            }

            HStack(spacing: 8) {
                choice("Allow once", weight: .semibold) { onDecision(.allowOnce) }
                choice("Always allow") { onDecision(.allowAlways) }
                Spacer(minLength: 0)
                choice("Deny") { onDecision(.deny) }
            }
        }
        .padding(12)
        .background(Praxis.fill1, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Praxis.hairline, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(fromCode ? "Approval needed, \(origin): \(approval.title)" : "Approval needed: \(approval.title)")
    }

    private func choice(_ title: String, weight: Font.Weight = .medium, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(Type.inter(13, weight: weight, .footnote))
                .foregroundStyle(Praxis.ink)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .frame(minHeight: 32)
        }
        .buttonStyle(.glass)
        .accessibilityLabel(title)
    }
}
