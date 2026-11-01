import Foundation
import AgentCore

/// Chat Completions SSE → `ProviderEvent`s.
///
/// Event indices are synthesized so they're unique per response (the wire
/// numbers tool calls separately from text): reasoning `0`, text `1`,
/// tool call `i` → `2 + i`.
///
/// Absorbs the quirks of "compatible" servers: tool-call fragments without
/// `index` (sequential), ids only on the first fragment or missing entirely
/// (synthesized `call_<uuid>`), every call reusing index 0 with distinct
/// ids, `arguments` sent as an object, usage in its own final chunk or
/// inside the last choice chunk, error objects inside the stream, and
/// streams that end without `[DONE]`.
struct OpenAIStreamAccumulator: StreamAccumulator {
    static let reasoningIndex = 0
    static let textIndex = 1
    static func toolIndex(_ slot: Int) -> Int { 2 + slot }

    private struct Slot: Sendable {
        var id = ""
        var name = ""
        var arguments = ""
        var started = false
    }

    private var reasoning = ""
    /// Wire field the reasoning arrived in, so raw replay uses the same one.
    private var reasoningField = "reasoning_content"
    private var reasoningOpen = false
    private var reasoningClosed = false
    private var text = ""
    private var textOpen = false
    private var slots: [Slot] = []
    /// Wire `index` → slot.
    private var slotForIndex: [Int: Int] = [:]
    private var finishReason: String?
    private var usage = Usage()
    private var sawChunk = false
    private(set) var isDone = false

    mutating func consume(_ event: SSEEvent) throws -> [ProviderEvent] {
        let data = event.data.trimmingCharacters(in: .whitespaces)
        if data == "[DONE]" {
            isDone = true
            return []
        }
        guard let json = HTTPSupport.json(event) else { return [] }
        if let err = json["error"], !err.isNull, let details = HTTPSupport.errorDetails(json) {
            throw ProviderError.stream(type: details.type, message: details.message)
        }
        sawChunk = true
        var events: [ProviderEvent] = []
        if let u = json["usage"], case .object = u {
            usage = Self.usage(u)
            events.append(.usage(usage))
        }
        guard let choice = json["choices"]?[0] else { return events }
        if let delta = choice["delta"] {
            events += consumeDelta(delta)
        }
        if let reason = choice["finish_reason"]?.stringValue {
            if reason == "error" {
                throw ProviderError.stream(type: "server_error", message: "The model stopped with an error.")
            }
            finishReason = reason
        }
        return events
    }

    private mutating func consumeDelta(_ delta: JSONValue) -> [ProviderEvent] {
        var events: [ProviderEvent] = []
        for field in ["reasoning_content", "reasoning"] {
            guard let piece = delta[field]?.stringValue, !piece.isEmpty else { continue }
            reasoning += piece
            reasoningField = field
            // Reasoning that resumes after the answer started is kept for
            // replay but not re-opened in the UI.
            if !reasoningClosed {
                reasoningOpen = true
                events.append(.reasoningDelta(index: Self.reasoningIndex, text: piece))
            }
            break
        }
        if let piece = delta["content"]?.stringValue, !piece.isEmpty {
            events += closeReasoning()
            text += piece
            textOpen = true
            events.append(.textDelta(index: Self.textIndex, text: piece))
        }
        if let fragments = delta["tool_calls"]?.arrayValue {
            events += closeReasoning()
            for fragment in fragments { events += consumeToolFragment(fragment) }
        }
        return events
    }

    private mutating func consumeToolFragment(_ f: JSONValue) -> [ProviderEvent] {
        let id = f["id"]?.stringValue ?? ""
        let name = f["function"]?["name"]?.stringValue ?? ""
        let args: String
        switch f["function"]?["arguments"] {
        case .string(let s)?: args = s
        case .object(let o)?: args = JSONValue.object(o).encodedString()
        default: args = ""
        }

        let slot: Int
        if let wire = f["index"]?.intValue {
            if let s = slotForIndex[wire], id.isEmpty || slots[s].id.isEmpty || slots[s].id == id {
                slot = s
            } else if !id.isEmpty, let found = slots.firstIndex(where: { $0.id == id }) {
                // Interleaved fragments: the server reused the index for
                // another call, then came back to this id.
                slot = found
                slotForIndex[wire] = found
            } else {
                // New index, or a server reusing the index for a different call.
                slot = slots.count
                slots.append(Slot())
                slotForIndex[wire] = slot
            }
        } else if let last = slots.indices.last,
                  (id.isEmpty || id == slots[last].id), (name.isEmpty || slots[last].name.isEmpty) {
            slot = last // continuation fragment
        } else {
            slot = slots.count
            slots.append(Slot())
        }

        if slots[slot].id.isEmpty, !id.isEmpty, !slots[slot].started { slots[slot].id = id }
        if slots[slot].name.isEmpty, !name.isEmpty { slots[slot].name = name }
        slots[slot].arguments += args

        let index = Self.toolIndex(slot)
        if !slots[slot].started {
            guard !slots[slot].name.isEmpty else { return [] } // wait for the name
            if slots[slot].id.isEmpty { slots[slot].id = "call_" + UUID().uuidString.lowercased() }
            slots[slot].started = true
            var events: [ProviderEvent] = [.toolCallStarted(index: index, id: slots[slot].id, name: slots[slot].name)]
            if !slots[slot].arguments.isEmpty { events.append(.toolCallDelta(index: index, json: slots[slot].arguments)) }
            return events
        }
        return args.isEmpty ? [] : [.toolCallDelta(index: index, json: args)]
    }

    private mutating func closeReasoning() -> [ProviderEvent] {
        guard reasoningOpen, !reasoningClosed else { return [] }
        reasoningClosed = true
        return [.blockFinished(index: Self.reasoningIndex)]
    }

    mutating func finish() throws -> [ProviderEvent] {
        // `[DONE]` or a finish reason marks a complete response; a body that
        // just stops (connection drop) does not.
        guard isDone || finishReason != nil else {
            throw ProviderError.network(sawChunk ? "The response ended before it was complete." : "The server sent an empty response.")
        }
        var events = closeReasoning()
        if textOpen { events.append(.blockFinished(index: Self.textIndex)) }
        let calls = slots.filter(\.started)
        if calls.isEmpty, text.isEmpty, reasoning.isEmpty,
           finishReason == "tool_calls" || finishReason == "function_call" {
            // The wire promised tool calls but never named one, and nothing
            // else arrived: completing empty would silently drop the turn.
            // (Text alongside is kept — see finishReasonMapping.)
            throw ProviderError.decoding("The server said it would call tools but never named one.")
        }
        for (i, slot) in slots.enumerated() where slot.started { events.append(.blockFinished(index: Self.toolIndex(i))) }

        var parts: [Part] = []
        if !reasoning.isEmpty { parts.append(.reasoning(Reasoning(text: reasoning))) }
        if !text.isEmpty { parts.append(.text(text)) }
        let toolCalls = calls.map { ToolCall(id: $0.id, name: $0.name, arguments: $0.arguments) }
        parts += toolCalls.map(Part.toolCall)

        var raw: [String: JSONValue] = ["role": "assistant", "content": text.isEmpty ? .null : .string(text)]
        if !toolCalls.isEmpty { raw["tool_calls"] = .array(toolCalls.map(OpenAIRequestBuilder.toolCall)) }
        if !reasoning.isEmpty { raw[reasoningField] = .string(reasoning) }
        let message = Message(role: .assistant, parts: parts,
                              raw: parts.isEmpty ? nil : ProviderPayload(flavor: .openAIChat, data: JSONValue.object(raw).encodedData()))

        events.append(.completed(ProviderResponse(message: message, stopReason: stopReason(hasToolCalls: !toolCalls.isEmpty),
                                                  usage: usage)))
        return events
    }

    private func stopReason(hasToolCalls: Bool) -> StopReason {
        switch finishReason {
        case "tool_calls", "function_call": return .toolUse
        case "length": return .maxTokens
        case "content_filter": return .refusal(nil)
        // Some servers say `stop` (or nothing) alongside tool calls; the calls are what count.
        case "stop", "end_turn", "eos", nil: return hasToolCalls ? .toolUse : .endTurn
        case let other?: return .other(other)
        }
    }

    static func usage(_ u: JSONValue) -> Usage {
        let prompt = u["prompt_tokens"]?.intValue ?? 0
        let cached = u["prompt_tokens_details"]?["cached_tokens"]?.intValue
            ?? u["prompt_cache_hit_tokens"]?.intValue ?? 0 // DeepSeek
        return Usage(inputTokens: max(0, prompt - cached), outputTokens: u["completion_tokens"]?.intValue ?? 0,
                     cacheReadTokens: cached)
    }
}
