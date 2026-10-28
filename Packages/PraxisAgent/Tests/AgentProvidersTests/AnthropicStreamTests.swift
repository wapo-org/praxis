import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentProviders

@Suite struct AnthropicStreamTests {
    @Test(arguments: [1, 7, 64, 100_000])
    func textThinkingAndToolUse(chunkSize: Int) async throws {
        let (events, response) = try await streamFixture("anthropic_text_thinking_tool.sse", flavor: .anthropicMessages, chunkSize: chunkSize)
        let r = try #require(response)

        #expect(reasoning(events) == "The user wants the weather in Paris. I should call get_weather.")
        #expect(texts(events, index: 1) == "Let me check the weather in Paris — ☀️ or 🌧️?")
        #expect(events.map(describe).contains("tool[2] toolu_01T1x1fJ34qAmk2tNTrN7Up6 get_weather"))
        #expect(arguments(events, index: 2) == #"{"location": "Paris", "unit": "c"}"#)
        #expect(events.map(describe).filter { $0.hasPrefix("end[") } == ["end[0]", "end[1]", "end[2]"])
        if case .completed = try #require(events.last) {} else { Issue.record("completed must be last") }

        #expect(r.stopReason == .toolUse)
        #expect(r.usage == Usage(inputTokens: 1204, outputTokens: 89, cacheReadTokens: 3400, cacheWriteTokens: 312))
        #expect(r.message.role == .assistant)
        #expect(r.message.parts == [
            .reasoning(Reasoning(text: "The user wants the weather in Paris. I should call get_weather.",
                                 signature: "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds+4Tq0Bzu/QR7r8aT9fmtYgQ8pWZ0n==")),
            .text("Let me check the weather in Paris — ☀️ or 🌧️?"),
            .toolCall(ToolCall(id: "toolu_01T1x1fJ34qAmk2tNTrN7Up6", name: "get_weather",
                               arguments: #"{"location": "Paris", "unit": "c"}"#)),
        ])

        // Raw is the non-streaming `content` array, every field kept.
        let raw = try #require(r.message.raw)
        #expect(raw.flavor == .anthropicMessages)
        let blocks = try #require(try JSONValue(parsing: raw.data).arrayValue)
        #expect(blocks.count == 3)
        #expect(blocks[0] == ["type": "thinking", "thinking": "The user wants the weather in Paris. I should call get_weather.",
                              "signature": "EqQBCgIYAhIM1gbcDa9GJwZA2b3hGgxBdjrkzLoky3dl1pkiMOYds+4Tq0Bzu/QR7r8aT9fmtYgQ8pWZ0n=="])
        #expect(blocks[1] == ["type": "text", "text": "Let me check the weather in Paris — ☀️ or 🌧️?"])
        #expect(blocks[2] == ["type": "tool_use", "id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6", "name": "get_weather",
                              "input": ["location": "Paris", "unit": "c"]])
    }

    @Test func toolUseWithoutIdGetsASynthesizedOne() async throws {
        let sse = """
        event: message_start
        data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":3,"output_tokens":1}}}

        event: content_block_start
        data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"get_weather"}}

        event: content_block_delta
        data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"location\\": \\"Paris\\"}"}}

        event: content_block_stop
        data: {"type":"content_block_stop","index":0}

        event: message_delta
        data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}

        event: message_stop
        data: {"type":"message_stop"}


        """
        let transport = ScriptedTransport(replies: [.sse(sse)])
        let events = try await collect(AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport).stream(request([.user("hi")])))
        let call = try #require(completed(events)?.message.toolCalls.first)
        #expect(!call.id.isEmpty)
        #expect(call.name == "get_weather")
        let started = try #require(events.compactMap { if case .toolCallStarted(_, let id, _) = $0 { return id }; return nil }.first)
        #expect(started == call.id)
    }

    @Test func crlfLineEndingsParseTheSame() async throws {
        let text = try Fixture.text("anthropic_text_thinking_tool.sse").replacingOccurrences(of: "\n", with: "\r\n")
        let transport = ScriptedTransport(replies: [.sse(text, chunkSize: 5)])
        let events = try await collect(AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport).stream(request([.user("hi")])))
        let r = try #require(completed(events))
        #expect(r.message.toolCalls.map(\.name) == ["get_weather"])
        #expect(r.message.text == "Let me check the weather in Paris — ☀️ or 🌧️?")
    }

    @Test func serverWebSearchBlocksSurviveVerbatim() async throws {
        let (events, response) = try await streamFixture("anthropic_web_search.sse", flavor: .anthropicMessages)
        let r = try #require(response)
        let described = events.map(describe)
        #expect(described.contains(#"server[0] srvtoolu_01WYG3ziw53XMcoyKL4XcZmE web_search {"query":"swift 6.2 release date"}"#))
        #expect(described.contains("serverDone[1] srvtoolu_01WYG3ziw53XMcoyKL4XcZmE 2 results false"))
        // Server tools are announced only once their input is complete.
        let started = try #require(described.firstIndex { $0.hasPrefix("server[0]") })
        let ended = try #require(described.firstIndex(of: "end[0]"))
        #expect(started < ended)
        #expect(texts(events) == "Swift 6.2 was released in September 2025.")
        #expect(r.stopReason == .endTurn)
        #expect(r.message.parts == [.text("Swift 6.2 was released in September 2025.")])

        let blocks = try rawBlocks(r.message)
        #expect(blocks.map { $0["type"]?.stringValue } == ["server_tool_use", "web_search_tool_result", "text"])
        #expect(blocks[0]["input"] == ["query": "swift 6.2 release date"])
        let results = try #require(blocks[1]["content"]?.arrayValue)
        #expect(results[0]["encrypted_content"]?.stringValue == "EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5LTQ1NGUtODgxNC1kNjNjNTk1ZWI3Y2MSDCSDgEAEi2uGKtkdbxoMMy1hKZJqnjOa+wJ/")
        #expect(results[1]["page_age"] == .null)
        let citations = try #require(blocks[2]["citations"]?.arrayValue)
        #expect(citations.count == 1)
        #expect(citations[0]["encrypted_index"]?.stringValue == "Eo8BCioIAhgBIiQ3YTAwMjY1Mi1mZjM5")
    }

    @Test func midStreamErrorThrowsRetryableStreamError() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.sse("anthropic_error_midstream.sse")])
        let provider = AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport)
        let (events, error) = await collectUntilError(provider.stream(request([.user("hi")])))
        #expect(texts(events) == "Here is the first part")
        let e = try #require(error as? ProviderError)
        #expect(e == .stream(type: "overloaded_error", message: "Overloaded"))
        #expect(e.isRetryable)
        #expect(completed(events) == nil)
    }

    @Test func refusalCarriesCategory() async throws {
        let (_, response) = try await streamFixture("anthropic_refusal.sse", flavor: .anthropicMessages)
        #expect(response?.stopReason == .refusal("cyber"))
    }

    @Test func pauseTurnKeepsServerOnlyContentReplayable() async throws {
        let (events, response) = try await streamFixture("anthropic_pause_turn.sse", flavor: .anthropicMessages)
        let r = try #require(response)
        #expect(r.stopReason == .pauseTurn)
        #expect(events.map(describe).contains("serverDone[1] srvtoolu_01Pause Fetched Swift.org - Blog false"))
        // The loop drops part-less messages; the turn must still be committed and replayed.
        #expect(!r.message.parts.isEmpty)
        let blocks = try rawBlocks(r.message)
        #expect(blocks.map { $0["type"]?.stringValue } == ["server_tool_use", "web_fetch_tool_result"])
    }

    @Test func truncatedStreamIsANetworkError() async throws {
        let full = try Fixture.text("anthropic_text_thinking_tool.sse")
        let cut = String(full[..<full.range(of: "event: message_delta")!.lowerBound])
        let transport = ScriptedTransport(replies: [.sse(cut)])
        let (_, error) = await collectUntilError(AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport).stream(request([.user("hi")])))
        let e = try #require(error as? ProviderError)
        #expect(e == .network("The response ended before it was complete."))
        #expect(e.isRetryable)
    }

    @Test func missingMessageStopAfterStopReasonStillCompletes() async throws {
        let full = try Fixture.text("anthropic_refusal.sse")
        let cut = String(full[..<full.range(of: "event: message_stop")!.lowerBound])
        let transport = ScriptedTransport(replies: [.sse(cut)])
        let events = try await collect(AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport).stream(request([.user("hi")])))
        #expect(completed(events)?.stopReason == .refusal("cyber"))
    }

    @Test func stopReasonMapping() {
        #expect(AnthropicStreamAccumulator.stopReason("end_turn", category: nil) == .endTurn)
        #expect(AnthropicStreamAccumulator.stopReason("stop_sequence", category: nil) == .endTurn)
        #expect(AnthropicStreamAccumulator.stopReason("max_tokens", category: nil) == .maxTokens)
        #expect(AnthropicStreamAccumulator.stopReason("model_context_window_exceeded", category: nil) == .contextWindowExceeded)
        #expect(AnthropicStreamAccumulator.stopReason("refusal", category: nil) == .refusal(nil))
        #expect(AnthropicStreamAccumulator.stopReason("compaction", category: nil) == .other("compaction"))
    }

    @Test func serverToolErrorResultIsReportedAsError() {
        let (summary, isError) = AnthropicStreamAccumulator.summarize([
            "type": "web_search_tool_result", "tool_use_id": "srvtoolu_1",
            "content": ["type": "web_search_tool_result_error", "error_code": "max_uses_exceeded"],
        ])
        #expect(summary == "Search failed (max_uses_exceeded)")
        #expect(isError)
    }
}
