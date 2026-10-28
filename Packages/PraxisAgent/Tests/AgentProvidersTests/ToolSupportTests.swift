import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentProviders

/// A model without tool support: the model list says so up front when it
/// can, the rejection family is recognized, and a tools-off request carries
/// no tools, a note, and flattened history instead of failing.
@Suite struct ToolSupportTests {
    /// OpenRouter's reply when no endpoint serving the model does tool use:
    /// its documented error shape (`{"error":{"code","message"}}`), the same
    /// one its "No endpoints found that support image input" 404 has.
    static let openRouter404 = #"{"error":{"message":"No endpoints found that support tool use","code":404}}"#

    let png = MediaData(mediaType: "image/png", data: Data([0x89, 0x50, 0x4E, 0x47]), name: "chart.png")

    private var noTools: Capabilities {
        var caps = ProviderPreset.openAI.defaultCapabilities
        caps.tools = false
        return caps
    }

    private var noToolsAnthropic: Capabilities {
        var caps = ProviderPreset.anthropic.defaultCapabilities
        caps.tools = false
        return caps
    }

    private func history() -> [Message] {
        [
            .user("What's the weather in Paris?"),
            Message(role: .assistant, parts: [.text("Let me check."),
                                              .toolCall(ToolCall(id: "c1", name: "get_weather", arguments: #"{"location":"Paris"}"#))]),
            Message(role: .user, parts: [.toolResult(ToolResult(callID: "c1", toolName: "get_weather", content: [.text("18°C")]))]),
            .user("And tomorrow?"),
        ]
    }

    private func registry() -> ToolRegistry {
        ToolRegistry([ClosureTool(name: "get_weather") { _, _ in .text("sunny") }])
    }

    private func outcome(of events: [AgentEvent]) -> RunOutcome? {
        events.compactMap { if case .finished(let o) = $0 { return o }; return nil }.first
    }

    @Test(arguments: [
        "No endpoints found that support tool use",
        "HTTP 404: No endpoints found that support tool use",
        "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing",
        "Model x/y does not support tools",
        "This model does not support tool use.",
        "Tool use is not supported by this model",
        "tools are not supported for this model",
        "Tool calling is not supported",
        "Function calling is not supported on this endpoint",
        "The model does not support function calling",
        "Invalid schema: `tools` is not supported",
        "Invalid schema: 'tools' is not supported",
        "unsupported parameter: tools",
        "tool_choice is not supported by this model",
    ])
    func recognizesTheFamily(_ message: String) {
        #expect(ToolSupport.isToolUseRejection(message))
        #expect(ProviderError.http(status: 404, message: message, retryAfter: nil).isToolUseUnsupported)
        #expect(ProviderError.stream(type: "invalid_request_error", message: message).isToolUseUnsupported)
        #expect(RunOutcome.failed(message).isToolUseRejection)
    }

    @Test(arguments: [
        "No endpoints found that support image input",
        "No endpoints found matching your data policy",
        "Rate limit exceeded",
        "x/y is not a valid model ID",
        "Prompt is too long",
        "image input is not supported",
        "Unknown tool get_weather.",
    ])
    func leavesOtherErrorsAlone(_ message: String) {
        #expect(!ToolSupport.isToolUseRejection(message))
        #expect(!ProviderError.http(status: 404, message: message, retryAfter: nil).isToolUseUnsupported)
        #expect(!RunOutcome.failed(message).isToolUseRejection)
    }

    @Test func rejectionsAreNotRetriedEvenAs5xx() {
        #expect(!ProviderError.http(status: 500, message: "tool use is not supported", retryAfter: nil).isRetryable)
        #expect(!ProviderError.stream(type: "server_error", message: "does not support tools").isRetryable)
        #expect(ProviderError.http(status: 500, message: "Internal error", retryAfter: nil).isRetryable)
    }

    @Test func modelListsReportToolUse() async throws {
        let openRouter = """
        {"data": [
          {"id": "agent", "supported_parameters": ["max_tokens", "tools", "tool_choice"]},
          {"id": "chat", "supported_parameters": ["max_tokens", "reasoning"]},
          {"id": "lmstudio", "capabilities": ["vision", "tool_use"]},
          {"id": "ollama", "capabilities": ["completion"]},
          {"id": "unknown"}
        ]}
        """
        let openAI = OpenAIChatProvider(endpoint: openAIEndpoint(), transport: ScriptedTransport(replies: [.json(openRouter)]))
        #expect(try await openAI.listModels().map(\.supportsTools) == [true, false, true, false, nil])

        let anthropicList = """
        {"data": [
          {"id": "claude-x", "display_name": "Claude X", "capabilities": {"tool_use": {"supported": true}}},
          {"id": "claude-plain", "capabilities": {"tool_use": false}},
          {"id": "plain"}
        ], "has_more": false}
        """
        let anthropic = AnthropicProvider(endpoint: anthropicEndpoint(), transport: ScriptedTransport(replies: [.json(anthropicList)]))
        #expect(try await anthropic.listModels().map(\.supportsTools) == [true, false, nil])

        // Mercury (the vision handoff's model) is text-only but tool-capable.
        let mercury = """
        {"data": [
          {"id": "inception/mercury-3", "name": "Inception: Mercury 3",
           "architecture": {"modality": "text->text", "input_modalities": ["text"]},
           "supported_parameters": ["max_tokens", "reasoning", "tools", "tool_choice"]}
        ]}
        """
        let m = try await OpenAIChatProvider(endpoint: openAIEndpoint(),
                                             transport: ScriptedTransport(replies: [.json(mercury)])).listModels()
        #expect(m.map(\.supportsImages) == [false])
        #expect(m.map(\.supportsTools) == [true])

        // Old caches without the fields still decode.
        let old = try JSONDecoder().decode(ModelInfo.self, from: Data(#"{"id":"m","displayName":"m"}"#.utf8))
        #expect(old.supportsImages == nil)
        #expect(old.supportsTools == nil)
    }

    @Test func toolsOffOpenAIRequestHasNoToolsNoteAndFlattenedHistory() throws {
        let transcript = history()
        let openAI = OpenAIChatProvider(endpoint: openAIEndpoint(noTools), transport: ScriptedTransport(replies: []))
        let body = try bodyJSON(openAI, request(transcript, tools: [weatherTool]))
        #expect(body["tools"] == nil)
        #expect(!body.encodedString().contains("tool_choice"))

        let system = try #require(body["messages"]?[0]?["content"]?.stringValue)
        #expect(system.contains("You are helpful."))
        #expect(system.contains(ToolSupport.toolsOffNote))
        #expect(body.count(key: "tool_calls") == 0)
        #expect(body["messages"]?.arrayValue?.allSatisfy { $0["role"] != "tool" } == true)

        let assistant = try #require(body["messages"]?[2])
        #expect(assistant["role"] == "assistant")
        let text = try #require(assistant["content"]?.stringValue)
        #expect(text.contains("Let me check."))
        #expect(text.contains(#"[Tool call: get_weather({"location":"Paris"})]"#))

        // The flattened result and the follow-up merge into one user message.
        let merged = try #require(body["messages"]?[3])
        #expect(merged["role"] == "user")
        let userText = try #require(merged["content"]?.stringValue)
        #expect(userText.contains("[Tool result from get_weather: 18°C]"))
        #expect(userText.contains("And tomorrow?"))

        // The transcript itself still carries the real calls and results.
        #expect(transcript[1].toolCalls.map(\.name) == ["get_weather"])
        #expect(transcript[2].toolResults.map(\.toolName) == ["get_weather"])
    }

    @Test func toolsOffAnthropicRequestHasNoToolsNoteAndFlattenedHistory() throws {
        let anthropic = AnthropicProvider(endpoint: anthropicEndpoint(noToolsAnthropic), transport: ScriptedTransport(replies: []))
        // Web search asked for too: with no tool support nothing is declared.
        let body = try bodyJSON(anthropic, request(history(), tools: [weatherTool], webSearch: true))
        #expect(body["tools"] == nil)
        #expect(!body.encodedString().contains("tool_choice"))

        let system = try #require(body["system"]?[0]?["text"]?.stringValue)
        #expect(system.contains("You are helpful."))
        #expect(system.contains(ToolSupport.toolsOffNote))

        let types = body["messages"]?.arrayValue?.flatMap { $0["content"]?.arrayValue ?? [] }
            .compactMap { $0["type"]?.stringValue } ?? []
        #expect(!types.contains("tool_use") && !types.contains("tool_result"))

        let assistant = try #require(body["messages"]?[1]?["content"]?.arrayValue)
        let assistantText = assistant.compactMap { $0["text"]?.stringValue }.joined(separator: "\n")
        #expect(assistantText.contains(#"[Tool call: get_weather({"location":"Paris"})]"#))
        let user = try #require(body["messages"]?[2]?["content"]?.arrayValue)
        let userText = user.compactMap { $0["text"]?.stringValue }.joined(separator: "\n")
        #expect(userText.contains("[Tool result from get_weather: 18°C]"))
        #expect(userText.contains("And tomorrow?"))
    }

    @Test func toolsOffWithNoSystemPromptStillCarriesTheNote() throws {
        let openAI = OpenAIChatProvider(endpoint: openAIEndpoint(noTools), transport: ScriptedTransport(replies: []))
        let body = try bodyJSON(openAI, request([.user("hi")], system: "", tools: [weatherTool]))
        #expect(body["messages"]?[0]?["content"]?.stringValue == ToolSupport.toolsOffNote)

        let anthropic = AnthropicProvider(endpoint: anthropicEndpoint(noToolsAnthropic), transport: ScriptedTransport(replies: []))
        let aBody = try bodyJSON(anthropic, request([.user("hi")], system: "", tools: [weatherTool]))
        #expect(aBody["system"]?[0]?["text"]?.stringValue == ToolSupport.toolsOffNote)
    }

    @Test func toolsOffVisionStillSendsImages() throws {
        let messages: [Message] = [
            Message(role: .user, parts: [.image(png), .text("What's this?")]),
            Message(role: .assistant, parts: [.toolCall(ToolCall(id: "c1", name: "screenshot", arguments: "{}"))]),
            Message(role: .user, parts: [.toolResult(ToolResult(callID: "c1", toolName: "screenshot",
                                                                content: [.text("ok"), .image(png)]))]),
        ]
        let openAI = OpenAIChatProvider(endpoint: openAIEndpoint(noTools), transport: ScriptedTransport(replies: []))
        let body = try bodyJSON(openAI, request(messages, tools: [weatherTool]))
        let encoded = body.encodedString()
        #expect(encoded.contains("image_url"))
        #expect(encoded.contains("[Tool call: screenshot({})]"))
        #expect(encoded.contains("[Tool result from screenshot:"))
        #expect(encoded.contains("attached with this message"))
    }

    @Test func toolsOffDoesNotReplayStoredToolCalls() throws {
        let openAIRaw = #"{"role":"assistant","content":null,"tool_calls":[{"id":"c1","type":"function","function":{"name":"get_weather","arguments":"{}"}}]}"#
        let assistant = Message(role: .assistant, parts: [.toolCall(ToolCall(id: "c1", name: "get_weather", arguments: "{}"))],
                                raw: ProviderPayload(flavor: .openAIChat, data: Data(openAIRaw.utf8)))
        let off = OpenAIChatProvider(endpoint: openAIEndpoint(noTools), transport: ScriptedTransport(replies: []))
        let rebuilt = try #require(try bodyJSON(off, request([.user("hi"), assistant], tools: [weatherTool]))["messages"]?[2])
        #expect(rebuilt["tool_calls"] == nil)
        #expect(rebuilt["content"]?.stringValue?.contains("[Tool call: get_weather({})]") == true)

        let on = OpenAIChatProvider(endpoint: openAIEndpoint(), transport: ScriptedTransport(replies: []))
        let replayed = try #require(try bodyJSON(on, request([.user("hi"), assistant], tools: [weatherTool]))["messages"]?[2])
        #expect(replayed["tool_calls"] != nil)

        let anthropicRaw = #"[{"type":"text","text":"Checking."},{"type":"tool_use","id":"c1","name":"get_weather","input":{}}]"#
        let aAssistant = Message(role: .assistant, parts: [.text("Checking."),
                                                           .toolCall(ToolCall(id: "c1", name: "get_weather", arguments: "{}"))],
                                 raw: ProviderPayload(flavor: .anthropicMessages, data: Data(anthropicRaw.utf8)))
        let aOff = AnthropicProvider(endpoint: anthropicEndpoint(noToolsAnthropic), transport: ScriptedTransport(replies: []))
        let aRebuilt = try #require(try bodyJSON(aOff, request([.user("hi"), aAssistant], tools: [weatherTool]))["messages"]?[1])
        let rebuiltTypes = aRebuilt["content"]?.arrayValue?.compactMap { $0["type"]?.stringValue } ?? []
        #expect(!rebuiltTypes.contains("tool_use"))
        #expect(aRebuilt["content"]?.arrayValue?.compactMap { $0["text"]?.stringValue }.joined()
            .contains("[Tool call: get_weather({})]") == true)

        let aOn = AnthropicProvider(endpoint: anthropicEndpoint(), transport: ScriptedTransport(replies: []))
        let aReplayed = try #require(try bodyJSON(aOn, request([.user("hi"), aAssistant], tools: [weatherTool]))["messages"]?[1])
        #expect(aReplayed["content"]?.arrayValue?.compactMap { $0["type"]?.stringValue }.contains("tool_use") == true)
    }

    @Test func rejectionFailsTheLoopRunOnce() async throws {
        let provider = ScriptedProvider(steps: [.failure(.http(status: 404, message: "No endpoints found that support tool use",
                                                                retryAfter: nil))])
        let loop = AgentLoop(provider: provider, tools: registry())
        let events = await loop.run(transcript: [.user("hi")],
                                    configuration: AgentRunConfiguration(conversationID: "c1", model: "m", system: "sys",
                                                                         effort: .low)).collect()
        let failed = outcome(of: events)
        #expect(failed == .failed("HTTP 404: No endpoints found that support tool use"))
        #expect(failed?.isToolUseRejection == true)
        #expect(provider.requests.count == 1, "a rejection isn't retried as is")
        #expect(provider.requests.first?.tools.map(\.name) == ["get_weather"], "the run sent tools")
    }

    @Test func toolsOffLoopSendsNoTools() async {
        var caps = Capabilities()
        caps.tools = false
        let provider = ScriptedProvider(capabilities: caps, steps: [ScriptedProvider.text("plain answer")])
        let loop = AgentLoop(provider: provider, tools: registry())
        let events = await loop.run(transcript: [.user("hi")],
                                    configuration: AgentRunConfiguration(conversationID: "c1", model: "m", system: "sys",
                                                                         effort: .low)).collect()
        #expect(outcome(of: events) == .completed)
        #expect(provider.requests.count == 1)
        #expect(provider.requests.first?.tools == [], "the loop withholds tools when the model can't use them")
    }

    @Test func theRealBodyBecomesTheErrorAndIsRecognized() async throws {
        let transport = ScriptedTransport(replies: [.json(Self.openRouter404, status: 404)])
        let provider = OpenAIChatProvider(endpoint: openAIEndpoint(), transport: transport)
        var thrown: ProviderError?
        do {
            for try await _ in provider.stream(ProviderRequest(model: "x/y", system: "", messages: [.user("hi")],
                                                               tools: [weatherTool], maxTokens: 100, effort: .low)) {}
        } catch let error as ProviderError {
            thrown = error
        }
        #expect(thrown == .http(status: 404, message: "No endpoints found that support tool use", retryAfter: nil))
        #expect(thrown?.isToolUseUnsupported == true)
        #expect(thrown?.isRetryable == false)
    }
}
