import Foundation

/// User-visible phase of one agent run, shared by the app-side
/// reporter protocol and the widget-side activity attributes
/// (both targets compile this file; see BACKGROUND_PLAN.md §6).
enum RunPhase: String, Sendable, Codable, Hashable {
    case thinking
    case runningTool
    case needsApproval
    case done
    case failed
    case paused
}

/// Fire-and-forget reporting from the background runtime to the
/// ActivityKit updater. All calls no-op when activities are
/// disabled or an activity can't start — a run NEVER depends on
/// its activity. Contract between bg-runtime (caller) and bg-live
/// (implementation); do not reshape unilaterally.
@MainActor
protocol RunActivityReporter: Sendable {
    func began(conversationID: UUID, title: String, modelName: String) async
    func update(conversationID: UUID, phase: RunPhase, stepCount: Int, startedAt: Date, lastLine: String,
                toolName: String?) async
    func ended(conversationID: UUID, phase: RunPhase, lastLine: String) async
    func reconcile(activeConversationIDs: Set<UUID>) async
}

/// Compiles the app before the ActivityKit implementation lands;
/// bg-runtime develops against this, bg-live replaces its use.
@MainActor
struct NoOpRunActivityReporter: RunActivityReporter {
    func began(conversationID: UUID, title: String, modelName: String) async {}
    func update(conversationID: UUID, phase: RunPhase, stepCount: Int, startedAt: Date, lastLine: String,
                toolName: String?) async {}
    func ended(conversationID: UUID, phase: RunPhase, lastLine: String) async {}
    func reconcile(activeConversationIDs: Set<UUID>) async {}
}
