import Foundation

/// Writes compaction summaries with the conversation's own provider and
/// model.
///
/// The messages to condense are rendered as plain text (tool results and
/// long texts clipped, media named, reasoning dropped) and sent without
/// tools under a dedicated instruction. That works on every compatible
/// server — no tool pairs to keep valid, no chance of the model calling a
/// tool instead of answering — and bounds the request: history longer
/// than one request can hold is folded in chunk by chunk, each step
/// extending the previous summary.
struct ContextSummarizer: Sendable {
    let provider: any ModelProvider
    let model: String
    let maxTokens: Int
    /// Budget for one request's rendered transcript.
    let chunkTokens: Int
    let maxRetries: Int
    let sleep: @Sendable (Duration) async throws -> Void

    struct Failure: Error, CustomStringConvertible {
        let description: String
    }

    /// The summary of `previous` (an earlier summary, if any) followed by
    /// `messages`, and the usage the requests cost.
    func summarize(previous: String?, messages: ArraySlice<Message>) async throws -> (String, Usage) {
        let budget = max(2_000, chunkTokens) * TokenEstimator.bytesPerToken
        var summary = previous
        var usage = Usage()
        for chunk in Self.chunks(messages, maxBytes: budget) {
            let (text, cost) = try await request(previous: summary, transcript: chunk)
            summary = text
            usage = usage + cost
        }
        guard let summary, !summary.isBlankText else { throw Failure(description: "The model returned an empty summary.") }
        return (summary, usage)
    }

    private func request(previous: String?, transcript: String) async throws -> (String, Usage) {
        var prompt = ""
        if let previous {
            prompt += "<previous_summary>\n\(previous)\n</previous_summary>\n\n"
        }
        prompt += "<transcript>\n\(transcript)\n</transcript>\n\n"
        prompt += previous == nil
            ? "Write the summary of this transcript now."
            : "Write one updated summary that merges the previous summary with this later part of the transcript."
        let request = ProviderRequest(model: model, system: Self.instructions, messages: [.user(prompt)], tools: [],
                                      maxTokens: maxTokens, effort: .low)
        var attempt = 0
        while true {
            do {
                var final: ProviderResponse?
                for try await event in provider.stream(request) {
                    try Task.checkCancellation()
                    if case .completed(let response) = event { final = response }
                }
                try Task.checkCancellation()
                guard let final else { throw ProviderError.network("The response ended before it was complete.") }
                if case .refusal = final.stopReason { throw Failure(description: "The model declined to summarize.") }
                return (final.message.text.trimmingCharacters(in: .whitespacesAndNewlines), final.usage)
            } catch let error as ProviderError where error.isRetryable && attempt < maxRetries {
                attempt += 1
                try await sleep(min(error.retryAfter ?? .seconds(1 << min(attempt - 1, 5)), .seconds(30)))
            }
        }
    }

    static let instructions = """
        You condense a conversation between a user and an AI assistant so the assistant can continue it with less \
        context. The summary replaces the transcript you are given: anything you leave out is lost to the assistant.

        Write a dense, factual summary in the conversation's language, with these sections:
        1. User goals — what the user wants overall and in their latest request, in their own terms; constraints and preferences they stated.
        2. Progress — what has been done, decisions made and why, answers already given.
        3. Key facts — names, numbers, URLs, file names, identifiers, code or data the work depends on. Quote exact values.
        4. Tool work — which tools ran with what inputs and the results that matter. Keep tool call ids when a result was \
        truncated (it can be re-read with read_tool_output).
        5. Open items — unanswered questions, pending steps, what the assistant was about to do next.

        Do not invent anything. Do not address the user. Do not call tools. Output only the summary.
        """

    // MARK: Rendering

    /// Rendered messages grouped into chunks of at most `maxBytes`
    /// (one long part is clipped to a quarter of a chunk, so a few huge
    /// messages still share a request).
    static func chunks(_ messages: ArraySlice<Message>, maxBytes: Int) -> [String] {
        var chunks: [String] = []
        var current = ""
        for message in messages {
            var text = render(message, maxPartBytes: max(1_000, maxBytes / 4))
            if text.utf8.count > maxBytes { text = clip(text, maxBytes) }
            if !current.isEmpty, current.utf8.count + text.utf8.count + 2 > maxBytes {
                chunks.append(current)
                current = ""
            }
            current += current.isEmpty ? text : "\n\n" + text
        }
        if !current.isEmpty { chunks.append(current) }
        return chunks
    }

    static func render(_ message: Message, maxPartBytes: Int) -> String {
        var lines: [String] = []
        let speaker = message.role == .user ? "User" : "Assistant"
        for part in message.parts {
            switch part {
            case .text(let t) where !t.isBlankText:
                lines.append("\(speaker): " + clip(t, maxPartBytes))
            case .note(let n):
                lines.append("[Context note: " + clip(n, 1_000) + "]")
            case .image(let m):
                lines.append("[\(speaker) shared an image\(m.name.map { " “\($0)”" } ?? "")]")
            case .document(let m):
                var line = "[\(speaker) shared a document\(m.name.map { " “\($0)”" } ?? "") (\(m.mediaType))]"
                if m.mediaType.hasPrefix("text/") || m.mediaType.contains("json") || m.mediaType.contains("xml") {
                    line += "\n" + clip(String(decoding: m.data.prefix(maxPartBytes), as: UTF8.self), min(4_000, maxPartBytes))
                }
                lines.append(line)
            case .toolCall(let c):
                lines.append("[Assistant called \(c.name) (id \(c.id)) with \(clip(c.arguments, 1_500))]")
            case .toolResult(let r):
                let body = r.content.map { content -> String in
                    switch content {
                    case .text(let t): return t
                    case .image: return "[image]"
                    }
                }.joined(separator: "\n")
                lines.append("[Result of \(r.toolName) (id \(r.callID))\(r.isError ? ", error" : "")]: " + clip(body, min(3_000, maxPartBytes)))
            case .text, .reasoning:
                break
            }
        }
        return lines.joined(separator: "\n")
    }

    /// Head and tail of `text` within about `maxBytes`.
    static func clip(_ text: String, _ maxBytes: Int) -> String {
        guard text.utf8.count > maxBytes else { return text }
        let head = String(decoding: text.utf8.prefix(maxBytes * 2 / 3), as: UTF8.self)
        let tail = String(decoding: text.utf8.suffix(maxBytes / 3), as: UTF8.self)
        return head + " …[\(text.utf8.count - maxBytes) bytes omitted]… " + tail
    }
}

extension String {
    var isBlankText: Bool { allSatisfy(\.isWhitespace) }
}
