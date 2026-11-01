import Foundation
import AgentCore

/// Where and how to reach one model endpoint: any server that speaks the
/// Anthropic Messages or OpenAI Chat Completions wire format.
///
/// The API key is deliberately **not** part of the Codable representation:
/// persist the endpoint as JSON in settings, keep the key in the Keychain,
/// and set `apiKey` right before `ProviderFactory.make`. A decoded endpoint
/// always has an empty key. `description` redacts it so logs never show it.
public struct ProviderEndpoint: Sendable, Hashable {
    public var flavor: ProviderFlavor
    /// Base URL **including** the version path, e.g.
    /// `https://api.anthropic.com/v1`, `https://openrouter.ai/api/v1`,
    /// `http://192.168.1.5:1234/v1`. A bare host gets `/v1` appended and a
    /// pasted full endpoint (`…/chat/completions`, `…/messages`) is trimmed
    /// back to its base, because that's what users paste from server docs.
    public var baseURL: URL
    /// Secret; empty for keyless local servers (no auth header is sent).
    public var apiKey: String
    /// Sent on every request; overrides adapter defaults with the same name.
    public var extraHeaders: [String: String]
    public var capabilities: Capabilities
    public var anthropic: AnthropicOptions
    public var openAI: OpenAIOptions

    public init(flavor: ProviderFlavor, baseURL: URL, apiKey: String = "", extraHeaders: [String: String] = [:],
                capabilities: Capabilities = .conservative, anthropic: AnthropicOptions = AnthropicOptions(),
                openAI: OpenAIOptions = OpenAIOptions()) {
        self.flavor = flavor
        self.baseURL = baseURL
        self.apiKey = apiKey
        self.extraHeaders = extraHeaders
        self.capabilities = capabilities
        self.anthropic = anthropic
        self.openAI = openAI
    }

    /// Absolute URL for an endpoint path (`"messages"`, `"models"`, …).
    func url(_ path: String, query: [URLQueryItem] = []) throws -> URL {
        guard var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              let scheme = c.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = c.host, !host.isEmpty else {
            throw ProviderError.invalidConfiguration("The base URL must be an http(s) URL with a host, e.g. https://api.openai.com/v1.")
        }
        var base = c.path
        while base.hasSuffix("/") { base.removeLast() }
        for suffix in ["/chat/completions", "/messages", "/models"] where base.hasSuffix(suffix) {
            base.removeLast(suffix.count)
            break
        }
        if base.isEmpty { base = "/v1" }
        c.path = base + "/" + path
        if !query.isEmpty { c.queryItems = (c.queryItems ?? []) + query }
        guard let url = c.url else { throw ProviderError.invalidConfiguration("Invalid base URL.") }
        return url
    }
}

extension ProviderEndpoint: Codable {
    private enum CodingKeys: String, CodingKey {
        case flavor, baseURL, extraHeaders, capabilities, anthropic, openAI
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        flavor = try c.decode(ProviderFlavor.self, forKey: .flavor)
        baseURL = try c.decode(URL.self, forKey: .baseURL)
        apiKey = ""
        extraHeaders = try c.decodeIfPresent([String: String].self, forKey: .extraHeaders) ?? [:]
        capabilities = try c.decodeIfPresent(Capabilities.self, forKey: .capabilities) ?? .conservative
        anthropic = try c.decodeIfPresent(AnthropicOptions.self, forKey: .anthropic) ?? AnthropicOptions()
        openAI = try c.decodeIfPresent(OpenAIOptions.self, forKey: .openAI) ?? OpenAIOptions()
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(flavor, forKey: .flavor)
        try c.encode(baseURL, forKey: .baseURL)
        try c.encode(extraHeaders, forKey: .extraHeaders)
        try c.encode(capabilities, forKey: .capabilities)
        try c.encode(anthropic, forKey: .anthropic)
        try c.encode(openAI, forKey: .openAI)
    }
}

extension ProviderEndpoint: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String {
        "ProviderEndpoint(\(flavor.rawValue), \(baseURL.absoluteString), key: \(apiKey.isEmpty ? "none" : "<redacted>"))"
    }
    public var debugDescription: String { description }
}

extension ProviderEndpoint: CustomReflectable {
    /// Keeps the key out of `dump`, debugger summaries and default
    /// descriptions of types that contain an endpoint.
    public var customMirror: Mirror {
        Mirror(self, children: [
            "flavor": flavor, "baseURL": baseURL, "apiKey": apiKey.isEmpty ? "none" : "<redacted>",
            "extraHeaders": extraHeaders.keys.sorted(), "capabilities": capabilities,
            "anthropic": anthropic, "openAI": openAI,
        ], displayStyle: .struct)
    }
}

/// Anthropic Messages specifics.
public struct AnthropicOptions: Sendable, Hashable, Codable {
    public enum Auth: String, Sendable, Hashable, Codable {
        /// `x-api-key: <key>` (official API and most compatible servers).
        case apiKeyHeader
        /// `Authorization: Bearer <key>` (OpenRouter, some gateways).
        case bearer
    }

    public var auth: Auth
    /// `anthropic-version` header.
    public var version: String
    /// Joined into one `anthropic-beta` header when non-empty.
    public var betas: [String]
    /// Server tool versions appended when a request asks for web search.
    /// Older models need `web_search_20250305` / `web_fetch_20250910`;
    /// `webFetchToolType = nil` sends search only.
    public var webSearchToolType: String
    public var webFetchToolType: String?
    /// `thinking.display` sent with adaptive thinking. Current models omit
    /// thinking text by default, which would make the UI look stalled.
    public var thinkingDisplay: String?
    /// `eager_input_streaming` on client tools: arguments stream as they're
    /// generated instead of arriving in one burst. The loop already rejects
    /// invalid argument JSON, so the lost server-side validation is covered.
    public var eagerInputStreaming: Bool

    public init(auth: Auth = .apiKeyHeader, version: String = "2023-06-01", betas: [String] = [],
                webSearchToolType: String = "web_search_20260209", webFetchToolType: String? = "web_fetch_20260209",
                thinkingDisplay: String? = "summarized", eagerInputStreaming: Bool = false) {
        self.auth = auth
        self.version = version
        self.betas = betas
        self.webSearchToolType = webSearchToolType
        self.webFetchToolType = webFetchToolType
        self.thinkingDisplay = thinkingDisplay
        self.eagerInputStreaming = eagerInputStreaming
    }

    // Tolerant decoding: settings written by an older build lack newer keys.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AnthropicOptions()
        auth = try c.decodeIfPresent(Auth.self, forKey: .auth) ?? d.auth
        version = try c.decodeIfPresent(String.self, forKey: .version) ?? d.version
        betas = try c.decodeIfPresent([String].self, forKey: .betas) ?? d.betas
        webSearchToolType = try c.decodeIfPresent(String.self, forKey: .webSearchToolType) ?? d.webSearchToolType
        // An explicit null means "off"; a missing key means "default".
        webFetchToolType = try c.contains(.webFetchToolType)
            ? c.decodeIfPresent(String.self, forKey: .webFetchToolType) : d.webFetchToolType
        thinkingDisplay = try c.contains(.thinkingDisplay)
            ? c.decodeIfPresent(String.self, forKey: .thinkingDisplay) : d.thinkingDisplay
        eagerInputStreaming = try c.decodeIfPresent(Bool.self, forKey: .eagerInputStreaming) ?? d.eagerInputStreaming
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(auth, forKey: .auth)
        try c.encode(version, forKey: .version)
        try c.encode(betas, forKey: .betas)
        try c.encode(webSearchToolType, forKey: .webSearchToolType)
        // Encode nil as null so "off" survives a round trip.
        try c.encode(webFetchToolType, forKey: .webFetchToolType)
        try c.encode(thinkingDisplay, forKey: .thinkingDisplay)
        try c.encode(eagerInputStreaming, forKey: .eagerInputStreaming)
    }

    private enum CodingKeys: String, CodingKey {
        case auth, version, betas, webSearchToolType, webFetchToolType, thinkingDisplay, eagerInputStreaming
    }
}

/// OpenAI Chat Completions specifics.
public struct OpenAIOptions: Sendable, Hashable, Codable {
    public enum MaxTokensField: String, Sendable, Hashable, Codable {
        /// `max_tokens` — what most compatible servers understand.
        case maxTokens = "max_tokens"
        /// `max_completion_tokens` — required by OpenAI reasoning models.
        case maxCompletionTokens = "max_completion_tokens"
        /// Send no limit (servers that reject both).
        case omit
    }

    public var maxTokensField: MaxTokensField
    /// Role for the system prompt and mid-conversation notes
    /// (`system`, or `developer` for servers that want it).
    public var systemRole: String
    /// Replay `reasoning_content` / `reasoning` on same-flavor assistant
    /// messages. Some vendors need it during tool loops, others reject it.
    public var replayReasoning: Bool
    /// Wire value for `Effort.max` (`high` is the common ceiling; OpenRouter
    /// and newer OpenAI models also take `xhigh`).
    public var maxEffortValue: String

    public init(maxTokensField: MaxTokensField = .maxTokens, systemRole: String = "system",
                replayReasoning: Bool = true, maxEffortValue: String = "high") {
        self.maxTokensField = maxTokensField
        self.systemRole = systemRole
        self.replayReasoning = replayReasoning
        self.maxEffortValue = maxEffortValue
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = OpenAIOptions()
        maxTokensField = try c.decodeIfPresent(MaxTokensField.self, forKey: .maxTokensField) ?? d.maxTokensField
        systemRole = try c.decodeIfPresent(String.self, forKey: .systemRole) ?? d.systemRole
        replayReasoning = try c.decodeIfPresent(Bool.self, forKey: .replayReasoning) ?? d.replayReasoning
        maxEffortValue = try c.decodeIfPresent(String.self, forKey: .maxEffortValue) ?? d.maxEffortValue
    }
}

/// Starting points for the Settings UI. Presets only fill in defaults —
/// every field stays editable and nothing downstream checks which preset
/// an endpoint came from.
public enum ProviderPreset: String, Sendable, Codable, Hashable, CaseIterable, Identifiable {
    case anthropic
    case openAI
    case openRouterOpenAI
    case openRouterAnthropic
    case customAnthropic
    case customOpenAI

    public var id: String { rawValue }

    public var displayName: String {
        switch self {
        case .anthropic: return "Anthropic"
        case .openAI: return "OpenAI"
        case .openRouterOpenAI: return "OpenRouter"
        case .openRouterAnthropic: return "OpenRouter (Anthropic format)"
        case .customAnthropic: return "Custom (Anthropic-compatible)"
        case .customOpenAI: return "Custom (OpenAI-compatible)"
        }
    }

    public var flavor: ProviderFlavor {
        switch self {
        case .anthropic, .openRouterAnthropic, .customAnthropic: return .anthropicMessages
        case .openAI, .openRouterOpenAI, .customOpenAI: return .openAIChat
        }
    }

    /// Nil for custom presets: the user must enter one.
    public var defaultBaseURL: URL? {
        switch self {
        case .anthropic: return URL(string: "https://api.anthropic.com/v1")
        case .openAI: return URL(string: "https://api.openai.com/v1")
        case .openRouterOpenAI, .openRouterAnthropic: return URL(string: "https://openrouter.ai/api/v1")
        case .customAnthropic, .customOpenAI: return nil
        }
    }

    /// Placeholder text for the base URL field.
    public var baseURLPlaceholder: String {
        defaultBaseURL?.absoluteString ?? (flavor == .openAIChat ? "http://192.168.1.5:1234/v1" : "https://example.com/v1")
    }

    /// Local servers usually run without a key.
    public var requiresAPIKey: Bool { self != .customOpenAI && self != .customAnthropic }

    public var defaultCapabilities: Capabilities {
        switch self {
        case .anthropic:
            return Capabilities(tools: true, parallelToolCalls: true, vision: true, documents: true,
                                imagesInToolResults: true, reasoningEffort: true, streamUsage: true,
                                explicitPromptCaching: true, serverWebSearch: true, midConversationSystem: false)
        case .openAI:
            return Capabilities(tools: true, parallelToolCalls: true, vision: true, documents: false,
                                imagesInToolResults: false, reasoningEffort: true, streamUsage: true,
                                explicitPromptCaching: false, serverWebSearch: false, midConversationSystem: true)
        case .openRouterOpenAI:
            return Capabilities(tools: true, parallelToolCalls: true, vision: true, documents: false,
                                imagesInToolResults: false, reasoningEffort: true, streamUsage: true,
                                explicitPromptCaching: false, serverWebSearch: false, midConversationSystem: true)
        case .openRouterAnthropic:
            return Capabilities(tools: true, parallelToolCalls: true, vision: true, documents: false,
                                imagesInToolResults: true, reasoningEffort: false, streamUsage: true,
                                explicitPromptCaching: true, serverWebSearch: false, midConversationSystem: false)
        case .customAnthropic:
            // Anthropic-format streams always carry usage.
            var c = Capabilities.conservative
            c.streamUsage = true
            return c
        case .customOpenAI:
            return .conservative
        }
    }

    public var defaultAnthropicOptions: AnthropicOptions {
        switch self {
        case .anthropic: return AnthropicOptions(eagerInputStreaming: true)
        case .openRouterAnthropic: return AnthropicOptions(auth: .bearer)
        default: return AnthropicOptions()
        }
    }

    public var defaultOpenAIOptions: OpenAIOptions {
        switch self {
        case .openAI: return OpenAIOptions(maxTokensField: .maxCompletionTokens)
        default: return OpenAIOptions()
        }
    }

    /// A ready endpoint. Returns nil when the preset has no default base URL
    /// and none was given.
    public func endpoint(apiKey: String = "", baseURL: URL? = nil) -> ProviderEndpoint? {
        guard let url = baseURL ?? defaultBaseURL else { return nil }
        return ProviderEndpoint(flavor: flavor, baseURL: url, apiKey: apiKey, capabilities: defaultCapabilities,
                                anthropic: defaultAnthropicOptions, openAI: defaultOpenAIOptions)
    }
}

public enum ProviderFactory {
    /// The adapter for the endpoint's flavor. Configuration problems (bad
    /// URL scheme) surface as `ProviderError.invalidConfiguration` on the
    /// first call rather than here, so this never fails.
    public static func make(_ endpoint: ProviderEndpoint,
                            transport: (any HTTPTransport)? = nil) -> any ModelProvider {
        switch endpoint.flavor {
        case .anthropicMessages: return AnthropicProvider(endpoint: endpoint, transport: transport)
        case .openAIChat: return OpenAIChatProvider(endpoint: endpoint, transport: transport)
        }
    }
}
