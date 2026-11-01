import Foundation
import AgentCore

struct CloudRunEvent: Decodable, Sendable {
    let id: Int
    let runId: String
    let chatId: String
    let createdAt: String
    let event: CloudEventPayload
}

struct CloudToolSource: Decodable, Sendable {
    let type: String
    let serverId: String?
    let serverName: String?
    var native: ToolSource {
        switch type {
        case "skill": .skill
        case "javascript": .javascript
        case "mcp": .mcp(serverID: serverId ?? "", serverName: serverName ?? serverId ?? "Connector")
        case "server": .server
        default: .builtin
        }
    }
}
struct CloudToolActivity: Decodable, Sendable {
    let id: String
    let name: String
    let source: CloudToolSource
    let presentation: ToolPresentation
    let arguments: JSONValue?
    let parentCallId: String?
    var native: ToolActivity { ToolActivity(id: id, name: name, source: source.native, presentation: presentation, arguments: arguments) }
}
struct CloudApproval: Decodable, Sendable {
    let id: String
    let callId: String
    let toolName: String
    let source: CloudToolSource
    let arguments: JSONValue
    let reason: String
    let title: String
    let parentCallId: String?
    // AgentCore indexes the card by call id; the POST uses durable approval id.
    var native: ApprovalRequest {
        ApprovalRequest(id: callId, toolName: toolName, source: source.native, arguments: arguments,
                        reason: reason, title: title, parentCallID: parentCallId)
    }
}
struct CloudElicitation: Decodable, Sendable {
    let id: String
    let message: String
    let schema: JSONValue
    let connectorId: String?
    let connectorName: String?
    let mode: String?
    let url: URL?
}
struct CloudToolCompletion: Decodable, Sendable {
    let status: ToolStatus
    let summary: String
    let preview: String
    let content: [JSONValue]?
    let outputRef: String?
    var native: ToolCompletion { ToolCompletion(status: status, summary: summary, preview: preview) }
}
struct CloudMessage: Decodable, Sendable {
    struct Raw: Decodable, Sendable { let flavor: String; let data: JSONValue }
    struct Content: Decodable, Sendable {
        let type: String
        let text: String?
        let attachmentId: String?
        let mediaType: String?
        let data: String?
        let signature: String?
        let callId: String?
        let name: String?
        let arguments: String?
        let content: [JSONValue]?
        let isError: Bool?
    }
    let id: String
    let role: Message.Role
    let parts: [Content]
    let raw: Raw?
    let clientTurnId: String?
    var native: Message {
        let mapped: [Part] = parts.compactMap { part in
            switch part.type {
            case "text": return .text(part.text ?? "")
            case "note": return .note(part.text ?? "")
            case "reasoning": return .reasoning(Reasoning(text: part.text ?? "", signature: part.signature))
            case "toolCall": return .toolCall(ToolCall(id: part.callId ?? "", name: part.name ?? "", arguments: part.arguments ?? "{}"))
            case "toolResult": return .toolResult(ToolResult(callID: part.callId ?? "", toolName: part.name ?? "", content: (part.content ?? []).compactMap { item in
                if let text = item["text"]?.stringValue { return .text(text) }
                if item["type"]?.stringValue == "image", let data = item["data"]?.stringValue.flatMap({ Data(base64Encoded: $0) }) {
                    return .image(MediaData(mediaType: item["mediaType"]?.stringValue ?? "image/jpeg", data: data))
                }
                return nil
            }, isError: part.isError ?? false))
            case "image", "document":
                // Server attachment ids are not local file paths. Keep a small
                // reference; cloud replay uses the authoritative server history.
                let bytes = part.data.flatMap { Data(base64Encoded: $0) } ?? Data(("praxis-cloud-attachment:" + (part.attachmentId ?? "")).utf8)
                let media = MediaData(mediaType: part.mediaType ?? "application/octet-stream", data: bytes, name: part.name)
                return part.type == "image" ? .image(media) : .document(media)
            default: return nil
            }
        }
        let payload = raw.flatMap { raw in ProviderFlavor(rawValue: raw.flavor).map { ProviderPayload(flavor: $0, data: Data(raw.data.encodedString().utf8)) } }
        return Message(role: role, parts: mapped, raw: payload)
    }
}

enum CloudEventPayload: Decodable, Sendable {
    case started, parked
    case iteration(Int)
    case text(String, String), textFinished(String), reasoning(String, String), reasoningFinished(String)
    case toolStarted(CloudToolActivity), toolReady(CloudToolActivity), toolArguments(String, String), toolRunning(String)
    case approval(CloudApproval), approvalResolved(String, String)
    case progress(String, String, String?, [String]?, TraceKind?)
    case toolFinished(String, CloudToolCompletion)
    case elicitation(CloudElicitation), elicitationResolved(String)
    case discarded([String], [String]), retry(Int, Double, String), usage(Usage)
    case compaction(id: String, phase: String, summary: String?, through: String?, before: Int?, after: Int?, reason: String?)
    case measured(Int, Int, String), committed([CloudMessage]), policy(String)
    case vision(id: String, phase: String, model: String?, answer: String?)
    case finished(String, String?), unknown(String)

    private enum Key: String, CodingKey {
        case type, iteration, blockId, text, activity, callId, json, approval, decision, kind, lines, traceKind
        case completion, elicitation, elicitationId, blockIds, toolCallIds, attempt, delayMs, reason, usage
        case id, phase, summary, throughMessageId, inputTokens, outputTokens, messageCount, modelId, messages, alwaysAllowKey, answer, outcome, message
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let type = try c.decode(String.self, forKey: .type)
        func s(_ key: Key) throws -> String { try c.decode(String.self, forKey: key) }
        switch type {
        case "run.started": self = .started
        case "run.parked": self = .parked
        case "iteration.started": self = .iteration(try c.decode(Int.self, forKey: .iteration))
        case "text.delta": self = .text(try s(.blockId), try s(.text))
        case "text.finished": self = .textFinished(try s(.blockId))
        case "reasoning.delta": self = .reasoning(try s(.blockId), try s(.text))
        case "reasoning.finished": self = .reasoningFinished(try s(.blockId))
        case "tool.started": self = .toolStarted(try c.decode(CloudToolActivity.self, forKey: .activity))
        case "tool.ready": self = .toolReady(try c.decode(CloudToolActivity.self, forKey: .activity))
        case "tool.arguments.delta": self = .toolArguments(try s(.callId), try s(.json))
        case "tool.running": self = .toolRunning(try s(.callId))
        case "approval.requested": self = .approval(try c.decode(CloudApproval.self, forKey: .approval))
        case "approval.resolved": self = .approvalResolved(try s(.callId), try s(.decision))
        case "tool.progress": self = .progress(try s(.callId), try s(.kind), try c.decodeIfPresent(String.self, forKey: .text), try c.decodeIfPresent([String].self, forKey: .lines), try c.decodeIfPresent(TraceKind.self, forKey: .traceKind))
        case "tool.finished": self = .toolFinished(try s(.callId), try c.decode(CloudToolCompletion.self, forKey: .completion))
        case "elicitation.requested": self = .elicitation(try c.decode(CloudElicitation.self, forKey: .elicitation))
        case "elicitation.resolved": self = .elicitationResolved(try s(.elicitationId))
        case "attempt.discarded": self = .discarded(try c.decode([String].self, forKey: .blockIds), try c.decode([String].self, forKey: .toolCallIds))
        case "retrying": self = .retry(try c.decode(Int.self, forKey: .attempt), try c.decode(Double.self, forKey: .delayMs), try s(.reason))
        case "usage": self = .usage(try c.decode(Usage.self, forKey: .usage))
        case "compaction": self = .compaction(id: try s(.id), phase: try s(.phase), summary: try c.decodeIfPresent(String.self, forKey: .summary), through: try c.decodeIfPresent(String.self, forKey: .throughMessageId), before: try c.decodeIfPresent(Int.self, forKey: .inputTokens), after: try c.decodeIfPresent(Int.self, forKey: .outputTokens), reason: try c.decodeIfPresent(String.self, forKey: .reason))
        case "context.measured": self = .measured(try c.decode(Int.self, forKey: .inputTokens), try c.decode(Int.self, forKey: .messageCount), try s(.modelId))
        case "messages.committed": self = .committed(try c.decode([CloudMessage].self, forKey: .messages))
        case "policy.updated": self = .policy(try s(.alwaysAllowKey))
        case "vision.activity": self = .vision(id: try s(.id), phase: try s(.phase), model: try c.decodeIfPresent(String.self, forKey: .modelId), answer: try c.decodeIfPresent(String.self, forKey: .answer))
        case "run.finished": self = .finished(try s(.outcome), try c.decodeIfPresent(String.self, forKey: .message))
        default: self = .unknown(type)
        }
    }
}
