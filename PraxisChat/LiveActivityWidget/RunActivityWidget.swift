import ActivityKit
import SwiftUI
import WidgetKit

/// Live Activity views for one agent run (BACKGROUND_PLAN.md §3.2):
/// lock screen + Dynamic Island compact/minimal/expanded.
/// Monochrome and calm per the app doctrine; no buttons (§2.5),
/// no custom animations (the system animates content changes
/// itself). Tapping anywhere deep-links to the chat.
struct RunActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: RunActivityAttributes.self) { context in
            RunLockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    RunExpandedTitleView(context: context)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    RunExpandedTimerView(context: context)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    RunExpandedDetailView(context: context)
                }
            } compactLeading: {
                RunGlyphView(phase: context.state.phase, isStale: context.isStale)
            } compactTrailing: {
                RunCompactTextView(context: context)
            } minimal: {
                RunGlyphView(phase: context.state.phase, isStale: context.isStale,
                             accessibilityLabel: context.voiceOverSummary)
            }
            .widgetURL(context.chatURL)
        }
    }
}

// MARK: - Shared presentation helpers (widget-local; the extension
// links neither the app nor the package, so phase display strings
// live here, next to the views that render them).

extension RunPhase {
    /// SF Symbol for the island glyph (monochrome, static — the
    /// system ignores animation modifiers in Live Activities).
    fileprivate var glyphName: String {
        switch self {
        case .thinking: return "circle.fill"
        case .runningTool: return "circle.fill"
        case .needsApproval: return "exclamationmark.circle.fill"
        case .done: return "checkmark.circle.fill"
        case .failed: return "xmark.circle.fill"
        case .paused: return "pause.circle.fill"
        }
    }

    /// One or two words for the compact island + VoiceOver.
    fileprivate var shortText: String {
        switch self {
        case .thinking: return "Working"
        case .runningTool: return "Tool"
        case .needsApproval: return "Approval"
        case .done: return "Done"
        case .failed: return "Failed"
        case .paused: return "Paused"
        }
    }

    fileprivate var isTerminal: Bool {
        self == .done || self == .failed || self == .paused
    }
}

extension ActivityViewContext<RunActivityAttributes> {
    /// praxis-app://chat/<conversationID> (§3.6).
    fileprivate var chatURL: URL? {
        URL(string: "praxis-app://chat/\(attributes.conversationID.uuidString)")
    }

    fileprivate var voiceOverSummary: String {
        if isStale {
            return "Praxis run, updating. \(attributes.chatTitle)."
        }
        let step = state.stepCount > 0 ? ", step \(state.stepCount)" : ""
        return "Praxis run\(step), \(state.phase.shortText). \(attributes.chatTitle). \(state.lastLine)"
    }
}

// MARK: - Lock screen

private struct RunLockScreenView: View {
    let context: ActivityViewContext<RunActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(context.attributes.chatTitle)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 8)
                // A running timer is only truthful mid-run; terminal
                // states show the step count instead (the state has
                // no end time to freeze a timer against).
                if context.state.phase.isTerminal {
                    Text("· \(context.state.stepCount) steps")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Text(context.state.startedAt, style: .timer)
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(context.state.lastLine)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(spacing: 4) {
                Text(context.attributes.modelName)
                if context.state.stepCount > 0 {
                    Text("· Step \(context.state.stepCount)")
                }
                if context.isStale {
                    Text("· Updating…")
                }
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // The lock card provides ~no leading inset of its own: without
        // this the top and bottom rows' first glyphs clip on the
        // card's rounded corners (verified on-device).
        .padding(.horizontal)
        .opacity(context.isStale ? 0.6 : 1)
        .widgetURL(context.chatURL)
        .accessibilityLabel(context.voiceOverSummary)
    }
}

// MARK: - Dynamic Island

/// Compact leading + minimal: the monochrome phase glyph. Only one
/// island presentation is visible at a time, and within compact mode
/// the trailing text carries the label — so the glyph is hidden from
/// VoiceOver unless it is the whole presentation (minimal).
private struct RunGlyphView: View {
    let phase: RunPhase
    let isStale: Bool
    var accessibilityLabel: String?

    var body: some View {
        Image(systemName: phase.glyphName)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.primary)
            .opacity(isStale ? 0.5 : 1)
            .accessibilityHidden(accessibilityLabel == nil)
            .accessibilityLabel(accessibilityLabel ?? "")
    }
}

/// Compact trailing: the tool's short name, else the step count,
/// else the phase word. Stale reads as "Updating…".
private struct RunCompactTextView: View {
    let context: ActivityViewContext<RunActivityAttributes>

    private var text: String {
        if context.isStale { return "Updating…" }
        if let tool = context.state.toolName, !tool.isEmpty { return tool }
        if context.state.stepCount > 0 { return "Step \(context.state.stepCount)" }
        return context.state.phase.shortText
    }

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .foregroundStyle(.primary)
            .opacity(context.isStale ? 0.6 : 1)
            .accessibilityLabel(context.voiceOverSummary)
    }
}

private struct RunExpandedTitleView: View {
    let context: ActivityViewContext<RunActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(context.attributes.chatTitle)
                .font(.headline)
                .lineLimit(1)
            Text(context.attributes.modelName)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .opacity(context.isStale ? 0.6 : 1)
        .accessibilityLabel(context.voiceOverSummary)
    }
}

private struct RunExpandedTimerView: View {
    let context: ActivityViewContext<RunActivityAttributes>

    var body: some View {
        Group {
            if context.state.phase.isTerminal {
                Text("\(context.state.stepCount) steps")
            } else {
                Text(context.state.startedAt, style: .timer)
            }
        }
        .font(.subheadline.monospacedDigit())
        .foregroundStyle(.secondary)
        .opacity(context.isStale ? 0.6 : 1)
        .accessibilityHidden(true) // the island's label covers it.
    }
}

private struct RunExpandedDetailView: View {
    let context: ActivityViewContext<RunActivityAttributes>

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(context.isStale ? "Updating…" : context.state.lastLine)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .lineLimit(2)
            Spacer()
            if context.state.stepCount > 0 {
                Text("Step \(context.state.stepCount)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .opacity(context.isStale ? 0.7 : 1)
        .accessibilityHidden(true) // the island's label covers it.
    }
}

// MARK: - Previews

private extension RunActivityAttributes {
    static var preview: RunActivityAttributes {
        RunActivityAttributes(conversationID: UUID(), chatTitle: "Fix the login bug",
                              modelName: "GPT-5.2")
    }
}

private extension RunActivityAttributes.ContentState {
    static var previewThinking: RunActivityAttributes.ContentState {
        RunActivityAttributes.ContentState(phase: .thinking, stepCount: 2,
                                           startedAt: Date().addingTimeInterval(-95),
                                           lastLine: "Thinking…", toolName: nil)
    }

    static var previewTool: RunActivityAttributes.ContentState {
        RunActivityAttributes.ContentState(phase: .runningTool, stepCount: 3,
                                           startedAt: Date().addingTimeInterval(-120),
                                           lastLine: "Reading AuthView.swift…", toolName: "read")
    }

    static var previewApproval: RunActivityAttributes.ContentState {
        RunActivityAttributes.ContentState(phase: .needsApproval, stepCount: 4,
                                           startedAt: Date().addingTimeInterval(-180),
                                           lastLine: "Needs approval: shell", toolName: "shell")
    }

    static var previewDone: RunActivityAttributes.ContentState {
        RunActivityAttributes.ContentState(phase: .done, stepCount: 6,
                                           startedAt: Date().addingTimeInterval(-240),
                                           lastLine: "Done · 6 steps · 4m", toolName: nil)
    }
}

#Preview("Lock screen", as: .content, using: RunActivityAttributes.preview) {
    RunActivityWidget()
} contentStates: {
    RunActivityAttributes.ContentState.previewThinking
    RunActivityAttributes.ContentState.previewTool
    RunActivityAttributes.ContentState.previewApproval
    RunActivityAttributes.ContentState.previewDone
}
