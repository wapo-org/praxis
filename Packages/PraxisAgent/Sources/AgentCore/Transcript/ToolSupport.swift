import Foundation

/// Tool use for models that can't do it.
///
/// When the chat model has no tool support, request builders send no `tools`
/// (and no `tool_choice`), flatten past tool calls and results into plain
/// text at request-build time, and tell the model tools are off. The frozen
/// setup and the transcript stay untouched, so the conversation works as an
/// agent again on a tool-capable model.
public enum ToolSupport {
    /// Appended to the outgoing request's system text when tools are off for
    /// the request — never to the frozen system prompt or the transcript.
    public static let toolsOffNote = "Tools aren't available with this model right now. Answer directly from what you know and from the conversation; don't write tool calls."

    /// The system text for a tools-off request: the frozen system prompt plus
    /// the note, or the note alone when there is no system prompt.
    public static func systemForToolsOffRequest(_ system: String) -> String {
        system.isBlankText ? toolsOffNote : system + "\n\n" + toolsOffNote
    }

    /// A past tool call as plain text for a tools-off request.
    public static func flattenedCall(_ call: ToolCall) -> String {
        "[Tool call: \(call.name)(\(call.arguments.isBlankText ? "{}" : call.arguments))]"
    }

    /// A past tool result as plain text for a tools-off request. `text` is
    /// the result's rendered text; the caller handles images first, the same
    /// way it does for tool messages.
    public static func flattenedResult(toolName: String, text: String, isError: Bool) -> String {
        let body = text.isEmpty ? "(no output)" : text
        return "[Tool result from \(toolName): \(isError ? "Error: " : "")\(body)]"
    }

    // MARK: Rejected tool use

    /// Whether a provider error message says the model (or every endpoint
    /// serving it) doesn't take tool use. A family of wordings from
    /// compatible servers, matched on the message rather than on who sent
    /// it: OpenRouter ("No endpoints found that support tool use"), schema
    /// errors ("`tools` is not supported", "unsupported parameter: tools",
    /// "tool_choice is not supported") and the generic "does not support
    /// tools / tool use / function calling".
    public static func isToolUseRejection(_ message: String) -> Bool {
        let text = message.lowercased()
        return rejectionPatterns.contains { text.contains($0) }
    }

    static let rejectionPatterns: [String] = [
        "no endpoints found that support tool use",
        "does not support tools",
        "does not support tool use",
        "tool use is not supported",
        "tools are not supported",
        "tool calling is not supported",
        "function calling is not supported",
        "does not support function calling",
        "`tools` is not supported",
        "'tools' is not supported",
        "unsupported parameter: tools",
        "tool_choice is not supported",
    ]
}

extension RunOutcome {
    /// The run failed because the provider rejected tool use. The loop
    /// reports provider errors as `ProviderError.description`, which keeps
    /// the server's message.
    public var isToolUseRejection: Bool {
        if case .failed(let reason) = self { return ToolSupport.isToolUseRejection(reason) }
        return false
    }
}
