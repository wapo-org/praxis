import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentProviders

@Suite struct AnthropicRequestTests {
    let png = MediaData(mediaType: "image/png", data: Data([0x89, 0x50, 0x4E, 0x47]), name: "chart.png")

    /// Assistant turn that issued the calls the results answer.
    let calls = Message(role: .assistant, parts: [
        .toolCall(ToolCall(id: "a", name: "x", arguments: "{}")),
        .toolCall(ToolCall(id: "b", name: "y", arguments: "{}")),
        .toolCall(ToolCall(id: "c", name: "z", arguments: "{}")),
    ])

    private func provider(_ caps: Capabilities? = nil, options: AnthropicOptions? = nil) -> AnthropicProvider {
        AnthropicProvider(endpoint: anthropicEndpoint(caps, options: options), transport: ScriptedTransport(replies: []))
    }

    @Test func rawReplayIsVerbatimAndByteStable() async throws {
        let (_, response) = try await streamFixture("anthropic_text_thinking_tool.sse", flavor: .anthropicMessages)
        let assistant = try #require(response).message
        let results = Message(role: .user, parts: [.toolResult(ToolResult(callID: "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
                                                                          toolName: "get_weather", content: [.text("18°C")]))])
        let r = request([.user("Weather in Paris?"), assistant, results], tools: [weatherTool])
        let p = provider()

        let first = p.requestBody(r)
        let second = p.requestBody(r)
        #expect(first == second)

        let body = try JSONValue(parsing: first)
        let messages = try #require(body["messages"]?.arrayValue)
        #expect(messages.count == 3)
        #expect(messages[1]["role"] == "assistant")
        // Exactly the stored blocks — signature included, nothing added.
        let stored = try JSONValue(parsing: try #require(assistant.raw).data)
        #expect(messages[1]["content"] == stored)
        #expect(String(decoding: first, as: UTF8.self).contains(#""signature":"EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds+4Tq0Bzu/QR7r8aT9fmtYgQ8pWZ0n==""#))
    }

    @Test func webSearchReplayKeepsEncryptedContent() async throws {
        let (_, response) = try await streamFixture("anthropic_web_search.sse", flavor: .anthropicMessages)
        let assistant = try #require(response).message
        let body = String(decoding: provider().requestBody(request([.user("When was Swift 6.2 released?"), assistant, .user("thanks")])),
                          as: UTF8.self)
        #expect(body.contains("EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y2MSDCSDgEAEi2uGKtkdbxoMMy1hKZJqnjOa+wJ/"))
        #expect(body.contains(#""encrypted_index":"Eo8BCioIAhgBIiQ3YTAwMjY1Mi1mZjM5""#))
        #expect(body.contains(#""type":"server_tool_use""#))
    }

    @Test func otherFlavorAssistantIsRebuiltWithoutReasoning() throws {
        let openAIRaw = ProviderPayload(flavor: .openAIChat, data: Data(#"{"role":"assistant","content":"Checking."}"#.utf8))
        let assistant = Message(role: .assistant, parts: [
            .reasoning(Reasoning(text: "hidden", signature: nil)),
            .text("Checking."),
            .toolCall(ToolCall(id: "call_1", name: "get_weather", arguments: #"{"location":"Oslo"}"#)),
            .toolCall(ToolCall(id: "call_2", name: "get_weather", arguments: "{broken")),
        ], raw: openAIRaw)
        let body = try bodyJSON(provider(), request([.user("hi"), assistant]))
        let content = try #require(body["messages"]?[1]?["content"])
        #expect(content == [
            ["type": "text", "text": "Checking."],
            ["type": "tool_use", "id": "call_1", "name": "get_weather", "input": ["location": "Oslo"]],
            ["type": "tool_use", "id": "call_2", "name": "get_weather", "input": [:]],
        ])
    }

    @Test func toolResultsShareOneUserMessageAndLead() throws {
        var caps = ProviderPreset.anthropic.defaultCapabilities
        caps.explicitPromptCaching = false
        let results = Message(role: .user, parts: [
            .note("Mode changed to plan."),
            .toolResult(ToolResult(callID: "a", toolName: "x", content: [.text("ok"), .image(png)])),
            .toolResult(ToolResult(callID: "b", toolName: "y", content: [.text("boom")], isError: true)),
            .toolResult(ToolResult(callID: "c", toolName: "z", content: [])),
        ])
        let body = try bodyJSON(provider(caps), request([.user("go"), calls, results]))
        let messages = try #require(body["messages"]?.arrayValue)
        #expect(messages.count == 3)
        let content = try #require(messages[2]["content"]?.arrayValue)
        #expect(content.map { $0["type"]?.stringValue } == ["tool_result", "tool_result", "tool_result", "text"])
        #expect(content[0] == ["type": "tool_result", "tool_use_id": "a", "content": [
            ["type": "text", "text": "ok"],
            ["type": "image", "source": ["type": "base64", "media_type": "image/png", "data": "iVBORw=="]],
        ]])
        #expect(content[1]["is_error"] == true)
        #expect(content[0]["is_error"] == nil)
        #expect(content[2]["content"] == [["type": "text", "text": "(no output)"]])
        #expect(content[3]["text"] == "<system-reminder>\nMode changed to plan.\n</system-reminder>")
    }

    @Test func toolResultImagesMoveOutWhenNotSupportedInline() throws {
        var caps = ProviderPreset.anthropic.defaultCapabilities
        caps.imagesInToolResults = false
        let results = Message(role: .user, parts: [.toolResult(ToolResult(callID: "a", toolName: "x", content: [.image(png)]))])
        let content = try #require(try bodyJSON(provider(caps), request([.user("go"), calls, results]))["messages"]?[2]?["content"]?.arrayValue)
        #expect(content.count == 2)
        #expect(content[0]["content"]?[0]?["text"] == "[image \"chart.png\" attached after the tool results]")
        #expect(content[1]["type"] == "image")
    }

    @Test func imagesAndDocumentsFollowCapabilities() throws {
        let pdf = MediaData(mediaType: "application/pdf", data: Data("%PDF".utf8), name: "a.pdf")
        let notes = MediaData(mediaType: "text/markdown", data: Data("# Notes".utf8), name: "notes.md")
        let user = Message(role: .user, parts: [.image(png), .document(pdf), .document(notes), .text("Summarize")])

        let full = try #require(try bodyJSON(provider(), request([user]))["messages"]?[0]?["content"]?.arrayValue)
        #expect(full[0]["type"] == "image")
        #expect(full[1] == ["type": "document", "title": "a.pdf",
                            "source": ["type": "base64", "media_type": "application/pdf", "data": "JVBERg=="]])
        #expect(full[2]["source"] == ["type": "text", "media_type": "text/plain", "data": "# Notes"])

        let limited = try #require(try bodyJSON(provider(.conservative), request([user]))["messages"]?[0]?["content"]?.arrayValue)
        #expect(limited[0]["text"] == "[Image img_0f4636c78f65 “chart.png” (image/png, 4 B) — the user attached this image, but the current model can't view images and this conversation has no image-reading tool. If its content matters, ask the user to describe it.]")
        #expect(limited[1]["text"] == "[Document \"a.pdf\" (application/pdf) omitted: this model can't read it]")
        #expect(limited[2]["text"] == "<document name=\"notes.md\">\n# Notes\n</document>")
        #expect(limited[3]["text"] == "Summarize")
    }

    @Test func cacheBreakpointsOnSystemAndNewestUserTurn() throws {
        let transcript: [Message] = [.user("first"), Message(role: .assistant, parts: [.text("answer")]), .user("second")]
        let body = try bodyJSON(provider(), request(transcript))
        #expect(body.count(key: "cache_control") == 2)
        #expect(body["system"]?[0]?["cache_control"] == ["type": "ephemeral"])
        #expect(body["messages"]?[2]?["content"]?[0]?["cache_control"] == ["type": "ephemeral"])
        #expect(body["messages"]?[0]?["content"]?[0]?["cache_control"] == nil)

        let plain = try bodyJSON(provider(.conservative), request(transcript))
        #expect(plain.count(key: "cache_control") == 0)
        #expect(plain["system"] == [["type": "text", "text": "You are helpful."]])
    }

    @Test func consecutiveSameRoleMessagesMerge() throws {
        let a1 = Message(role: .assistant, parts: [.text("part one")],
                         raw: ProviderPayload(flavor: .anthropicMessages, data: Data(#"[{"type":"text","text":"part one"}]"#.utf8)))
        let a2 = Message(role: .assistant, parts: [.text("part two")],
                         raw: ProviderPayload(flavor: .anthropicMessages, data: Data(#"[{"type":"text","text":"part two"}]"#.utf8)))
        let repair = Message(role: .user, parts: [.toolResult(ToolResult(callID: "t", toolName: "x", content: [.text("Cancelled")], isError: true))])
        let body = try bodyJSON(provider(.conservative), request([.user("q"), a1, a2, repair, .user("next"), .user("")]))
        let messages = try #require(body["messages"]?.arrayValue)
        #expect(messages.map { $0["role"]?.stringValue } == ["user", "assistant", "user"])
        #expect(messages[1]["content"]?.arrayValue?.count == 2)
        #expect(messages[2]["content"]?.arrayValue?.map { $0["type"]?.stringValue } == ["tool_result", "text"])
    }

    @Test func effortThinkingAndServerToolsAreCapabilityGated() throws {
        let r = request([.user("hi")], tools: [weatherTool], effort: .max, webSearch: true)
        let body = try bodyJSON(provider(), r)
        #expect(body["thinking"] == ["type": "adaptive", "display": "summarized"])
        #expect(body["output_config"] == ["effort": "max"])
        #expect(body["max_tokens"] == 4096)
        #expect(body["stream"] == true)
        let tools = try #require(body["tools"]?.arrayValue)
        #expect(tools.count == 3)
        #expect(tools[0] == ["name": "get_weather", "description": "Weather for a city", "input_schema": weatherTool.inputSchema,
                             "eager_input_streaming": true])
        #expect(tools[1] == ["type": "web_search_20260209", "name": "web_search"])
        #expect(tools[2] == ["type": "web_fetch_20260209", "name": "web_fetch"])

        let custom = try bodyJSON(provider(ProviderPreset.customAnthropic.defaultCapabilities, options: AnthropicOptions()), r)
        #expect(custom["thinking"] == nil)
        #expect(custom["output_config"] == nil)
        #expect(custom["tools"]?.arrayValue?.count == 1)
        #expect(custom["tools"]?[0]?["eager_input_streaming"] == nil)
    }

    @Test func headersAndURL() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.sse("anthropic_refusal.sse")])
        var endpoint = anthropicEndpoint(options: AnthropicOptions(betas: ["context-management-2025-06-27", "other-beta"]))
        endpoint.extraHeaders = ["X-Trace": "1", "Anthropic-Version": "2099-01-01"]
        _ = try await collect(AnthropicProvider(endpoint: endpoint, transport: transport).stream(request([.user("hi")])))
        let sent = try #require(transport.requests.first)
        #expect(sent.method == "POST")
        #expect(sent.url?.absoluteString == "https://api.anthropic.com/v1/messages")
        let h = Dictionary(uniqueKeysWithValues: sent.headers.map { ($0.key.lowercased(), $0.value) })
        #expect(h["x-api-key"] == testKey)
        #expect(h["authorization"] == nil)
        #expect(h["anthropic-version"] == "2099-01-01") // user override wins
        #expect(h["anthropic-beta"] == "context-management-2025-06-27,other-beta")
        #expect(h["content-type"] == "application/json")
        #expect(h["x-trace"] == "1")
    }

    @Test func bearerAuthAndKeylessServers() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.sse("anthropic_refusal.sse"), try Fixture.sse("anthropic_refusal.sse")])
        let openRouter = try #require(ProviderPreset.openRouterAnthropic.endpoint(apiKey: testKey))
        _ = try await collect(AnthropicProvider(endpoint: openRouter, transport: transport).stream(request([.user("hi")])))
        var local = try #require(ProviderPreset.customAnthropic.endpoint(baseURL: URL(string: "http://10.0.0.2:8080")))
        local.apiKey = ""
        _ = try await collect(AnthropicProvider(endpoint: local, transport: transport).stream(request([.user("hi")])))

        let first = Dictionary(uniqueKeysWithValues: transport.requests[0].headers.map { ($0.key.lowercased(), $0.value) })
        #expect(transport.requests[0].url?.absoluteString == "https://openrouter.ai/api/v1/messages")
        #expect(first["authorization"] == "Bearer \(testKey)")
        #expect(first["x-api-key"] == nil)
        let second = Dictionary(uniqueKeysWithValues: transport.requests[1].headers.map { ($0.key.lowercased(), $0.value) })
        #expect(transport.requests[1].url?.absoluteString == "http://10.0.0.2:8080/v1/messages")
        #expect(second["authorization"] == nil && second["x-api-key"] == nil)
    }
}
