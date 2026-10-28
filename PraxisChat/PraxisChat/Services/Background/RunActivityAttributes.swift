import ActivityKit
import Foundation

/// Attributes for one run's Live Activity (BACKGROUND_PLAN.md §3.1).
/// One shared file compiled into BOTH the app target (via the
/// synchronized folder) and the `LiveActivityWidget` target (via an
/// explicit file reference). Imports ActivityKit + Foundation ONLY,
/// and must stay tiny: the ~4 KB update limit covers attributes +
/// state.
///
/// `conversationID` is the deep-link key, never displayed.
/// `RunPhase` lives in `RunActivityReporter.swift` (same dual-target
/// treatment); it is referenced here, never redefined.
struct RunActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        /// User-visible phase of the run.
        var phase: RunPhase
        var stepCount: Int
        var startedAt: Date
        /// One line of step text — the same titles the in-app
        /// activity rows render. Never streamed answer text
        /// (lock-screen privacy, 4 KB cap, update budget).
        var lastLine: String
        /// Short tool name; set for runningTool/needsApproval only.
        var toolName: String?
    }

    var conversationID: UUID
    var chatTitle: String
    var modelName: String
}
