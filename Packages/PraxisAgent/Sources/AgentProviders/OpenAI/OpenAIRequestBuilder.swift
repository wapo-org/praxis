import Foundation
import AgentCore

/// Neutral transcript → `POST /chat/completions` body.
///
/// Shapes are chosen for the widest compatibility with local servers:
/// text-only user turns are plain strings, tool results are strings, and
/// images go out as `image_url` data URLs only when the endpoint has vision.
struct OpenAIRequestBuilder: Sendable {
    let capabilities: Capabilities
    let options: OpenAIOptions
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
            "stream": true,
            "messages": .array(messages(system: request.system, transcript: request.messages)),
        ]
        if capabilities.streamUsage { body["stream_options"] = ["include_usage": true] }
        switch options.maxTokensField {
        case .maxTokens: body["max_tokens"] = .number(Double(request.maxTokens))
        case .maxCompletionTokens: body["max_completion_tokens"] = .number(Double(request.maxTokens))
        case .omit: break
        }
        if capabilities.tools, !request.tools.isEmpty {
            body["tools"] = .array(request.tools.map { spec in
                ["type": "function",
                 "function": ["name": .string(spec.name), "description": .string(spec.description), "parameters": spec.inputSchema]]
            })
        }
        if capabilities.reasoningEffort {
            let value = request.effort == .max ? options.maxEffortValue : request.effort.rawValue
            body["reasoning_effort"] = .string(value)
        }
        return .object(body)
    }

    // MARK: Messages

    func messages(system: String, transcript: [Message]) -> [JSONValue] {
        var out: [JSONValue] = []
        // Tools off is per request: the frozen system prompt gains the note
        // here, at build time, and stays untouched everywhere else.
        let effectiveSystem = capabilities.tools ? system : ToolSupport.systemForToolsOffRequest(system)
        if !effectiveSystem.isBlank { out.append(["role": .string(options.systemRole), "content": .string(effectiveSystem)]) }
        for message in transcript {
            switch message.role {
            case .assistant:
                if let m = assistant(message) { out.append(m) }
            case .user:
                for m in user(message) { Self.append(m, to: &out) }
            }
        }
        return out
    }

    private func assistant(_ message: Message) -> JSONValue? {
        if capabilities.tools, let raw = message.raw, raw.flavor == .openAIChat,
           case .object(var stored)? = try? JSONValue(parsing: raw.data) {
            if !options.replayReasoning {
                for key in ["reasoning_content", "reasoning", "reasoning_details"] { stored.removeValue(forKey: key) }
            }
            stored["role"] = "assistant"
            return .object(stored)
        }
        let text = message.parts.compactMap { if case .text(let t) = $0 { return t }; return nil }.joined()
        let calls = message.toolCalls
        guard !text.isBlank || !calls.isEmpty else { return nil }
        if !capabilities.tools {
            // Past calls go out as plain text: a replayed or rebuilt
            // `tool_calls` field would be rejected with no tools declared.
            let lines = (text.isBlank ? [] : [text]) + calls.map(ToolSupport.flattenedCall)
            return ["role": "assistant", "content": .string(lines.joined(separator: "\n"))]
        }
        var m: [String: JSONValue] = ["role": "assistant", "content": text.isBlank ? .null : .string(text)]
        if !calls.isEmpty { m["tool_calls"] = .array(calls.map(Self.toolCall)) }
        return .object(m)
    }

    static func toolCall(_ call: ToolCall) -> JSONValue {
        ["id": .string(call.id), "type": "function",
         "function": ["name": .string(call.name), "arguments": .string(call.arguments.isBlank ? "{}" : call.arguments)]]
    }

    /// One neutral user message becomes: one `tool` message per result (they
    /// must directly follow the assistant's `tool_calls`), then notes as
    /// system messages when supported, then one user message with the rest
    /// — including images that tool results can't carry.
    private func user(_ message: Message) -> [JSONValue] {
        var toolMessages: [JSONValue] = []
        var systemNotes: [JSONValue] = []
        var content: [JSONValue] = []

        for part in message.parts {
            switch part {
            case .toolResult(let result):
                if capabilities.tools {
                    toolMessages.append(toolMessage(result, images: &content))
                } else {
                    content.append(contentsOf: flattenedResult(result))
                }
            case .note(let n) where !n.isBlank:
                if capabilities.midConversationSystem {
                    systemNotes.append(["role": .string(options.systemRole), "content": .string(n)])
                } else {
                    content.append(Self.text(HTTPSupport.wrappedNote(n)))
                }
            case .text(let t) where !t.isBlank:
                content.append(Self.text(t))
            case .image(let media):
                content.append(capabilities.vision ? Self.image(media) : Self.text(ImageReference.placeholder(for: media, lookToolOffered: lookToolOffered)))
            case .document(let media):
                content.append(document(media))
            default:
                break
            }
        }
        var out = toolMessages + systemNotes
        if !content.isEmpty { out.append(["role": "user", "content": Self.compact(content)]) }
        return out
    }

    private func toolMessage(_ result: ToolResult, images: inout [JSONValue]) -> JSONValue {
        var lines: [String] = []
        for item in result.content {
            switch item {
            case .text(let t):
                lines.append(t)
            case .image(let media):
                if capabilities.vision {
                    lines.append("[image\(media.name.map { " \"\($0)\"" } ?? "") attached in the next message]")
                    images.append(Self.image(media))
                } else {
                    lines.append(ImageReference.placeholder(for: media, lookToolOffered: lookToolOffered))
                }
            }
        }
        var text = lines.joined(separator: "\n")
        if text.isEmpty { text = "(no output)" }
        // Chat Completions has no error flag on tool messages.
        if result.isError { text = "Error: " + text }
        return ["role": "tool", "tool_call_id": .string(result.callID), "content": .string(text)]
    }

    /// A past tool result as user text (tools off): some servers reject
    /// `tool` role messages when no tools are declared. Images ride along
    /// in the same message when the model still sees them.
    private func flattenedResult(_ result: ToolResult) -> [JSONValue] {
        var lines: [String] = []
        var images: [JSONValue] = []
        for item in result.content {
            switch item {
            case .text(let t):
                lines.append(t)
            case .image(let media):
                if capabilities.vision {
                    lines.append("[image\(media.name.map { " \"\($0)\"" } ?? "") attached with this message]")
                    images.append(Self.image(media))
                } else {
                    lines.append(ImageReference.placeholder(for: media, lookToolOffered: lookToolOffered))
                }
            }
        }
        return [Self.text(ToolSupport.flattenedResult(toolName: result.toolName, text: lines.joined(separator: "\n"),
                                                      isError: result.isError))] + images
    }

    private func document(_ media: MediaData) -> JSONValue {
        if HTTPSupport.isTextLike(media.mediaType) { return Self.text(HTTPSupport.wrappedDocument(media)) }
        if capabilities.documents, media.mediaType.lowercased() == "application/pdf" {
            return ["type": "file", "file": ["filename": .string(media.name ?? "document.pdf"),
                                             "file_data": .string(HTTPSupport.dataURL(media))]]
        }
        return Self.text(HTTPSupport.omittedStub("Document", media))
    }

    // MARK: Helpers

    static func text(_ s: String) -> JSONValue { ["type": "text", "text": .string(s)] }

    static func image(_ media: MediaData) -> JSONValue {
        ["type": "image_url", "image_url": ["url": .string(HTTPSupport.dataURL(media))]]
    }

    /// Plain string when every part is text — many local chat templates
    /// only understand string content.
    static func compact(_ parts: [JSONValue]) -> JSONValue {
        if parts.allSatisfy({ $0["type"]?.stringValue == "text" }) {
            return .string(parts.compactMap { $0["text"]?.stringValue }.joined(separator: "\n\n"))
        }
        return .array(parts)
    }

    /// Consecutive user messages are merged: strict-alternation chat
    /// templates (Mistral, some Llama builds) reject neighbours.
    static func append(_ message: JSONValue, to out: inout [JSONValue]) {
        guard message["role"]?.stringValue == "user", let last = out.last, last["role"]?.stringValue == "user",
              let a = last["content"], let b = message["content"] else {
            out.append(message)
            return
        }
        func parts(_ v: JSONValue) -> [JSONValue] {
            if case .string(let s) = v { return [text(s)] }
            return v.arrayValue ?? []
        }
        out[out.count - 1] = ["role": "user", "content": compact(parts(a) + parts(b))]
    }
}
