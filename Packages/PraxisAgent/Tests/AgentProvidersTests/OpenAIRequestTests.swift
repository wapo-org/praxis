import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentProviders

@Suite struct OpenAIRequestTests {
    let png = MediaData(mediaType: "image/png", data: Data([0x89, 0x50, 0x4E, 0x47]), name: "chart.png")

    private func provider(_ caps: Capabilities? = nil, options: OpenAIOptions? = nil) -> OpenAIChatProvider {
        OpenAIChatProvider(endpoint: openAIEndpoint(caps, options: options), transport: ScriptedTransport(replies: []))
    }

    @Test func bodyShapeFollowsOptionsAndCapabilities() throws {
        let r = request([.user("hi")], tools: [weatherTool], effort: .max, maxTokens: 2048)
        let body = try bodyJSON(provider(), r)
        #expect(body["stream"] == true)
        #expect(body["stream_options"] == ["include_usage": true])
        #expect(body["max_completion_tokens"] == 2048)
        #expect(body["max_tokens"] == nil)
        #expect(body["reasoning_effort"] == "high") // max → high
        #expect(body["messages"] == [["role": "system", "content": "You are helpful."], ["role": "user", "content": "hi"]])
        #expect(body["tools"] == [["type": "function", "function": [
            "name": "get_weather", "description": "Weather for a city", "parameters": weatherTool.inputSchema]]])

        let local = try bodyJSON(provider(.conservative, options: OpenAIOptions(systemRole: "developer", maxEffortValue: "xhigh")), r)
        #expect(local["stream_options"] == nil)
        #expect(local["max_tokens"] == 2048)
        #expect(local["reasoning_effort"] == nil)
        #expect(local["messages"]?[0]?["role"] == "developer")

        var caps = ProviderPreset.openAI.defaultCapabilities
        caps.tools = false
        let noTools = try bodyJSON(provider(caps, options: OpenAIOptions(maxTokensField: .omit, maxEffortValue: "xhigh")), r)
        #expect(noTools["tools"] == nil)
        #expect(noTools["max_tokens"] == nil && noTools["max_completion_tokens"] == nil)
        #expect(noTools["reasoning_effort"] == "xhigh")
    }

    @Test func rawReplayIsByteStableAndReasoningIsOptional() async throws {
        let (_, response) = try await streamFixture("openai_reasoning_content.sse", flavor: .openAIChat)
        let assistant = try #require(response).message
        let r = request([.user("Which is larger, 9.11 or 9.9?"), assistant, .user("Why?")])

        let p = provider()
        #expect(p.requestBody(r) == p.requestBody(r))
        let replayed = try #require(try bodyJSON(p, r)["messages"]?[2])
        #expect(replayed == ["role": "assistant", "content": "9.9 is larger.",
                             "reasoning_content": "9.11 vs 9.9: compare tenths. 9 > 1, so 9.9 is larger."])

        let stripped = try #require(try bodyJSON(provider(options: OpenAIOptions(replayReasoning: false)), r)["messages"]?[2])
        #expect(stripped == ["role": "assistant", "content": "9.9 is larger."])
    }

    @Test func anthropicAssistantIsRebuiltForOpenAI() async throws {
        let (_, response) = try await streamFixture("anthropic_text_thinking_tool.sse", flavor: .anthropicMessages)
        let assistant = try #require(response).message
        let results = Message(role: .user, parts: [.toolResult(ToolResult(callID: "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
                                                                          toolName: "get_weather", content: [.text("18°C")]))])
        let messages = try #require(try bodyJSON(provider(), request([.user("Weather?"), assistant, results]))["messages"]?.arrayValue)
        #expect(messages.count == 4)
        #expect(messages[2] == ["role": "assistant", "content": "Let me check the weather in Paris — ☀️ or 🌧️?", "tool_calls": [
            ["id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6", "type": "function",
             "function": ["name": "get_weather", "arguments": #"{"location": "Paris", "unit": "c"}"#]],
        ]])
        #expect(messages[3] == ["role": "tool", "tool_call_id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6", "content": "18°C"])
    }

    @Test func toolResultsBecomeToolMessagesWithImageFollowUp() throws {
        let assistant = Message(role: .assistant, parts: [
            .toolCall(ToolCall(id: "a", name: "shot", arguments: "{}")),
            .toolCall(ToolCall(id: "b", name: "fail", arguments: "")),
        ])
        let results = Message(role: .user, parts: [
            .toolResult(ToolResult(callID: "a", toolName: "shot", content: [.text("Captured"), .image(png)])),
            .toolResult(ToolResult(callID: "b", toolName: "fail", content: [.text("boom")], isError: true)),
        ])
        let messages = try #require(try bodyJSON(provider(), request([.user("go"), assistant, results]))["messages"]?.arrayValue)
        #expect(messages.count == 6)
        #expect(messages[2] == ["role": "assistant", "content": .null, "tool_calls": [
            ["id": "a", "type": "function", "function": ["name": "shot", "arguments": "{}"]],
            ["id": "b", "type": "function", "function": ["name": "fail", "arguments": "{}"]],
        ]])
        #expect(messages[3] == ["role": "tool", "tool_call_id": "a", "content": "Captured\n[image \"chart.png\" attached in the next message]"])
        #expect(messages[4] == ["role": "tool", "tool_call_id": "b", "content": "Error: boom"])
        #expect(messages[5] == ["role": "user", "content": [["type": "image_url", "image_url": ["url": "data:image/png;base64,iVBORw=="]]]])

        let blind = try #require(try bodyJSON(provider(.conservative), request([.user("go"), assistant, results]))["messages"]?.arrayValue)
        #expect(blind.count == 5)
        #expect(blind[3]["content"] == "Captured\n[Image img_0f4636c78f65 “chart.png” (image/png, 4 B) — the user attached this image, but the current model can't view images and this conversation has no image-reading tool. If its content matters, ask the user to describe it.]")
    }

    @Test func notesUseSystemMessagesOnlyWhenSupported() throws {
        let user = Message(role: .user, parts: [.note("Current mode: plan."), .text("Draft a plan")])
        let native = try #require(try bodyJSON(provider(), request([user]))["messages"]?.arrayValue)
        #expect(Array(native.dropFirst()) == [["role": "system", "content": "Current mode: plan."], ["role": "user", "content": "Draft a plan"]])

        let tagged = try #require(try bodyJSON(provider(.conservative), request([user]))["messages"]?.arrayValue)
        #expect(Array(tagged.dropFirst()) == [["role": "user",
                                               "content": "<system-reminder>\nCurrent mode: plan.\n</system-reminder>\n\nDraft a plan"]])
    }

    @Test func userImagesNeedVision() throws {
        let user = Message(role: .user, parts: [.text("What's this?"), .image(png)])
        let vision = try bodyJSON(provider(), request([user]))["messages"]?[1]
        #expect(vision == ["role": "user", "content": [
            ["type": "text", "text": "What's this?"],
            ["type": "image_url", "image_url": ["url": "data:image/png;base64,iVBORw=="]],
        ]])
        let blind = try bodyJSON(provider(.conservative), request([user]))["messages"]?[1]
        #expect(blind == ["role": "user", "content": "What's this?\n\n[Image img_0f4636c78f65 “chart.png” (image/png, 4 B) — the user attached this image, but the current model can't view images and this conversation has no image-reading tool. If its content matters, ask the user to describe it.]"])
    }

    @Test func consecutiveUserMessagesMerge() throws {
        let body = try bodyJSON(provider(.conservative), request([.user("one"), .user("two"), Message(role: .user, parts: [.image(png)])]))
        let messages = try #require(body["messages"]?.arrayValue)
        #expect(messages.count == 2)
        #expect(messages[1]["content"] == "one\n\ntwo\n\n[Image img_0f4636c78f65 “chart.png” (image/png, 4 B) — the user attached this image, but the current model can't view images and this conversation has no image-reading tool. If its content matters, ask the user to describe it.]")
    }

    @Test func headersAndURL() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.sse("openai_text.sse"), try Fixture.sse("openai_text.sse")])
        var endpoint = openAIEndpoint()
        endpoint.extraHeaders = ["HTTP-Referer": "https://praxis.example", "X-Title": "Praxis"]
        _ = try await collect(OpenAIChatProvider(endpoint: endpoint, transport: transport).stream(request([.user("hi")])))
        var local = try #require(ProviderPreset.customOpenAI.endpoint(baseURL: URL(string: "http://192.168.1.5:1234/v1/")))
        local.apiKey = ""
        _ = try await collect(OpenAIChatProvider(endpoint: local, transport: transport).stream(request([.user("hi")])))

        let h0 = Dictionary(uniqueKeysWithValues: transport.requests[0].headers.map { ($0.key.lowercased(), $0.value) })
        #expect(transport.requests[0].url?.absoluteString == "https://api.openai.com/v1/chat/completions")
        #expect(h0["authorization"] == "Bearer \(testKey)")
        #expect(h0["http-referer"] == "https://praxis.example")
        #expect(h0["content-type"] == "application/json")
        let h1 = Dictionary(uniqueKeysWithValues: transport.requests[1].headers.map { ($0.key.lowercased(), $0.value) })
        #expect(transport.requests[1].url?.absoluteString == "http://192.168.1.5:1234/v1/chat/completions")
        #expect(h1["authorization"] == nil)
    }
}
