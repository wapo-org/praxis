import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentProviders

/// `AgentLoop` + a real adapter + `ScriptedTransport`: the full wire round
/// trip for a tool call, per flavor.
@Suite struct EndToEndTests {
    private let noSleep: @Sendable (Duration) async throws -> Void = { _ in }

    private func config() -> AgentRunConfiguration {
        AgentRunConfiguration(conversationID: "c1", model: "test-model", system: "sys", mode: .auto, effort: .low)
    }

    private func outcome(_ events: [AgentEvent]) -> RunOutcome? {
        if case .finished(let o) = events.last { return o }
        return nil
    }

    private func committed(_ events: [AgentEvent]) -> [Message] {
        events.flatMap { if case .committed(let m) = $0 { return m }; return [] }
    }

    private let weather = ClosureTool(name: "get_weather", schema: weatherTool.inputSchema) { inv, _ in
        .text("18°C in \(inv.arguments["location"]?.stringValue ?? "?")")
    }
    private let time = ClosureTool(name: "get_time") { inv, _ in .text("09:00 \(inv.arguments["tz"]?.stringValue ?? "")") }

    @Test func anthropicToolRoundTrip() async throws {
        let transport = ScriptedTransport(replies: [
            try Fixture.sse("anthropic_text_thinking_tool.sse"),
            .sse("""
            event: message_start
            data: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1400,"output_tokens":1}}}

            event: content_block_start
            data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

            event: content_block_delta
            data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"It's 18°C in Paris."}}

            event: content_block_stop
            data: {"type":"content_block_stop","index":0}

            event: message_delta
            data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}

            event: message_stop
            data: {"type":"message_stop"}


            """),
        ])
        // Real sleep: the loop also uses `sleep` for tool timeouts.
        let loop = AgentLoop(provider: AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport),
                             tools: ToolRegistry([weather]))
        let events = await loop.run(transcript: [.user("Weather in Paris?")], configuration: config()).collect()

        #expect(outcome(events) == .completed)
        let messages = committed(events)
        #expect(messages.count == 3)
        #expect(messages.last?.text == "It's 18°C in Paris.")

        let second = try #require(sentBody(transport, 1))
        let wire = try #require(second["messages"]?.arrayValue)
        #expect(wire.map { $0["role"]?.stringValue } == ["user", "assistant", "user"])
        #expect(wire[1]["content"]?[0]?["type"] == "thinking") // replayed with its signature
        #expect(wire[1]["content"]?[0]?["signature"]?.stringValue?.isEmpty == false)
        #expect(wire[2]["content"]?[0]?["type"] == "tool_result")
        #expect(wire[2]["content"]?[0]?["tool_use_id"] == "toolu_01T1x1fJ34qAmk2tNTrN7Up6")
        #expect(wire[2]["content"]?[0]?["content"]?[0]?["text"] == "18°C in Paris")
        #expect(second["output_config"] == ["effort": "low"])
    }

    @Test func openAIParallelToolRoundTrip() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.sse("openai_parallel_tools.sse"), try Fixture.sse("openai_text.sse")])
        let loop = AgentLoop(provider: OpenAIChatProvider(endpoint: openAIEndpoint(), transport: transport),
                             tools: ToolRegistry([weather, time]))
        let events = await loop.run(transcript: [.user("Weather and time in Paris?")], configuration: config()).collect()

        #expect(outcome(events) == .completed)
        #expect(committed(events).last?.text == "Hello, world! ✨")
        let wire = try #require(sentBody(transport, 1)?["messages"]?.arrayValue)
        #expect(wire.map { $0["role"]?.stringValue } == ["system", "user", "assistant", "tool", "tool"])
        #expect(wire[2]["tool_calls"]?.arrayValue?.count == 2)
        #expect(wire[3] == ["role": "tool", "tool_call_id": "call_Ab12", "content": "18°C in Paris"])
        #expect(wire[4] == ["role": "tool", "tool_call_id": "call_Cd34", "content": "09:00 Europe/Paris"])
        #expect(sentBody(transport, 1)?["tools"]?.arrayValue?.map { $0["function"]?["name"]?.stringValue } == ["get_time", "get_weather"])
    }

    @Test func midStreamOverloadIsRetriedByTheLoop() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.sse("anthropic_error_midstream.sse"), try Fixture.sse("anthropic_refusal.sse")])
        let loop = AgentLoop(provider: AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport), tools: .empty, sleep: noSleep)
        let events = await loop.run(transcript: [.user("hi")], configuration: config()).collect()
        #expect(events.contains { if case .retrying(1, _, _) = $0 { return true }; return false })
        #expect(events.contains { if case .attemptDiscarded = $0 { return true }; return false })
        #expect(outcome(events) == .refused("cyber"))
        #expect(transport.requests.count == 2)
    }

    @Test func pauseTurnContinuesWithTheAssistantTurnLast() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.sse("anthropic_pause_turn.sse"), try Fixture.sse("anthropic_web_search.sse")])
        let loop = AgentLoop(provider: AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport), tools: .empty, sleep: noSleep)
        var c = config()
        c.serverWebSearch = true
        let events = await loop.run(transcript: [.user("Latest Swift news?")], configuration: c).collect()
        #expect(outcome(events) == .completed)
        let second = try #require(sentBody(transport, 1))
        let wire = try #require(second["messages"]?.arrayValue)
        #expect(wire.map { $0["role"]?.stringValue } == ["user", "assistant"])
        #expect(wire[1]["content"]?.arrayValue?.map { $0["type"]?.stringValue } == ["server_tool_use", "web_fetch_tool_result"])
        #expect(second["tools"]?.arrayValue?.map { $0["name"]?.stringValue } == ["web_search", "web_fetch"])
    }
}
