import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentProviders

@Suite struct EndpointTests {
    @Test(arguments: [
        ("https://api.anthropic.com/v1", "https://api.anthropic.com/v1/messages"),
        ("https://api.anthropic.com", "https://api.anthropic.com/v1/messages"),
        ("https://api.anthropic.com/", "https://api.anthropic.com/v1/messages"),
        ("http://192.168.1.5:1234/v1/", "http://192.168.1.5:1234/v1/messages"),
        ("https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/v1/messages"),
        ("https://gateway.example/v1/messages", "https://gateway.example/v1/messages"),
        ("https://proxy.example/openai/v1?api-version=2", "https://proxy.example/openai/v1/messages?api-version=2"),
    ])
    func baseURLNormalization(base: String, expected: String) throws {
        let e = ProviderEndpoint(flavor: .anthropicMessages, baseURL: try #require(URL(string: base)))
        #expect(try e.url("messages").absoluteString == expected)
    }

    @Test func rejectsNonHTTPBaseURLs() throws {
        let e = ProviderEndpoint(flavor: .openAIChat, baseURL: try #require(URL(string: "file:///tmp/x")))
        #expect(throws: ProviderError.self) { try e.url("models") }
    }

    @Test func codableNeverContainsTheKey() throws {
        var e = try #require(ProviderPreset.anthropic.endpoint(apiKey: "sk-ant-super-secret"))
        e.extraHeaders = ["X-Org": "42"]
        e.anthropic.webFetchToolType = nil
        let data = try JSONEncoder().encode(e)
        #expect(!String(decoding: data, as: UTF8.self).contains("sk-ant-super-secret"))
        #expect(!e.description.contains("sk-ant-super-secret"))
        #expect(!String(describing: e).contains("sk-ant-super-secret"))
        #expect(!String(reflecting: e).contains("sk-ant-super-secret"))
        var dumped = ""
        dump(e, to: &dumped)
        #expect(!dumped.contains("sk-ant-super-secret"))
        let provider = AnthropicProvider(endpoint: e, transport: ScriptedTransport(replies: []))
        #expect(!String(describing: provider).contains("sk-ant-super-secret"))

        var decoded = try JSONDecoder().decode(ProviderEndpoint.self, from: data)
        #expect(decoded.apiKey == "")
        #expect(decoded.anthropic.webFetchToolType == nil) // explicit "off" survives
        decoded.apiKey = "sk-ant-super-secret"
        #expect(decoded == e)
    }

    @Test func optionsDecodeWithMissingKeys() throws {
        let json = #"{"flavor":"openAIChat","baseURL":"http://localhost:11434/v1","openAI":{"systemRole":"developer"},"anthropic":{}}"#
        let e = try JSONDecoder().decode(ProviderEndpoint.self, from: Data(json.utf8))
        #expect(e.openAI == OpenAIOptions(systemRole: "developer"))
        #expect(e.anthropic == AnthropicOptions())
        #expect(e.capabilities == .conservative)
    }

    @Test func presets() throws {
        for preset in ProviderPreset.allCases {
            let caps = preset.defaultCapabilities
            if let e = preset.endpoint(apiKey: "k") {
                #expect(e.flavor == preset.flavor)
                #expect(ProviderFactory.make(e, transport: ScriptedTransport(replies: [])).flavor == preset.flavor)
                #expect(e.capabilities == caps)
            } else {
                #expect(preset.defaultBaseURL == nil)
            }
        }
        #expect(ProviderPreset.customOpenAI.endpoint() == nil)
        #expect(ProviderPreset.customOpenAI.defaultCapabilities == .conservative)
        #expect(ProviderPreset.anthropic.defaultCapabilities.serverWebSearch)
        #expect(ProviderPreset.anthropic.defaultCapabilities.explicitPromptCaching)
        #expect(!ProviderPreset.openAI.defaultCapabilities.serverWebSearch)
        #expect(ProviderPreset.openAI.defaultOpenAIOptions.maxTokensField == .maxCompletionTokens)
        #expect(ProviderPreset.openRouterAnthropic.defaultAnthropicOptions.auth == .bearer)
        #expect(ProviderFactory.make(try #require(ProviderPreset.openRouterOpenAI.endpoint()), transport: ScriptedTransport(replies: [])) is OpenAIChatProvider)
    }

    @Test func anthropicModelsArePaginated() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.json("anthropic_models_page1.json"), try Fixture.json("anthropic_models_page2.json")])
        let models = try await AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport).listModels()
        #expect(models.map(\.id) == ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"])
        #expect(models[0] == ModelInfo(id: "claude-opus-5-5", displayName: "Claude Opus 5.5", contextWindow: 1_000_000, maxOutputTokens: 128_000))
        #expect(transport.requests.map(\.method) == ["GET", "GET"])
        #expect(transport.requests[0].url?.absoluteString == "https://api.anthropic.com/v1/models?limit=1000")
        #expect(transport.requests[1].url?.absoluteString == "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-sonnet-5-5")
        #expect(transport.requests[0].headers.contains { $0.key.lowercased() == "x-api-key" && $0.value == testKey })
    }

    @Test func openAIModels() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.json("openai_models.json")])
        let models = try await OpenAIChatProvider(endpoint: openAIEndpoint(), transport: transport).listModels()
        #expect(models == [
            ModelInfo(id: "gpt-5.1"),
            ModelInfo(id: "anthropic/claude-opus-5.5", displayName: "Anthropic: Claude Opus 5.5", contextWindow: 1_000_000, maxOutputTokens: 128_000),
        ])
        #expect(transport.requests[0].url?.absoluteString == "https://api.openai.com/v1/models")
    }
}

@Suite struct RedirectGuardTests {
    @Test func staysOnHostAndNeverDowngrades() throws {
        func url(_ s: String) throws -> URL { try #require(URL(string: s)) }
        let https = HTTPSupport.redirectGuard(for: try url("https://api.openai.com/v1"))
        #expect(https(try url("https://api.openai.com/v1/models")))
        #expect(!https(try url("https://evil.example/v1")))
        #expect(!https(try url("http://api.openai.com/v1"))) // no downgrade
        #expect(!https(try url("https://api.openai.com.evil.example/v1"))) // suffix match isn't same-host
        let http = HTTPSupport.redirectGuard(for: try url("http://localhost:1234/v1"))
        #expect(http(try url("http://localhost:1234/v1/models")))
        #expect(http(try url("https://localhost:1234/v1"))) // upgrade is fine
        #expect(!http(try url("http://other:1234/v1")))
    }
}

@Suite struct ProbeTests {
    private let toolCallSSE = """
    data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_p","type":"function","function":{"name":"probe_echo","arguments":"{\\"value\\":\\"ping\\"}"}}]}}]}

    data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":60,"completion_tokens":12}}

    data: [DONE]


    """

    @Test func healthyEndpoint() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.json("openai_models.json"), .sse(toolCallSSE)])
        var endpoint = openAIEndpoint(.conservative)
        endpoint.capabilities.tools = false
        let report = await ProviderProbe(transport: transport).test(endpoint)
        #expect(report.isUsable)
        #expect(report.testedModel == "gpt-5.1")
        #expect(report.checks.map(\.status) == [.passed, .passed, .passed, .passed])
        #expect(report.suggestedCapabilities.tools)
        // The probe request carried exactly one tool.
        #expect(sentBody(transport, 1)?["tools"]?.arrayValue?.count == 1)
    }

    @Test func toolsRejectedButChatWorks() async throws {
        let rejected = ScriptedTransport.Reply.json(#"{"error":{"message":"tools are not supported for this model","type":"invalid_request_error"}}"#, status: 400)
        let transport = ScriptedTransport(replies: [try Fixture.json("openai_models.json"), rejected, try Fixture.sse("openai_text.sse")])
        let report = await ProviderProbe(transport: transport).test(openAIEndpoint(), model: "gpt-5.1")
        #expect(report.isUsable)
        #expect(!report.suggestedCapabilities.tools)
        #expect(report.checks.first { $0.id == ProbeReport.tools }?.status == .failed)
        #expect(sentBody(transport, 2)?["tools"] == nil)
    }

    @Test func openRouterStyle404ForToolUseReportsToolsFailed() async throws {
        let rejected = ScriptedTransport.Reply.json(#"{"error":{"message":"No endpoints found that support tool use","code":404}}"#, status: 404)
        let transport = ScriptedTransport(replies: [try Fixture.json("openai_models.json"), rejected, try Fixture.sse("openai_text.sse")])
        let report = await ProviderProbe(transport: transport).test(openAIEndpoint(), model: "gpt-5.1")
        #expect(report.isUsable)
        #expect(!report.suggestedCapabilities.tools)
        #expect(report.checks.first { $0.id == ProbeReport.chat }?.status == .passed)
        #expect(report.checks.first { $0.id == ProbeReport.tools }?.status == .failed)
        #expect(sentBody(transport, 2)?["tools"] == nil)
    }

    @Test func unrelated404StillFailsChatWithoutARetry() async throws {
        let rejected = ScriptedTransport.Reply.json(#"{"error":{"message":"Not Found","code":404}}"#, status: 404)
        let transport = ScriptedTransport(replies: [try Fixture.json("openai_models.json"), rejected])
        let report = await ProviderProbe(transport: transport).test(openAIEndpoint(), model: "gpt-5.1")
        #expect(!report.isUsable)
        #expect(report.checks.first { $0.id == ProbeReport.chat }?.status == .failed)
        #expect(transport.requests.count == 2)
    }

    @Test func badKeyStopsEarly() async throws {
        let transport = ScriptedTransport(replies: [.json(#"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"#, status: 401)])
        let report = await ProviderProbe(transport: transport).test(anthropicEndpoint())
        #expect(!report.isUsable)
        #expect(report.checks.count == 1)
        #expect(report.checks[0].detail == "The API key was rejected: invalid x-api-key")
        #expect(transport.requests.count == 1)
    }

    @Test func serverWithoutModelListUsesGivenModel() async throws {
        let transport = ScriptedTransport(replies: [.json(#"{"detail":"Not Found"}"#, status: 404), .sse(toolCallSSE)])
        let report = await ProviderProbe(transport: transport).test(openAIEndpoint(.conservative), model: "local-model")
        #expect(report.isUsable)
        #expect(report.checks.first?.status == .warning)
        #expect(report.testedModel == "local-model")
        #expect(sentBody(transport, 1)?["model"] == "local-model")
    }
}
