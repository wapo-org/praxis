import ActivityKit
import Foundation

/// Compiled into both app and LiveActivityWidget; keep imports minimal and payload < 4 KB.
struct RunActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var phase: RunPhase
        var stepCount: Int
        var startedAt: Date
        /// Step title only; never streamed answer text (lock-screen privacy, 4 KB cap, update budget).
        var lastLine: String
        /// Short tool name; set for runningTool/needsApproval only.
        var toolName: String?
    }

    var conversationID: UUID
    var chatTitle: String
    var modelName: String
}
