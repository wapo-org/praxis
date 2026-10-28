import Foundation

/// Reasoning-effort dial exposed in the UI. Adapters map it onto whatever
/// the endpoint understands (Anthropic `output_config.effort`, OpenAI
/// `reasoning_effort`) or drop it when the model has no such control.
public enum Effort: String, Sendable, Codable, Hashable, CaseIterable {
    case low, medium, high, max

    public var defaultMaxTokens: Int {
        switch self {
        case .low: return 8_192
        case .medium: return 16_384
        case .high: return 32_768
        case .max: return 64_000
        }
    }

    public var defaultMaxIterations: Int {
        switch self {
        case .low: return 8
        case .medium: return 20
        case .high: return 40
        case .max: return 80
        }
    }
}

/// What an endpoint supports. Features are gated on these, never on the
/// provider's name — "compatible" servers often implement a subset.
public struct Capabilities: Sendable, Codable, Hashable {
    public var tools: Bool
    public var parallelToolCalls: Bool
    public var vision: Bool
    public var documents: Bool
    public var imagesInToolResults: Bool
    public var reasoningEffort: Bool
    public var streamUsage: Bool
    /// Anthropic explicit `cache_control` breakpoints.
    public var explicitPromptCaching: Bool
    /// Provider-hosted web search/fetch (Anthropic server tools).
    public var serverWebSearch: Bool
    /// Native mid-conversation system messages.
    public var midConversationSystem: Bool

    public init(tools: Bool = true, parallelToolCalls: Bool = true, vision: Bool = true, documents: Bool = false,
                imagesInToolResults: Bool = false, reasoningEffort: Bool = false, streamUsage: Bool = true,
                explicitPromptCaching: Bool = false, serverWebSearch: Bool = false, midConversationSystem: Bool = false) {
        self.tools = tools
        self.parallelToolCalls = parallelToolCalls
        self.vision = vision
        self.documents = documents
        self.imagesInToolResults = imagesInToolResults
        self.reasoningEffort = reasoningEffort
        self.streamUsage = streamUsage
        self.explicitPromptCaching = explicitPromptCaching
        self.serverWebSearch = serverWebSearch
        self.midConversationSystem = midConversationSystem
    }

    /// Safe defaults for an unknown compatible server.
    public static let conservative = Capabilities(tools: true, parallelToolCalls: false, vision: false,
                                                  streamUsage: false)
}

public struct ModelInfo: Sendable, Codable, Hashable, Identifiable {
    public var id: String
    public var displayName: String
    public var contextWindow: Int?
    public var maxOutputTokens: Int?
    /// Whether the model accepts image input, when the model list says so
    /// (OpenRouter `architecture.input_modalities`, Anthropic
    /// `capabilities.image_input`, LM Studio / Ollama style `capabilities`).
    /// Nil = unknown: the endpoint's `Capabilities.vision` decides.
    public var supportsImages: Bool?
    /// Whether the model accepts tool use, when the model list says so
    /// (OpenRouter `supported_parameters`, Anthropic `capabilities.tool_use`,
    /// LM Studio / Ollama style `capabilities`).
    /// Nil = unknown: try with tools; the endpoint's `Capabilities.tools` decides.
    public var supportsTools: Bool?
    /// The provider's raw reasoning-effort level names for this model, when
    /// the model list says (OpenRouter `reasoning.supported_efforts`,
    /// Anthropic `capabilities.effort` flags, LM Studio
    /// `capabilities.reasoning.allowed_options`).
    /// - Nil = unknown: the list says nothing about reasoning.
    /// - Empty = the list positively rules reasoning out.
    /// - A list that says "reasoning supported" but names no levels gets
    ///   the API family's documented default (`EffortLevels`).
    public var reasoningEfforts: [String]?
    public init(id: String, displayName: String? = nil, contextWindow: Int? = nil, maxOutputTokens: Int? = nil,
                supportsImages: Bool? = nil, supportsTools: Bool? = nil, reasoningEfforts: [String]? = nil) {
        self.id = id
        self.displayName = displayName ?? id
        self.contextWindow = contextWindow
        self.maxOutputTokens = maxOutputTokens
        self.supportsImages = supportsImages
        self.supportsTools = supportsTools
        self.reasoningEfforts = reasoningEfforts
    }
}

public struct ToolSpec: Sendable, Codable, Hashable {
    public var name: String
    public var description: String
    /// JSON Schema (object) for the arguments.
    public var inputSchema: JSONValue
    public init(name: String, description: String, inputSchema: JSONValue) {
        self.name = name
        self.description = description
        self.inputSchema = inputSchema
    }
}

public struct ProviderRequest: Sendable {
    public var model: String
    public var system: String
    public var messages: [Message]
    public var tools: [ToolSpec]
    public var maxTokens: Int
    public var effort: Effort
    /// Ask the provider to run its hosted web search/fetch (only honoured
    /// when `Capabilities.serverWebSearch`).
    public var serverWebSearch: Bool
    /// The model's supported effort wire values, when known
    /// (`ModelInfo.reasoningEfforts` or learned from a rejection). Builders
    /// clamp the outgoing value to these (`EffortLevels.clamp`); nil sends
    /// the effort unchanged, empty drops the parameter.
    public var supportedEffortValues: [String]?

    public init(model: String, system: String, messages: [Message], tools: [ToolSpec], maxTokens: Int,
                effort: Effort, serverWebSearch: Bool = false, supportedEffortValues: [String]? = nil) {
        self.model = model
        self.system = system
        self.messages = messages
        self.tools = tools
        self.maxTokens = maxTokens
        self.effort = effort
        self.serverWebSearch = serverWebSearch
        self.supportedEffortValues = supportedEffortValues
    }
}

public struct Usage: Sendable, Codable, Hashable {
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheWriteTokens: Int
    public init(inputTokens: Int = 0, outputTokens: Int = 0, cacheReadTokens: Int = 0, cacheWriteTokens: Int = 0) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
    }
    /// Prompt size of the request that produced this usage.
    public var contextTokens: Int { inputTokens + cacheReadTokens + cacheWriteTokens }

    public static func + (a: Usage, b: Usage) -> Usage {
        Usage(inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
              cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens)
    }
}

/// Normalized stop reasons across flavors.
public enum StopReason: Sendable, Hashable {
    /// Model finished (`end_turn`, `stop`, `stop_sequence`).
    case endTurn
    /// Model wants tools run (`tool_use`, `tool_calls`).
    case toolUse
    /// Output budget hit (`max_tokens`, `length`).
    case maxTokens
    /// Provider paused a long server-tool turn; resend to continue (`pause_turn`).
    case pauseTurn
    /// Safety refusal (`refusal`, `content_filter`).
    case refusal(String?)
    /// Prompt + output exceeded the context window.
    case contextWindowExceeded
    case other(String)
}

public struct ProviderResponse: Sendable {
    public var message: Message
    public var stopReason: StopReason
    public var usage: Usage
    public init(message: Message, stopReason: StopReason, usage: Usage) {
        self.message = message
        self.stopReason = stopReason
        self.usage = usage
    }
}

/// Normalized streaming events. `index` identifies a content block within
/// one response; adapters guarantee indices are unique per response even
/// where the wire format numbers text and tool calls separately.
public enum ProviderEvent: Sendable {
    case textDelta(index: Int, text: String)
    case reasoningDelta(index: Int, text: String)
    case toolCallStarted(index: Int, id: String, name: String)
    case toolCallDelta(index: Int, json: String)
    /// Provider-hosted tool started (e.g. Anthropic `web_search`).
    case serverToolStarted(index: Int, id: String, name: String, input: JSONValue?)
    case serverToolFinished(index: Int, id: String, summary: String, isError: Bool)
    case blockFinished(index: Int)
    case usage(Usage)
    /// Always the last event of a successful stream.
    case completed(ProviderResponse)
}

public protocol ModelProvider: Sendable {
    var flavor: ProviderFlavor { get }
    var capabilities: Capabilities { get }
    func listModels() async throws -> [ModelInfo]
    /// Streams one model response. Throws `ProviderError`; cancellation of
    /// the consuming task cancels the HTTP request.
    func stream(_ request: ProviderRequest) -> AsyncThrowingStream<ProviderEvent, Error>
}

public enum ProviderError: Error, Sendable, Equatable, CustomStringConvertible {
    case http(status: Int, message: String, retryAfter: Duration?)
    /// Error delivered inside an otherwise successful stream.
    case stream(type: String, message: String)
    case network(String)
    case decoding(String)
    case invalidConfiguration(String)

    public var isRetryable: Bool {
        // Some servers answer unsupported images with a 5xx; resending won't help.
        if isImageInputUnsupported { return false }
        // Same for tool use: resend without tools instead.
        if isToolUseUnsupported { return false }
        // Same for effort: resend clamped or without the parameter instead.
        if isEffortRejection { return false }
        switch self {
        case .http(let status, _, _):
            return status == 408 || status == 409 || status == 429 || (500...599).contains(status)
        case .stream(let type, _):
            return ["overloaded_error", "api_error", "rate_limit_error", "server_error", "timeout"].contains(type)
        case .network:
            return true
        case .decoding, .invalidConfiguration:
            return false
        }
    }

    public var retryAfter: Duration? {
        if case .http(_, _, let r) = self { return r }
        return nil
    }

    public var description: String {
        switch self {
        case .http(let status, let message, _): return "HTTP \(status): \(message)"
        case .stream(let type, let message): return "\(type): \(message)"
        case .network(let m): return "Network error: \(m)"
        case .decoding(let m): return "Unexpected response: \(m)"
        case .invalidConfiguration(let m): return m
        }
    }

    /// The provider rejected tool use (`ToolSupport.isToolUseRejection`).
    /// Not worth retrying as is; resend without tools.
    public var isToolUseUnsupported: Bool {
        switch self {
        case .http(_, let message, _), .stream(_, let message): return ToolSupport.isToolUseRejection(message)
        case .network, .decoding, .invalidConfiguration: return false
        }
    }

    /// The provider rejected the effort control (`EffortLevels.rejection`).
    /// Not worth retrying as is; resend clamped or without the parameter.
    public var isEffortRejection: Bool {
        switch self {
        case .http(_, let message, _), .stream(_, let message): return EffortLevels.rejection(in: message) != nil
        case .network, .decoding, .invalidConfiguration: return false
        }
    }
}
