import Foundation

/// The run an elicitation belongs to, carried ambiently from the tool
/// call that triggered it to the client that asks the user.
///
/// The loop sets it around each tool execution (from
/// `AgentRunConfiguration.elicitationScope`); `MCPClient` reads it when
/// a call doesn't name a scope explicitly. A parameter can't cross the
/// client boundary — tools call `callTool` without one — so the task
/// tree is the channel; each tool runs in its own task, so concurrent
/// runs never see each other's scope.
public enum ElicitationScope {
    @TaskLocal public static var current: UUID?
}
