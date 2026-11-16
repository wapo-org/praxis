import Foundation

/// Compiled into both app and LiveActivityWidget targets; shared by attributes and reporter.
enum RunPhase: String, Sendable, Codable, Hashable {
    case thinking
    case runningTool
    case needsApproval
    case done
    case failed
    case paused
}

/// Fire-and-forget ActivityKit reporter; all failures no-op so runs never depend on it.
@MainActor
protocol RunActivityReporter: Sendable {
    func began(conversationID: UUID, title: String, modelName: String) async
    func update(conversationID: UUID, phase: RunPhase, stepCount: Int, startedAt: Date, lastLine: String,
                toolName: String?) async
    func ended(conversationID: UUID, phase: RunPhase, lastLine: String) async
    func reconcile(activeConversationIDs: Set<UUID>) async
}

@MainActor
struct NoOpRunActivityReporter: RunActivityReporter {
    func began(conversationID: UUID, title: String, modelName: String) async {}
    func update(conversationID: UUID, phase: RunPhase, stepCount: Int, startedAt: Date, lastLine: String,
                toolName: String?) async {}
    func ended(conversationID: UUID, phase: RunPhase, lastLine: String) async {}
    func reconcile(activeConversationIDs: Set<UUID>) async {}
}
