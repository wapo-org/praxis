import Foundation
import AgentCore

/// Adapter for OpenAI Chat Completions-compatible endpoints
/// (`POST /chat/completions`): OpenAI, OpenRouter, LM Studio, Ollama, vLLM,
/// llama.cpp, Groq, Together, DeepSeek, …
public struct OpenAIChatProvider: ModelProvider {
    public let endpoint: ProviderEndpoint
    private let transport: any HTTPTransport

    public init(endpoint: ProviderEndpoint, transport: (any HTTPTransport)? = nil) {
        self.endpoint = endpoint
        // A caller-supplied transport (tests) is used as-is; the default is
        // guarded so redirects can't carry the key to another host.
        self.transport = transport ?? URLSessionTransport(allowRedirect: HTTPSupport.redirectGuard(for: endpoint.baseURL))
    }

    public var flavor: ProviderFlavor { .openAIChat }
    public var capabilities: Capabilities { endpoint.capabilities }

    private var builder: OpenAIRequestBuilder {
        OpenAIRequestBuilder(capabilities: endpoint.capabilities, options: endpoint.openAI)
    }

    func requestBody(_ request: ProviderRequest) -> Data {
        builder.body(for: request).encodedData()
    }

    func headers(streaming: Bool) -> [String: String] {
        var h: [String: String] = ["accept": streaming ? "text/event-stream" : "application/json"]
        if streaming { h["content-type"] = "application/json" }
        if !endpoint.apiKey.isEmpty { h["authorization"] = "Bearer \(endpoint.apiKey)" }
        return HTTPSupport.merged(h, extra: endpoint.extraHeaders)
    }

    public func stream(_ request: ProviderRequest) -> AsyncThrowingStream<ProviderEvent, Error> {
        let urlRequest = HTTPSupport.prepare {
            HTTPSupport.request(try endpoint.url("chat/completions"), headers: headers(streaming: true),
                                body: requestBody(request), timeout: HTTPSupport.streamTimeout)
        }
        return HTTPSupport.eventStream(transport: transport, request: urlRequest, accumulator: OpenAIStreamAccumulator())
    }

    /// `GET /models`. Reads the optional metadata OpenRouter (`name`,
    /// `context_length`, `top_provider.max_completion_tokens`) and vLLM
    /// (`max_model_len`) add.
    public func listModels() async throws -> [ModelInfo] {
        let json = try await HTTPSupport.getJSON(transport: transport, url: try endpoint.url("models"),
                                                 headers: headers(streaming: false))
        guard let data = json["data"]?.arrayValue ?? json["models"]?.arrayValue else {
            throw ProviderError.decoding("The model list has no `data` array.")
        }
        return data.compactMap { m in
            guard let id = m["id"]?.stringValue ?? m["name"]?.stringValue else { return nil }
            return ModelInfo(id: id, displayName: m["name"]?.stringValue,
                             contextWindow: m["context_length"]?.intValue ?? m["context_window"]?.intValue ?? m["max_model_len"]?.intValue,
                             maxOutputTokens: m["top_provider"]?["max_completion_tokens"]?.intValue,
                             supportsImages: HTTPSupport.imageSupport(in: m),
                             supportsTools: HTTPSupport.toolSupport(in: m),
                             reasoningEfforts: HTTPSupport.reasoningEfforts(in: m, defaultLevels: EffortLevels.openAIFamilyDefault))
        }
    }
}
