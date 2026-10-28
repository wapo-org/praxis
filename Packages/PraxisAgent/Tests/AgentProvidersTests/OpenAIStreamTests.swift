import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentProviders

@Suite struct OpenAIStreamTests {
    @Test(arguments: [1, 7, 100_000])
    func textWithUsageChunkAndDone(chunkSize: Int) async throws {
        let (events, response) = try await streamFixture("openai_text.sse", flavor: .openAIChat, chunkSize: chunkSize)
        let r = try #require(response)
        #expect(texts(events, index: 1) == "Hello, world! ✨")
        #expect(r.stopReason == .endTurn)
        #expect(r.usage == Usage(inputTokens: 15, outputTokens: 7, cacheReadTokens: 10))
        #expect(r.message.parts == [.text("Hello, world! ✨")])
        let raw = try JSONValue(parsing: try #require(r.message.raw).data)
        #expect(raw == ["role": "assistant", "content": "Hello, world! ✨"])
        #expect(events.map(describe).suffix(2) == ["end[1]", "completed"])
    }

    @Test func parallelToolCallFragmentsByIndex() async throws {
        let (events, response) = try await streamFixture("openai_parallel_tools.sse", flavor: .openAIChat)
        let r = try #require(response)
        let described = events.map(describe)
        #expect(described.contains("tool[2] call_Ab12 get_weather"))
        #expect(described.contains("tool[3] call_Cd34 get_time"))
        #expect(arguments(events, index: 2) == #"{"location": "Paris"}"#)
        #expect(arguments(events, index: 3) == #"{"tz": "Europe/Paris"}"#)
        #expect(r.stopReason == .toolUse)
        #expect(r.message.toolCalls == [
            ToolCall(id: "call_Ab12", name: "get_weather", arguments: #"{"location": "Paris"}"#),
            ToolCall(id: "call_Cd34", name: "get_time", arguments: #"{"tz": "Europe/Paris"}"#),
        ])
        #expect(r.usage == Usage(inputTokens: 140, outputTokens: 38))
        let raw = try JSONValue(parsing: try #require(r.message.raw).data)
        #expect(raw["content"] == .null)
        #expect(raw["tool_calls"]?[1]?["function"]?["arguments"] == #"{"tz": "Europe/Paris"}"#)
    }

    @Test func reasoningContentStreamsAsItsOwnBlock() async throws {
        let (events, response) = try await streamFixture("openai_reasoning_content.sse", flavor: .openAIChat)
        let r = try #require(response)
        let described = events.map(describe).filter { $0 != "usage" }
        #expect(described == [
            "reasoning[0] 9.11 vs 9.9: compare tenths. ",
            "reasoning[0] 9 > 1, so 9.9 is larger.",
            "end[0]",
            "text[1] 9.9 is larger.",
            "end[1]",
            "completed",
        ])
        #expect(r.message.parts == [.reasoning(Reasoning(text: "9.11 vs 9.9: compare tenths. 9 > 1, so 9.9 is larger.")), .text("9.9 is larger.")])
        #expect(r.usage == Usage(inputTokens: 18, outputTokens: 60)) // usage inside the last choice chunk
        let raw = try JSONValue(parsing: try #require(r.message.raw).data)
        #expect(raw["reasoning_content"] == "9.11 vs 9.9: compare tenths. 9 > 1, so 9.9 is larger.")
    }

    @Test func missingIndexAndIdQuirks() async throws {
        // No `index`, id only on the first call, arguments as an object, `stop`
        // alongside tool calls, and no `[DONE]`.
        let (events, response) = try await streamFixture("openai_missing_index.sse", flavor: .openAIChat)
        let r = try #require(response)
        let calls = r.message.toolCalls
        #expect(calls.count == 2)
        #expect(calls[0] == ToolCall(id: "call_q1", name: "search", arguments: #"{"q":"cats"}"#))
        #expect(calls[1].id.hasPrefix("call_") && calls[1].id != "call_q1")
        #expect(calls[1].arguments == #"{"q":"dogs"}"#)
        #expect(r.stopReason == .toolUse)
        let starts = events.compactMap { if case .toolCallStarted(let i, _, _) = $0 { return i }; return nil }
        #expect(starts == [2, 3])
    }

    @Test func reusedIndexWithNewIdStartsANewCall() async throws {
        let sse = """
        data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"a","arguments":"{}"}}]}}]}

        data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_2","type":"function","function":{"name":"b","arguments":"{}"}}]}}]}

        data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

        data: [DONE]


        """
        let transport = ScriptedTransport(replies: [.sse(sse)])
        let events = try await collect(OpenAIChatProvider(endpoint: openAIEndpoint(), transport: transport).stream(request([.user("hi")])))
        #expect(completed(events)?.message.toolCalls.map(\.id) == ["call_1", "call_2"])
    }

    @Test func interleavedFragmentsOnAReusedIndexKeepTheirCalls() async throws {
        let sse = """
        data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_A","type":"function","function":{"name":"a","arguments":"{\\"p\\":"}}]}}]}

        data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_B","type":"function","function":{"name":"b","arguments":"{}"}}]}}]}

        data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_A","function":{"arguments":"1}"}}]}}]}

        data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

        data: [DONE]


        """
        let transport = ScriptedTransport(replies: [.sse(sse)])
        let events = try await collect(OpenAIChatProvider(endpoint: openAIEndpoint(), transport: transport).stream(request([.user("hi")])))
        #expect(completed(events)?.message.toolCalls == [
            ToolCall(id: "call_A", name: "a", arguments: #"{"p":1}"#),
            ToolCall(id: "call_B", name: "b", arguments: "{}"),
        ])
    }

    @Test func openRouterReasoningFieldIsReadAndReplayedUnderItsName() async throws {
        let sse = """
        data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning":"Thinking..."}}]}

        data: {"choices":[{"index":0,"delta":{"content":"Answer","reasoning":null}}]}

        data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

        data: [DONE]


        """
        let transport = ScriptedTransport(replies: [.sse(sse)])
        let events = try await collect(OpenAIChatProvider(endpoint: openAIEndpoint(), transport: transport).stream(request([.user("hi")])))
        let r = try #require(completed(events))
        #expect(reasoning(events) == "Thinking...")
        let raw = try JSONValue(parsing: try #require(r.message.raw).data)
        #expect(raw["reasoning"] == "Thinking...")
        #expect(raw["reasoning_content"] == nil)
    }

    @Test func namelessToolCallsWithNothingElseThrowInsteadOfCompletingEmpty() async throws {
        let sse = """
        data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]}}]}

        data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

        data: [DONE]


        """
        let transport = ScriptedTransport(replies: [.sse(sse)])
        let (_, error) = await collectUntilError(OpenAIChatProvider(endpoint: openAIEndpoint(), transport: transport).stream(request([.user("hi")])))
        let e = try #require(error as? ProviderError)
        #expect(e == .decoding("The server said it would call tools but never named one."))
        #expect(!e.isRetryable)
    }

    @Test func errorObjectInsideStreamThrows() async throws {
        let transport = ScriptedTransport(replies: [try Fixture.sse("openai_stream_error.sse")])
        let (events, error) = await collectUntilError(OpenAIChatProvider(endpoint: openAIEndpoint(), transport: transport).stream(request([.user("hi")])))
        #expect(texts(events) == "Partial")
        let e = try #require(error as? ProviderError)
        #expect(e == .stream(type: "server_error", message: "Upstream provider returned an error: overloaded"))
        #expect(e.isRetryable)
    }

    @Test func finishReasonMapping() async throws {
        func stop(_ reason: String) async throws -> StopReason? {
            let sse = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"x\"},\"finish_reason\":\"\(reason)\"}]}\n\n"
            let transport = ScriptedTransport(replies: [.sse(sse)])
            return completed(try await collect(OpenAIChatProvider(endpoint: openAIEndpoint(), transport: transport).stream(request([.user("hi")]))))?.stopReason
        }
        #expect(try await stop("stop") == .endTurn)
        #expect(try await stop("length") == .maxTokens)
        #expect(try await stop("content_filter") == .refusal(nil))
        #expect(try await stop("function_call") == .toolUse)
        #expect(try await stop("weird") == .other("weird"))
    }

    @Test func doneWithoutFinishReasonCompletesButACutBodyFails() async throws {
        let ok = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n"
        let cut = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}]}\n\n"
        let transport = ScriptedTransport(replies: [.sse(ok), .sse(cut), .sse("")])
        let provider = OpenAIChatProvider(endpoint: openAIEndpoint(), transport: transport)

        #expect(completed(try await collect(provider.stream(request([.user("a")]))))?.stopReason == .endTurn)
        let (_, e1) = await collectUntilError(provider.stream(request([.user("b")])))
        #expect(e1 as? ProviderError == .network("The response ended before it was complete."))
        let (_, e2) = await collectUntilError(provider.stream(request([.user("c")])))
        #expect(e2 as? ProviderError == .network("The server sent an empty response."))
    }
}
