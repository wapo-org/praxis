import Foundation
import AgentCore

/// Serial event-to-presentation adapter. The server remains authoritative for
/// replay and compaction; AgentCore values are used only by the existing UI.
actor CloudEventMapper {
    private let request: ChatRunRequest
    private var transcript: [Message]
    private var committedIDs = Set<String>()
    private var messageIDs: [String] = []

    init(request: ChatRunRequest) {
        self.request = request
        self.transcript = request.history
    }

    func map(_ payload: CloudEventPayload) async -> [AgentEvent] {
        switch payload {
        case .started, .parked, .unknown, .elicitation, .elicitationResolved: return []
        case .iteration(let n): return [.iterationStarted(n)]
        case .text(let id, let text): return [.textDelta(blockID: id, text: text)]
        case .textFinished(let id): return [.textFinished(blockID: id)]
        case .reasoning(let id, let text): return [.reasoningDelta(blockID: id, text: text)]
        case .reasoningFinished(let id): return [.reasoningFinished(blockID: id)]
        case .toolStarted(let activity): return [.toolCallStarted(activity.native)]
        case .toolReady(let activity): return [.toolCallReady(activity.native)]
        case .toolArguments(let id, let json): return [.toolInputDelta(id: id, json: json)]
        case .toolRunning(let id): return [.toolRunning(id: id)]
        case .approval(let approval): return [.toolAwaitingApproval(approval.native)]
        case .approvalResolved(let id, let decision): return [.toolApprovalResolved(id: id, decision: Self.decision(decision))]
        case .progress(let id, let kind, let text, let lines, let trace):
            let progress: ToolProgress = switch kind {
            case "output": .output(lines ?? text.map { [$0] } ?? [])
            case "trace": .trace(trace ?? .note, text ?? lines?.joined(separator: "\n") ?? "")
            default: .status(text ?? "")
            }
            return [.toolProgress(id: id, progress)]
        case .toolFinished(let id, let completion): return [.toolFinished(id: id, completion.native)]
        case .discarded(let blocks, let tools): return [.attemptDiscarded(blockIDs: blocks, toolCallIDs: tools)]
        case .retry(let attempt, let ms, let reason): return [.retrying(attempt: attempt, delay: .milliseconds(ms), reason: reason)]
        case .usage(let usage): return [.usage(usage)]
        case .compaction(let id, let phase, let summary, let through, let before, let after, let reason):
            switch phase {
            case "started": return [.compaction(id: id, .started(CompactionReason(rawValue: reason ?? "") ?? .threshold))]
            case "failed": return [.compaction(id: id, .failed(reason ?? "Cloud compaction failed."))]
            default:
                let covered = through.flatMap { messageIDs.firstIndex(of: $0).map { request.history.count + $0 + 1 } } ?? 0
                // A server prefix id cannot be converted to an AgentCore prefix
                // fingerprint after relaunch. Keep it displayable and explicitly
                // inapplicable to the sunset native runtime (covered == 0).
                let record = ContextCompaction(summary: summary ?? "", coveredMessages: covered,
                    fingerprint: covered > 0 ? ContextCompaction.fingerprint(transcript.prefix(covered)) : "cloud:" + (through ?? id),
                    model: request.modelID, tokensBefore: before ?? 0, tokensAfter: after ?? 0)
                await request.onCompaction(record)
                return [.compaction(id: id, .finished(record))]
            }
        case .measured(let tokens, let count, let model):
            let record = ContextMeasurement(model: model, messageCount: count,
                fingerprint: ContextCompaction.fingerprint(transcript.prefix(count)),
                compactedMessages: request.compaction?.coveredMessages ?? 0, promptTokens: tokens)
            await request.onContextMeasured(record)
            return [.contextMeasured(record)]
        case .committed(let messages):
            let fresh = messages.filter { committedIDs.insert($0.id).inserted }
            let mapped = fresh.map(\.native)
            messageIDs.append(contentsOf: fresh.map(\.id))
            transcript.append(contentsOf: mapped)
            return mapped.isEmpty ? [] : [.committed(mapped)]
        case .policy(let key): return [.policyUpdated(alwaysAllowKey: key)]
        case .vision(let id, let phase, let model, let answer):
            if phase == "started" {
                return [.toolCallStarted(ToolActivity(id: id, name: "image_input", source: .builtin,
                    presentation: ToolPresentation(category: .other, runningTitle: "Reading image…", finishedTitle: "Read image")))]
            }
            return [.toolFinished(id: id, ToolCompletion(status: phase == "failed" ? .failed : .succeeded,
                summary: answer ?? model.map { "Image read by \($0)." } ?? "Image reading finished."))]
        case .finished(let outcome, let message):
            let native: RunOutcome = switch outcome {
            case "completed": .completed
            case "truncated": .truncated
            case "maxIterations": .maxIterations
            case "refused": .refused(message)
            case "cancelled": .cancelled
            default: .failed(message ?? "Cloud run failed.")
            }
            return [.finished(native)]
        }
    }

    static func decision(_ raw: String) -> ApprovalDecision {
        switch raw { case "allowOnce": .allowOnce; case "allowAlways": .allowAlways; default: .deny }
    }
    static func decisionString(_ value: ApprovalDecision) -> String {
        switch value { case .allowOnce: "allowOnce"; case .allowAlways: "allowAlways"; case .deny: "deny" }
    }
}
