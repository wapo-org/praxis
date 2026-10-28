import Foundation

/// Wire protocol family of a model endpoint. Any server that speaks one of
/// these is supported — official APIs are presets, not special cases.
public enum ProviderFlavor: String, Sendable, Codable, Hashable, CaseIterable {
    /// `POST /v1/messages` (Anthropic and compatible servers).
    case anthropicMessages
    /// `POST /v1/chat/completions` (OpenAI and compatible servers).
    case openAIChat
}

/// Provider-native bytes for an assistant message. Replayed verbatim when
/// the next request goes to the same flavor, so signatures, encrypted
/// reasoning and server-tool blocks survive untouched.
public struct ProviderPayload: Sendable, Codable, Hashable {
    public var flavor: ProviderFlavor
    public var data: Data
    public init(flavor: ProviderFlavor, data: Data) {
        self.flavor = flavor
        self.data = data
    }
}

/// One message in the provider-neutral transcript. The transcript is
/// append-only: a run only ever adds messages, retry/edit only cut the tail.
public struct Message: Sendable, Codable, Hashable {
    public enum Role: String, Sendable, Codable, Hashable { case user, assistant }

    public var role: Role
    public var parts: [Part]
    /// Set on assistant messages produced by a provider.
    public var raw: ProviderPayload?

    public init(role: Role, parts: [Part], raw: ProviderPayload? = nil) {
        self.role = role
        self.parts = parts
        self.raw = raw
    }

    public static func user(_ text: String) -> Message { Message(role: .user, parts: [.text(text)]) }

    public var toolCalls: [ToolCall] {
        parts.compactMap { if case .toolCall(let c) = $0 { return c }; return nil }
    }

    public var toolResults: [ToolResult] {
        parts.compactMap { if case .toolResult(let r) = $0 { return r }; return nil }
    }

    /// Concatenated visible text.
    public var text: String {
        parts.compactMap { if case .text(let t) = $0 { return t }; return nil }.joined()
    }
}

public enum Part: Sendable, Codable, Hashable {
    case text(String)
    case image(MediaData)
    case document(MediaData)
    case reasoning(Reasoning)
    case toolCall(ToolCall)
    case toolResult(ToolResult)
    /// Operator note appended mid-conversation (mode / effort changes,
    /// newly added skills). Adapters render it as a system message where
    /// the wire format allows, otherwise as a tagged text block.
    case note(String)
}

public struct MediaData: Sendable, Codable, Hashable {
    public var mediaType: String
    public var data: Data
    public var name: String?
    public init(mediaType: String, data: Data, name: String? = nil) {
        self.mediaType = mediaType
        self.data = data
        self.name = name
    }
}

public struct Reasoning: Sendable, Codable, Hashable {
    /// Human-readable reasoning / summary (may be empty).
    public var text: String
    /// Provider signature (Anthropic `thinking.signature`).
    public var signature: String?
    public init(text: String, signature: String? = nil) {
        self.text = text
        self.signature = signature
    }
}

public struct ToolCall: Sendable, Codable, Hashable {
    public var id: String
    public var name: String
    /// Raw JSON argument text exactly as the model produced it.
    public var arguments: String
    public init(id: String, name: String, arguments: String) {
        self.id = id
        self.name = name
        self.arguments = arguments
    }
}

public struct ToolResult: Sendable, Codable, Hashable {
    public var callID: String
    public var toolName: String
    public var content: [ToolResultContent]
    public var isError: Bool
    public init(callID: String, toolName: String, content: [ToolResultContent], isError: Bool = false) {
        self.callID = callID
        self.toolName = toolName
        self.content = content
        self.isError = isError
    }
}

public enum ToolResultContent: Sendable, Codable, Hashable {
    case text(String)
    case image(MediaData)

    public var text: String? { if case .text(let t) = self { return t }; return nil }
}

public enum TranscriptRepair {
    /// Closes tool calls that never got results (run stopped mid-tool, app
    /// killed) so the next request is valid on every provider. Returns the
    /// messages to append; empty when the transcript is already consistent.
    public static func closingDanglingToolCalls(in messages: [Message],
                                                reason: String = "Cancelled by user before the tool finished.") -> [Message] {
        guard let last = messages.last, last.role == .assistant else { return [] }
        let calls = last.toolCalls
        guard !calls.isEmpty else { return [] }
        let results = calls.map {
            Part.toolResult(ToolResult(callID: $0.id, toolName: $0.name, content: [.text(reason)], isError: true))
        }
        return [Message(role: .user, parts: results)]
    }
}
