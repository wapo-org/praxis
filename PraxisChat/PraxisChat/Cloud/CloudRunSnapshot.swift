import Foundation
import AgentCore

/// An authoritative projection used when the event retention window expired.
/// Lifecycle code fetches and journals the original snapshot before rebuilding;
/// this value deliberately never changes the stream cursor itself.
struct CloudRunSnapshot: Decodable, Sendable {
    struct Block: Decodable, Sendable {
        let type: String
        let id: String
        let text: String
        let finished: Bool
    }
    struct Tool: Decodable, Sendable {
        let activity: CloudToolActivity
        let argumentsJson: String
        let running: Bool
        let completion: CloudToolCompletion?
        let progress: [CloudEventPayload]
    }
    let run: CloudRun
    let lastEventId: Int
    let blocks: [Block]
    let tools: [Tool]
    let pendingApprovals: [CloudApproval]
    let pendingElicitations: [CloudElicitation]
    let usage: Usage?
    let messages: [CloudMessage]

    var isTerminal: Bool { ["completed", "cancelled", "failed"].contains(run.status) }
    var pendingEvents: [CloudEventPayload] {
        guard !isTerminal else { return [] }
        return pendingApprovals.map(CloudEventPayload.approval) + pendingElicitations.map(CloudEventPayload.elicitation)
    }

    /// Rebuild a *fresh* reducer, rather than append this full projection to an
    /// existing one. v1 snapshots preserve array order but do not expose total
    /// ordering between tools and text blocks; use the journal for exact replay.
    /// Unknown block/progress types remain forward compatible. Bounds prevent
    /// an invalid snapshot from producing an unbounded presentation workload.
    func presentationEvents() throws -> [CloudEventPayload] {
        guard lastEventId >= 0, lastEventId <= 9_007_199_254_740_991,
              blocks.count <= 10_000, tools.count <= 1_000, messages.count <= 10_000,
              pendingApprovals.count <= 1_000, pendingElicitations.count <= 1_000,
              blocks.reduce(0, { $0 + $1.text.utf8.count }) <= 8 * 1024 * 1024 else {
            throw CloudAPIError.malformedEvent("snapshot exceeds recovery bounds")
        }
        var result: [CloudEventPayload] = messages.isEmpty ? [] : [.committed(messages)]
        for tool in tools {
            result.append(.toolStarted(tool.activity))
            if !tool.argumentsJson.isEmpty { result.append(.toolArguments(tool.activity.id, tool.argumentsJson)) }
            result.append(.toolReady(tool.activity))
            if tool.running { result.append(.toolRunning(tool.activity.id)) }
            result.append(contentsOf: tool.progress.suffix(200))
            if let completion = tool.completion { result.append(.toolFinished(tool.activity.id, completion)) }
        }
        for block in blocks {
            switch block.type {
            case "text":
                result.append(.text(block.id, block.text))
                if block.finished { result.append(.textFinished(block.id)) }
            case "reasoning":
                result.append(.reasoning(block.id, block.text))
                if block.finished { result.append(.reasoningFinished(block.id)) }
            default: break
            }
        }
        if let usage { result.append(.usage(usage)) }
        result.append(contentsOf: pendingEvents)
        if isTerminal { result.append(.finished(run.outcome ?? run.status, run.error)) }
        return result
    }
}
