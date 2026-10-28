import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentProviders

/// Per-model reasoning effort: list parsing, name mapping, wire clamping,
/// rejection matching and request bodies. Provider shapes verified against
/// the real docs 2026-10-28 (OpenRouter reasoning-tokens guide, OpenAI
/// reasoning guide + models reference, Anthropic models-list + messages
/// references, LM Studio native list-models docs).
@Suite struct EffortLevelsTests {
    private func json(_ text: String) throws -> JSONValue { try JSONValue(parsing: Data(text.utf8)) }
    private func openAI(_ def: [String] = EffortLevels.openAIFamilyDefault) -> [String] { def }

    // MARK: Parsing — OpenRouter shapes

    @Test func openRouterSupportedEffortsAreParsedVerbatim() throws {
        let m = try json(#"{"id":"openai/gpt-5.2","reasoning":{"supported_efforts":["high","medium","low","minimal"],"default_effort":"medium","mandatory":false}}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: openAI()) == ["high", "medium", "low", "minimal"])
    }

    @Test func openRouterNullSupportedEffortsMeansAllGatewayValues() throws {
        let m = try json(#"{"id":"x/y","reasoning":{"supported_efforts":null}}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: openAI()) == EffortLevels.openRouterGatewayAll)
    }

    @Test func openRouterReasoningKeysWithoutLevelsGetTheFamilyDefault() throws {
        let m = try json(#"{"id":"x/y","supported_parameters":["max_tokens","reasoning","tools"]}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: openAI()) == ["low", "medium", "high"])
    }

    @Test func openRouterReasoningObjectWithoutLevelsGetsTheFamilyDefault() throws {
        let m = try json(#"{"id":"x/y","reasoning":{"default_enabled":true,"mandatory":true}}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: openAI()) == ["low", "medium", "high"])
    }

    @Test func openRouterParameterListWithoutReasoningRulesItOut() throws {
        let m = try json(#"{"id":"x/y","supported_parameters":["max_tokens","tools","response_format"]}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: openAI()) == [])
    }

    @Test func openRouterEmptyParameterListStatesNothing() throws {
        let m = try json(#"{"id":"openrouter/auto","supported_parameters":[]}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: openAI()) == nil)
    }

    @Test func openAIDirectEntriesAreUnknown() throws {
        let m = try json(#"{"id":"gpt-5.2","object":"model","created":1761000000,"owned_by":"system"}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: openAI()) == nil)
    }

    // MARK: Parsing — Anthropic / local shapes

    @Test func anthropicPerLevelFlagsAreParsed() throws {
        let m = try json(#"""
            {"id":"claude-opus-5-5","capabilities":{"effort":{
            "supported":true,
            "low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},
            "xhigh":{"supported":true},"max":{"supported":false}}}}
            """#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: EffortLevels.anthropicFamilyDefault)
            == ["low", "medium", "high", "xhigh"])
    }

    @Test func anthropicEffortSupportedFalseRulesItOut() throws {
        let m = try json(#"{"id":"claude-haiku-4-5","capabilities":{"effort":{"supported":false}}}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: EffortLevels.anthropicFamilyDefault) == [])
    }

    @Test func anthropicSupportedWithoutFlagsGetsTheFamilyDefault() throws {
        let m = try json(#"{"id":"claude-old","capabilities":{"effort":{"supported":true}}}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: EffortLevels.anthropicFamilyDefault)
            == ["low", "medium", "high"])
    }

    @Test func anthropicThinkingWithoutEffortGetsTheFamilyDefault() throws {
        let m = try json(#"{"id":"claude-old","capabilities":{"thinking":{"supported":true}}}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: EffortLevels.anthropicFamilyDefault)
            == ["low", "medium", "high"])
    }

    @Test func lmStudioAllowedOptionsAreParsed() throws {
        let m = try json(#"{"key":"qwen3","capabilities":{"vision":false,"trained_for_tool_use":true,"reasoning":{"allowed_options":["off","on"],"default":"on"}}}"#)
        #expect(HTTPSupport.reasoningEfforts(in: m, defaultLevels: openAI()) == ["off", "on"])
    }

    @Test func capabilityNameListsAreAuthoritative() throws {
        let thinking = try json(#"{"name":"qwen3:8b","capabilities":["completion","tools","thinking"]}"#)
        #expect(HTTPSupport.reasoningEfforts(in: thinking, defaultLevels: openAI()) == ["low", "medium", "high"])
        let plain = try json(#"{"name":"llama3:8b","capabilities":["completion"]}"#)
        #expect(HTTPSupport.reasoningEfforts(in: plain, defaultLevels: openAI()) == [])
    }

    // MARK: listModels carries the levels

    @Test func openAIListModelsParsesReasoningShapes() async throws {
        let body = #"{"object":"list","data":[{"id":"gpt-5.2","created":1,"owned_by":"system"}, {"id":"o/reasoner","name":"Reasoner","supported_parameters":["tools","reasoning"],"reasoning":{"supported_efforts":["high","medium","low"]}}, {"id":"o/plain","name":"Plain","supported_parameters":["tools"]}]}"#
        let provider = OpenAIChatProvider(endpoint: openAIEndpoint(), transport: ScriptedTransport(replies: [.json(body)]))
        let models = try await provider.listModels()
        #expect(models.count == 3)
        #expect(models[0].reasoningEfforts == nil)
        #expect(models[1].reasoningEfforts == ["high", "medium", "low"])
        #expect(models[2].reasoningEfforts == [])
    }

    @Test func anthropicListModelsParsesEffortFlags() async throws {
        let body = #"{"data":[{"type":"model","id":"claude-x","capabilities":{"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true}}}}],"has_more":false}"#
        let provider = AnthropicProvider(endpoint: anthropicEndpoint(), transport: ScriptedTransport(replies: [.json(body)]))
        let models = try await provider.listModels()
        #expect(models.count == 1)
        #expect(models[0].reasoningEfforts == ["low", "medium", "high"])
    }

    // MARK: Mapping provider names onto the app's Effort

    @Test func mappingFoldsAndDedupesWeakestFirst() {
        #expect(EffortLevels.map(["low", "medium", "high"]) == [.low, .medium, .high])
        #expect(EffortLevels.map(["high", "medium", "low", "minimal"]) == [.low, .medium, .high]) // minimal → low
        #expect(EffortLevels.map(["max", "xhigh", "high", "medium", "low"]) == [.low, .medium, .high, .max]) // xhigh → max
        #expect(EffortLevels.map(["none"]) == [])
        #expect(EffortLevels.map(["off", "on"]) == [])
        #expect(EffortLevels.map(["LOW", "Medium"]) == [.low, .medium])
        #expect(EffortLevels.map(["nonsense"]) == [])
    }

    @Test func nearestPrefersCloserThenLower() {
        #expect(EffortLevels.nearest(to: .max, in: [.low, .medium, .high]) == .high)
        #expect(EffortLevels.nearest(to: .low, in: [.medium, .high]) == .medium)
        #expect(EffortLevels.nearest(to: .medium, in: [.low, .high]) == .low) // tie → lower
        #expect(EffortLevels.nearest(to: .high, in: [.low, .medium, .high, .max]) == .high)
        #expect(EffortLevels.nearest(to: .high, in: []) == nil)
    }

    // MARK: Wire clamping

    @Test func clampSendsOnlySupportedValues() {
        #expect(EffortLevels.clamp("high", to: nil) == "high") // unknown: unchanged
        #expect(EffortLevels.clamp("high", to: []) == nil) // none: drop
        #expect(EffortLevels.clamp("high", to: ["low", "medium", "high"]) == "high")
        #expect(EffortLevels.clamp("max", to: ["low", "medium", "high"]) == "high") // nearest below
        #expect(EffortLevels.clamp("high", to: ["xhigh", "max"]) == "xhigh") // nearest above
        #expect(EffortLevels.clamp("medium", to: ["low", "high"]) == "low") // tie → lower
        #expect(EffortLevels.clamp("HIGH", to: ["high"]) == "high") // case-insensitive
        #expect(EffortLevels.clamp("ultra", to: ["low", "high"]) == nil) // unranked custom: drop, don't risk a 400
    }

    @Test func narrowMovesOneEdgeOfTheRange() {
        // Rejected mid-range or high: the ceiling drops below it.
        #expect(EffortLevels.narrow(["low", "medium", "high", "xhigh", "max"], rejecting: "xhigh") == ["low", "medium", "high"])
        #expect(EffortLevels.narrow(EffortLevels.unknownBaseline, rejecting: "high") == ["minimal", "low", "medium"])
        // Rejected at/below the weakest known level: the floor rises above it.
        #expect(EffortLevels.narrow(["low", "medium", "high"], rejecting: "low") == ["medium", "high"])
        #expect(EffortLevels.narrow(["low", "medium", "high"], rejecting: "none") == ["low", "medium", "high"])
        #expect(EffortLevels.narrow(["medium", "high"], rejecting: "medium") == ["high"])
        // Unranked names only remove themselves; unranked levels are kept.
        #expect(EffortLevels.narrow(["low", "high"], rejecting: "weird") == ["low", "high"])
        #expect(EffortLevels.narrow(["on", "low", "high"], rejecting: "high") == ["on", "low"])
    }

    // MARK: Request bodies

    @Test func openAIBodyClampsAndDrops() throws {
        let provider = OpenAIChatProvider(endpoint: openAIEndpoint(), transport: ScriptedTransport(replies: []))
        var r = request([.user("hi")], effort: .max)
        r.supportedEffortValues = ["low", "medium", "high"]
        #expect(try bodyJSON(provider, r)["reasoning_effort"] == "high") // max→high option, listed
        r.supportedEffortValues = []
        #expect(try bodyJSON(provider, r)["reasoning_effort"] == nil) // no reasoning: dropped
        r.supportedEffortValues = nil
        #expect(try bodyJSON(provider, r)["reasoning_effort"] == "high") // unknown: unchanged
        r.supportedEffortValues = ["minimal", "low"]
        r.effort = .medium
        #expect(try bodyJSON(provider, r)["reasoning_effort"] == "low") // medium unlisted: nearest
    }

    @Test func anthropicBodyClampsAndDropsThinkingTogether() throws {
        let provider = AnthropicProvider(endpoint: anthropicEndpoint(), transport: ScriptedTransport(replies: []))
        var r = request([.user("hi")], effort: .max)
        r.supportedEffortValues = ["low", "medium", "high", "xhigh"]
        let clamped = try bodyJSON(provider, r)
        #expect(clamped["output_config"]?["effort"] == "xhigh") // max unlisted: nearest
        #expect(clamped["thinking"]?["type"] == "adaptive")
        r.supportedEffortValues = []
        let dropped = try bodyJSON(provider, r)
        #expect(dropped["output_config"] == nil && dropped["thinking"] == nil)
        r.supportedEffortValues = nil
        let unknown = try bodyJSON(provider, r)
        #expect(unknown["output_config"]?["effort"] == "max") // unknown: unchanged
    }

    // MARK: Rejection matching

    @Test func rejectionMatchingDistinguishesParameterFromValue() {
        #expect(EffortLevels.rejection(in: "Unrecognized request argument supplied: reasoning_effort") == .parameterUnsupported)
        #expect(EffortLevels.rejection(in: "Unsupported parameter: 'reasoning_effort'.") == .parameterUnsupported)
        #expect(EffortLevels.rejection(in: "adaptive thinking is not supported on this model") == .parameterUnsupported)
        #expect(EffortLevels.rejection(in: "'reasoning_effort' does not support 'none' with this model") == .valueUnsupported("none"))
        #expect(EffortLevels.rejection(in: "output_config.effort 'xhigh' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.") == .valueUnsupported("xhigh"))
        #expect(EffortLevels.rejection(in: "Model 'gpt-5-mini' does not support reasoning effort 'xhigh'. Supported: minimal, low, medium, high.") == .valueUnsupported("xhigh"))
        #expect(EffortLevels.rejection(in: #"reasoning_effort "ultra" is not supported by this model"#) == .valueUnsupported("ultra"))
        #expect(EffortLevels.rejection(in: "No endpoints found that support tool use") == nil)
        #expect(EffortLevels.rejection(in: "rate_limited: slow down") == nil)
        #expect(EffortLevels.rejection(in: "output_config.format.schema: Invalid JSON Schema in output format") == nil)
    }

    @Test func effortRejectionsAreNotRetryable() {
        let param = ProviderError.http(status: 400, message: "Unrecognized request argument supplied: reasoning_effort", retryAfter: nil)
        #expect(param.isEffortRejection && !param.isRetryable)
        let value = ProviderError.stream(type: "invalid_request_error", message: "output_config.effort 'max' is not supported on this model")
        #expect(value.isEffortRejection && !value.isRetryable)
        #expect(!ProviderError.http(status: 429, message: "slow down", retryAfter: nil).isEffortRejection)
    }
}
