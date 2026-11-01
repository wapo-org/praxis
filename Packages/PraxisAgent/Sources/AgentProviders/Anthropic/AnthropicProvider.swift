import Foundation
import AgentCore

/// Adapter for Anthropic Messages-compatible endpoints (`POST /messages`).
public struct AnthropicProvider: ModelProvider {
    public let endpoint: ProviderEndpoint
    private let transport: any HTTPTransport

    public init(endpoint: ProviderEndpoint, transport: (any HTTPTransport)? = nil) {
        self.endpoint = endpoint
        // A caller-supplied transport (tests) is used as-is; the default is
        // guarded so redirects can't carry the key to another host.
        self.transport = transport ?? URLSessionTransport(allowRedirect: HTTPSupport.redirectGuard(for: endpoint.baseURL))
    }

    public var flavor: ProviderFlavor { .anthropicMessages }
    public var capabilities: Capabilities { endpoint.capabilities }

    private var builder: AnthropicRequestBuilder {
        AnthropicRequestBuilder(capabilities: endpoint.capabilities, options: endpoint.anthropic)
    }

    /// Exact body bytes for a request (sorted keys: identical transcripts
    /// produce identical bytes, which keeps the prompt cache warm).
    func requestBody(_ request: ProviderRequest) -> Data {
        builder.body(for: request).encodedData()
    }

    func headers(streaming: Bool) -> [String: String] {
        var h: [String: String] = [
            "anthropic-version": endpoint.anthropic.version,
            "accept": streaming ? "text/event-stream" : "application/json",
        ]
        if streaming { h["content-type"] = "application/json" }
        if !endpoint.apiKey.isEmpty {
            switch endpoint.anthropic.auth {
            case .apiKeyHeader: h["x-api-key"] = endpoint.apiKey
            case .bearer: h["authorization"] = "Bearer \(endpoint.apiKey)"
            }
        }
        if !endpoint.anthropic.betas.isEmpty { h["anthropic-beta"] = endpoint.anthropic.betas.joined(separator: ",") }
        return HTTPSupport.merged(h, extra: endpoint.extraHeaders)
    }

    public func stream(_ request: ProviderRequest) -> AsyncThrowingStream<ProviderEvent, Error> {
        let urlRequest = HTTPSupport.prepare {
            HTTPSupport.request(try endpoint.url("messages"), headers: headers(streaming: true),
                                body: requestBody(request), timeout: HTTPSupport.streamTimeout)
        }
        return HTTPSupport.eventStream(transport: transport, request: urlRequest, accumulator: AnthropicStreamAccumulator())
    }

    /// `GET /models`, following `has_more` / `last_id` pagination.
    public func listModels() async throws -> [ModelInfo] {
        var models: [ModelInfo] = []
        var after: String?
        for _ in 0..<20 {
            var query = [URLQueryItem(name: "limit", value: "1000")]
            if let after { query.append(URLQueryItem(name: "after_id", value: after)) }
            let page = try await HTTPSupport.getJSON(transport: transport, url: try endpoint.url("models", query: query),
                                                     headers: headers(streaming: false))
            guard let data = page["data"]?.arrayValue else {
                throw ProviderError.decoding("The model list has no `data` array.")
            }
            for m in data {
                guard let id = m["id"]?.stringValue else { continue }
                models.append(ModelInfo(id: id, displayName: m["display_name"]?.stringValue,
                                        contextWindow: m["max_input_tokens"]?.intValue,
                                        maxOutputTokens: m["max_tokens"]?.intValue,
                                        supportsImages: HTTPSupport.imageSupport(in: m),
                                        supportsTools: HTTPSupport.toolSupport(in: m),
                                        reasoningEfforts: HTTPSupport.reasoningEfforts(in: m, defaultLevels: EffortLevels.anthropicFamilyDefault)))
            }
            guard page["has_more"]?.boolValue == true, let last = page["last_id"]?.stringValue, last != after else { break }
            after = last
        }
        return models
    }
}
