import Foundation

public struct ToolActivity: Sendable, Hashable {
    /// Tool call id (unique within the conversation).
    public var id: String
    public var name: String
    public var source: ToolSource
    public var presentation: ToolPresentation
    /// Parsed arguments once the call has fully streamed.
    public var arguments: JSONValue?

    public init(id: String, name: String, source: ToolSource, presentation: ToolPresentation, arguments: JSONValue? = nil) {
        self.id = id
        self.name = name
        self.source = source
        self.presentation = presentation
        self.arguments = arguments
    }
}

public enum ToolStatus: String, Sendable, Codable, Hashable {
    case succeeded, failed, denied, cancelled
}

public struct ToolCompletion: Sendable, Hashable {
    public var status: ToolStatus
    public var summary: String
    /// First few KB of the result text, for the UI.
    public var preview: String
    public init(status: ToolStatus, summary: String, preview: String = "") {
        self.status = status
        self.summary = summary
        self.preview = preview
    }
}

public enum RunOutcome: Sendable, Hashable {
    case completed
    /// Output budget ran out; the partial answer was kept.
    case truncated
    case maxIterations
    case refused(String?)
    case cancelled
    case failed(String)
}

/// What the loop reports to the app. Block ids are unique per run attempt;
/// a retried attempt first reports `attemptDiscarded` so the UI can drop
/// its partial output.
public enum AgentEvent: Sendable {
    case iterationStarted(Int)

    case textDelta(blockID: String, text: String)
    case textFinished(blockID: String)
    case reasoningDelta(blockID: String, text: String)
    case reasoningFinished(blockID: String)

    /// The model began emitting a tool call (arguments still streaming).
    case toolCallStarted(ToolActivity)
    case toolInputDelta(id: String, json: String)
    /// Arguments complete and parsed; presentation refined from them.
    case toolCallReady(ToolActivity)
    case toolAwaitingApproval(ApprovalRequest)
    case toolApprovalResolved(id: String, decision: ApprovalDecision)
    /// Execution started (after policy/approval).
    case toolRunning(id: String)
    case toolProgress(id: String, ToolProgress)
    case toolFinished(id: String, ToolCompletion)

    case attemptDiscarded(blockIDs: [String], toolCallIDs: [String])
    case retrying(attempt: Int, delay: Duration, reason: String)
    /// Cumulative usage for the run so far.
    case usage(Usage)
    /// Older history is being (or was) condensed into a summary. `id` is
    /// unique within the run. Persist the `finished` record and pass it to
    /// later runs; the transcript itself is unchanged.
    case compaction(id: String, CompactionUpdate)
    /// The provider reported a request's prompt size. Persist the latest
    /// with the conversation and pass it to later runs
    /// (`AgentRunConfiguration.measurement`), so their first request is
    /// budgeted from it rather than from an estimate.
    case contextMeasured(ContextMeasurement)
    /// Messages appended to the transcript. Persist these; the next run's
    /// transcript is the previous one plus everything committed.
    case committed([Message])
    /// "Always allow" granted for a tool — persist into `ToolPolicy`.
    case policyUpdated(alwaysAllowKey: String)
    case finished(RunOutcome)
}
