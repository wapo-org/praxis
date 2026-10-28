import Foundation
import AgentCore

/// Neutral transcript → `POST /messages` body.
///
/// Same-flavor assistant messages replay their stored `content` array
/// untouched (thinking signatures, redacted thinking, server-tool blocks
/// with encrypted content, citations). Everything else is rebuilt from
/// parts, dropping opaque reasoning.
struct AnthropicRequestBuilder: Sendable {
    let capabilities: Capabilities
    let options: AnthropicOptions
    /// The request offers `look_at_image`: image placeholders point to it.
    var lookToolOffered = false

    func body(for request: ProviderRequest) -> JSONValue {
        var builder = self
        builder.lookToolOffered = capabilities.tools && request.tools.contains { $0.name == ImageReference.lookToolName }
        return builder.makeBody(for: request)
    }

    private func makeBody(for request: ProviderRequest) -> JSONValue {
        var body: [String: JSONValue] = [
            "model": .string(request.model),
            "max_tokens": .number(Double(request.maxTokens)),
            "stream": true,
        ]

        // Tools off is per request: the frozen system prompt gains the note
        // here, at build time, and stays untouched everywhere else.
        let effectiveSystem = capabilities.tools ? request.system : ToolSupport.systemForToolsOffRequest(request.system)
        if !effectiveSystem.isBlank {
            var block: [String: JSONValue] = ["type": "text", "text": .string(effectiveSystem)]
            if capabilities.explicitPromptCaching { block["cache_control"] = Self.ephemeral }
            body["system"] = [.object(block)]
        }

        var messages = self.messages(request.messages)
        if capabilities.explicitPromptCaching { Self.markLastUserMessage(&messages) }
        body["messages"] = .array(messages)

        var tools: [JSONValue] = []
        if capabilities.tools {
            for spec in request.tools {
                var t: [String: JSONValue] = [
                    "name": .string(spec.name),
                    "description": .string(spec.description),
                    "input_schema": spec.inputSchema,
                ]
                if options.eagerInputStreaming { t["eager_input_streaming"] = true }
                tools.append(.object(t))
            }
        }
        if request.serverWebSearch && capabilities.serverWebSearch {
            tools.append(["type": .string(options.webSearchToolType), "name": "web_search"])
            if let fetch = options.webFetchToolType {
                tools.append(["type": .string(fetch), "name": "web_fetch"])
            }
        }
        // Without tool support nothing is declared — not even server tools:
        // a model that can't do tool use can't answer those either.
        if capabilities.tools, !tools.isEmpty { body["tools"] = .array(tools) }

        // Only a value the model takes goes out; unknown sends the effort
        // unchanged, and no reasoning drops thinking and effort together
        // (a model without adaptive thinking rejects both).
        if capabilities.reasoningEffort, let wire = EffortLevels.clamp(request.effort.rawValue, to: request.supportedEffortValues) {
            var thinking: [String: JSONValue] = ["type": "adaptive"]
            if let display = options.thinkingDisplay { thinking["display"] = .string(display) }
            body["thinking"] = .object(thinking)
            body["output_config"] = ["effort": .string(wire)]
        }
        return .object(body)
    }

    // MARK: Messages

    func messages(_ transcript: [Message]) -> [JSONValue] {
        var wire: [(role: String, content: [JSONValue])] = []
        for message in transcript {
            let content: [JSONValue]
            let role: String
            switch message.role {
            case .assistant:
                role = "assistant"
                content = assistantContent(message)
            case .user:
                role = "user"
                content = userContent(message)
            }
            guard !content.isEmpty else { continue }
            // The API requires alternating roles: merge neighbours (consecutive
            // `pause_turn` continuations, repair results + a new question).
            if let last = wire.last, last.role == role {
                wire[wire.count - 1].content += content
            } else {
                wire.append((role, content))
            }
        }
        return wire.map { entry in
            // tool_result blocks must lead a user message.
            let content = entry.role == "user" ? Self.toolResultsFirst(entry.content) : entry.content
            return ["role": .string(entry.role), "content": .array(content)]
        }
    }

    private func assistantContent(_ message: Message) -> [JSONValue] {
        if capabilities.tools, let raw = message.raw, raw.flavor == .anthropicMessages,
           let blocks = Self.rawBlocks(raw.data), !blocks.isEmpty {
            return blocks
        }
        var out: [JSONValue] = []
        for part in message.parts {
            switch part {
            case .text(let t) where !t.isBlank:
                out.append(["type": "text", "text": .string(t)])
            case .toolCall(let call):
                if capabilities.tools {
                    let input = (try? JSONValue(parsing: call.arguments)).flatMap { $0.objectValue.map(JSONValue.object) } ?? .object([:])
                    out.append(["type": "tool_use", "id": .string(call.id), "name": .string(call.name), "input": input])
                } else {
                    // Past calls go out as plain text: replayed or rebuilt
                    // `tool_use` blocks would be rejected with no tools declared.
                    out.append(Self.text(ToolSupport.flattenedCall(call)))
                }
            default:
                // Reasoning from another provider has no valid signature here.
                break
            }
        }
        return out
    }

    static func rawBlocks(_ data: Data) -> [JSONValue]? {
        guard let json = try? JSONValue(parsing: data) else { return nil }
        if let blocks = json.arrayValue { return blocks }
        return json["content"]?.arrayValue
    }

    private func userContent(_ message: Message) -> [JSONValue] {
        var out: [JSONValue] = []
        var trailingImages: [JSONValue] = []
        for part in message.parts {
            switch part {
            case .text(let t):
                if !t.isBlank { out.append(Self.text(t)) }
            case .note(let n):
                if !n.isBlank { out.append(Self.text(HTTPSupport.wrappedNote(n))) }
            case .image(let media):
                out.append(capabilities.vision ? Self.image(media) : Self.text(ImageReference.placeholder(for: media, lookToolOffered: lookToolOffered)))
            case .document(let media):
                out.append(document(media))
            case .toolResult(let result):
                if capabilities.tools {
                    out.append(toolResult(result, overflowImages: &trailingImages))
                } else {
                    out.append(Self.text(flattenedResult(result, overflowImages: &trailingImages)))
                }
            case .reasoning, .toolCall:
                break
            }
        }
        return out + trailingImages
    }

    private func toolResult(_ result: ToolResult, overflowImages: inout [JSONValue]) -> JSONValue {
        var content: [JSONValue] = []
        for item in result.content {
            switch item {
            case .text(let t):
                if !t.isEmpty { content.append(Self.text(t)) }
            case .image(let media):
                if capabilities.vision && capabilities.imagesInToolResults {
                    content.append(Self.image(media))
                } else if capabilities.vision {
                    content.append(Self.text("[image\(media.name.map { " \"\($0)\"" } ?? "") attached after the tool results]"))
                    overflowImages.append(Self.image(media))
                } else {
                    content.append(Self.text(ImageReference.placeholder(for: media, lookToolOffered: lookToolOffered)))
                }
            }
        }
        if content.isEmpty { content = [Self.text("(no output)")] }
        var block: [String: JSONValue] = [
            "type": "tool_result",
            "tool_use_id": .string(result.callID),
            "content": .array(content),
        ]
        if result.isError { block["is_error"] = true }
        return .object(block)
    }

    /// A past tool result as user text (tools off). Images ride along after
    /// the text when the model still sees them.
    private func flattenedResult(_ result: ToolResult, overflowImages: inout [JSONValue]) -> String {
        var lines: [String] = []
        for item in result.content {
            switch item {
            case .text(let t):
                if !t.isEmpty { lines.append(t) }
            case .image(let media):
                if capabilities.vision {
                    lines.append("[image\(media.name.map { " \"\($0)\"" } ?? "") attached below]")
                    overflowImages.append(Self.image(media))
                } else {
                    lines.append(ImageReference.placeholder(for: media, lookToolOffered: lookToolOffered))
                }
            }
        }
        return ToolSupport.flattenedResult(toolName: result.toolName, text: lines.joined(separator: "\n"),
                                           isError: result.isError)
    }

    private func document(_ media: MediaData) -> JSONValue {
        let isPDF = media.mediaType.lowercased() == "application/pdf"
        let textLike = HTTPSupport.isTextLike(media.mediaType)
        guard capabilities.documents, isPDF || textLike else {
            return Self.text(textLike ? HTTPSupport.wrappedDocument(media) : HTTPSupport.omittedStub("Document", media))
        }
        let source: JSONValue = isPDF
            ? ["type": "base64", "media_type": "application/pdf", "data": .string(media.data.base64EncodedString())]
            : ["type": "text", "media_type": "text/plain", "data": .string(String(decoding: media.data, as: UTF8.self))]
        var block: [String: JSONValue] = ["type": "document", "source": source]
        if let name = media.name { block["title"] = .string(name) }
        return .object(block)
    }

    // MARK: Helpers

    static let ephemeral: JSONValue = ["type": "ephemeral"]

    static func text(_ s: String) -> JSONValue { ["type": "text", "text": .string(s)] }

    static func image(_ media: MediaData) -> JSONValue {
        ["type": "image", "source": ["type": "base64", "media_type": .string(media.mediaType),
                                     "data": .string(media.data.base64EncodedString())]]
    }

    static func toolResultsFirst(_ blocks: [JSONValue]) -> [JSONValue] {
        let results = blocks.filter { $0["type"]?.stringValue == "tool_result" }
        guard !results.isEmpty, results.count < blocks.count else { return blocks }
        return results + blocks.filter { $0["type"]?.stringValue != "tool_result" }
    }

    /// Breakpoint on the last block of the newest user turn: each request
    /// reads the prefix the previous one wrote. With the system breakpoint
    /// that's two of the four allowed.
    static func markLastUserMessage(_ messages: inout [JSONValue]) {
        guard let i = messages.lastIndex(where: { $0["role"]?.stringValue == "user" }),
              case .object(var message) = messages[i],
              case .array(var content)? = message["content"],
              let j = content.indices.last,
              case .object(var block) = content[j] else { return }
        block["cache_control"] = ephemeral
        content[j] = .object(block)
        message["content"] = .array(content)
        messages[i] = .object(message)
    }
}
