import ActivityKit
import SwiftUI
import WidgetKit

/// Monochrome Live Activity views; no buttons or custom animations, deep-links to chat.
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
// Widget links neither app nor package, so phase display strings live here.

extension RunPhase {
    /// System ignores animation modifiers in Live Activities, so keep glyphs static.
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
                // Show step count in terminal states since there is no end time for a frozen timer.
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
        // Lock card lacks leading inset; horizontal padding prevents glyph clipping.
        .padding(.horizontal)
        .opacity(context.isStale ? 0.6 : 1)
        .widgetURL(context.chatURL)
        .accessibilityLabel(context.voiceOverSummary)
    }
}

// MARK: - Dynamic Island

/// Hide compact glyph from VoiceOver since trailing text carries the label.
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
