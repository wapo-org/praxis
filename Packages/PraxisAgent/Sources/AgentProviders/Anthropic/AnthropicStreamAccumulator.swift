import Foundation
import AgentCore

/// Anthropic Messages SSE → `ProviderEvent`s, rebuilding the assistant
/// `content` array exactly as the server would have returned it
/// non-streaming, so it can be stored as `raw` and replayed.
///
/// Known blocks get their deltas applied (text, thinking + signature,
/// tool input JSON, citations); any other block — server-tool results,
/// redacted thinking, future types — is kept verbatim from its
/// `content_block_start`.
struct AnthropicStreamAccumulator: StreamAccumulator {
    private struct Block: Sendable {
        var json: [String: JSONValue]
        var type: String
        var text = ""
        var thinking = ""
        var signature = ""
        var partialJSON = ""
        var citations: [JSONValue] = []
        var finished = false

        init(_ json: [String: JSONValue]) {
            self.json = json
            self.type = json["type"]?.stringValue ?? "unknown"
            text = json["text"]?.stringValue ?? ""
            thinking = json["thinking"]?.stringValue ?? ""
            signature = json["signature"]?.stringValue ?? ""
            citations = json["citations"]?.arrayValue ?? []
        }

        var isToolInput: Bool { type == "tool_use" || type == "server_tool_use" || type == "mcp_tool_use" }

        /// The block as it would appear in a non-streaming response.
        var final: JSONValue {
            var out = json
            switch type {
            case "text":
                out["text"] = .string(text)
                if !citations.isEmpty { out["citations"] = .array(citations) }
            case "thinking":
                out["thinking"] = .string(thinking)
                if !signature.isEmpty || json["signature"] != nil { out["signature"] = .string(signature) }
            default:
                if isToolInput { out["input"] = input }
            }
            return .object(out)
        }

        var input: JSONValue {
            if !partialJSON.isBlank, let parsed = try? JSONValue(parsing: partialJSON), case .object = parsed {
                return parsed
            }
            if let start = json["input"], case .object = start { return start }
            return .object([:])
        }

        /// Argument text exactly as streamed (falls back to the start input).
        var arguments: String { partialJSON.isBlank ? input.encodedString() : partialJSON }
    }

    /// In arrival order; mutated in place so appending a delta never
    /// copies the text accumulated so far.
    private var blocks: [Block] = []
    /// Wire `index` → position in `blocks`.
    private var position: [Int: Int] = [:]
    private var usage = Usage()
    private var stopReason: String?
    private var refusalCategory: String?
    private var sawMessageStart = false
    private(set) var isDone = false

    mutating func consume(_ event: SSEEvent) throws -> [ProviderEvent] {
        guard let json = HTTPSupport.json(event) else { return [] }
        let type = json["type"]?.stringValue ?? event.event ?? ""
        switch type {
        case "message_start":
            sawMessageStart = true
            if let u = json["message"]?["usage"] { merge(u) }
            return usage.isEmpty ? [] : [.usage(usage)]

        case "content_block_start":
            guard let index = json["index"]?.intValue, let obj = json["content_block"]?.objectValue else { return [] }
            var block = Block(obj)
            if block.type == "tool_use", (block.json["id"]?.stringValue ?? "").isEmpty {
                // Some compatible servers omit the id. Synthesize one here
                // so the start event and the final call agree (mirrors the
                // OpenAI accumulator); it also lands in raw for replay.
                block.json["id"] = .string("call_" + UUID().uuidString.lowercased())
            }
            if let pos = position[index] {
                blocks[pos] = block
            } else {
                position[index] = blocks.count
                blocks.append(block)
            }
            return startEvents(block, index: index)

        case "content_block_delta":
            guard let index = json["index"]?.intValue, let pos = position[index], let delta = json["delta"] else { return [] }
            var events: [ProviderEvent] = []
            switch delta["type"]?.stringValue {
            case "text_delta":
                let t = delta["text"]?.stringValue ?? ""
                blocks[pos].text += t
                if !t.isEmpty { events.append(.textDelta(index: index, text: t)) }
            case "thinking_delta":
                let t = delta["thinking"]?.stringValue ?? ""
                blocks[pos].thinking += t
                if !t.isEmpty { events.append(.reasoningDelta(index: index, text: t)) }
            case "signature_delta":
                blocks[pos].signature += delta["signature"]?.stringValue ?? ""
            case "input_json_delta":
                let piece = delta["partial_json"]?.stringValue ?? ""
                blocks[pos].partialJSON += piece
                if blocks[pos].type == "tool_use", !piece.isEmpty { events.append(.toolCallDelta(index: index, json: piece)) }
            case "citations_delta":
                if let c = delta["citation"] { blocks[pos].citations.append(c) }
            default:
                break // unknown delta types carry nothing we can place
            }
            return events

        case "content_block_stop":
            guard let index = json["index"]?.intValue, let pos = position[index] else { return [] }
            blocks[pos].finished = true
            let block = blocks[pos]
            var events: [ProviderEvent] = []
            if block.type == "server_tool_use" || block.type == "mcp_tool_use" {
                // Emitted once the input is complete so the UI can show the query.
                events.append(.serverToolStarted(index: index, id: block.json["id"]?.stringValue ?? "",
                                                 name: block.json["name"]?.stringValue ?? block.type, input: block.input))
            }
            events.append(.blockFinished(index: index))
            return events

        case "message_delta":
            if let delta = json["delta"] {
                if let r = delta["stop_reason"]?.stringValue { stopReason = r }
                if let c = (delta["stop_details"] ?? json["stop_details"])?["category"]?.stringValue { refusalCategory = c }
            }
            if let u = json["usage"] { merge(u) }
            return [.usage(usage)]

        case "message_stop":
            isDone = true
            return []

        case "error":
            let details = HTTPSupport.errorDetails(json) ?? (type: "error", message: event.data)
            throw ProviderError.stream(type: details.type, message: details.message)

        default:
            return [] // ping and future events
        }
    }

    mutating func finish() throws -> [ProviderEvent] {
        // A missing `message_stop` after a stop reason is a harmless cut; a
        // missing stop reason means the response is incomplete.
        guard sawMessageStart, let stopReason else {
            throw ProviderError.network("The response ended before it was complete.")
        }
        var events: [ProviderEvent] = []
        for (index, pos) in position.sorted(by: { $0.value < $1.value }) where !blocks[pos].finished {
            events.append(.blockFinished(index: index))
        }
        events.append(.completed(ProviderResponse(message: message(), stopReason: Self.stopReason(stopReason, category: refusalCategory),
                                                  usage: usage)))
        return events
    }

    // MARK: Building

    private func startEvents(_ block: Block, index: Int) -> [ProviderEvent] {
        switch block.type {
        case "text":
            return block.text.isEmpty ? [] : [.textDelta(index: index, text: block.text)]
        case "thinking":
            return block.thinking.isEmpty ? [] : [.reasoningDelta(index: index, text: block.thinking)]
        case "tool_use":
            return [.toolCallStarted(index: index, id: block.json["id"]?.stringValue ?? "", name: block.json["name"]?.stringValue ?? "")]
        default:
            if block.type.hasSuffix("_tool_result"), let id = block.json["tool_use_id"]?.stringValue {
                let (summary, isError) = Self.summarize(block.json)
                return [.serverToolFinished(index: index, id: id, summary: summary, isError: isError)]
            }
            return []
        }
    }

    private func message() -> Message {
        var parts: [Part] = []
        var content: [JSONValue] = []
        for block in blocks {
            content.append(block.final)
            switch block.type {
            case "text" where !block.text.isEmpty:
                parts.append(.text(block.text))
            case "thinking":
                parts.append(.reasoning(Reasoning(text: block.thinking, signature: block.signature.nilIfEmpty)))
            case "tool_use":
                parts.append(.toolCall(ToolCall(id: block.json["id"]?.stringValue ?? "", name: block.json["name"]?.stringValue ?? "",
                                                arguments: block.arguments)))
            default:
                break
            }
        }
        // The loop drops messages without parts, but a server-tool-only turn
        // (typical for `pause_turn`) must still be replayed.
        if parts.isEmpty && !content.isEmpty { parts = [.text("")] }
        let raw = content.isEmpty ? nil : ProviderPayload(flavor: .anthropicMessages, data: JSONValue.array(content).encodedData())
        return Message(role: .assistant, parts: parts, raw: raw)
    }

    private mutating func merge(_ u: JSONValue) {
        if let v = u["input_tokens"]?.intValue { usage.inputTokens = v }
        if let v = u["output_tokens"]?.intValue { usage.outputTokens = v }
        if let v = u["cache_read_input_tokens"]?.intValue { usage.cacheReadTokens = v }
        if let v = u["cache_creation_input_tokens"]?.intValue { usage.cacheWriteTokens = v }
    }

    static func stopReason(_ raw: String, category: String?) -> StopReason {
        switch raw {
        case "end_turn", "stop_sequence": return .endTurn
        case "tool_use": return .toolUse
        case "max_tokens": return .maxTokens
        case "pause_turn": return .pauseTurn
        case "refusal": return .refusal(category)
        case "model_context_window_exceeded": return .contextWindowExceeded
        default: return .other(raw)
        }
    }

    /// One-line outcome of a server-tool result block for the UI.
    static func summarize(_ block: [String: JSONValue]) -> (String, Bool) {
        let content = block["content"]
        let type = block["type"]?.stringValue ?? ""
        let label = type.hasPrefix("web_fetch") ? "Fetch" : type.hasPrefix("web_search") ? "Search" : "Tool"
        if let code = content?["error_code"]?.stringValue {
            return ("\(label) failed (\(code))", true)
        }
        if let results = content?.arrayValue {
            let n = results.count
            return (n == 1 ? "1 result" : "\(n) results", false)
        }
        if let page = content, page["type"]?.stringValue == "web_fetch_result" {
            let title = page["content"]?["title"]?.stringValue
            return ("Fetched \(title ?? page["url"]?.stringValue ?? "page")", false)
        }
        return ("Done", false)
    }
}
