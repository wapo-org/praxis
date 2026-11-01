import Foundation

/// Names for chats. A chat is titled by its first message; one that only
/// carries attachments is named after them ("Photo", "2 photos", the
/// file's name) instead of being left blank.
enum ConversationTitle {
    static let placeholder = "New chat"
    private static let maxLength = 42

    /// The title a first message earns: its text when there is some,
    /// otherwise what it carries. Nil for a message with neither.
    static func make(text: String, attachments: [Attachment]) -> String? {
        let collapsed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if !collapsed.isEmpty { return String(collapsed.prefix(maxLength)) }
        return attachmentTitle(attachments)
    }

    /// "Photo", "Screenshot", a lone file's name, "3 photos", "2 files",
    /// "4 attachments" (mixed kinds).
    static func attachmentTitle(_ attachments: [Attachment]) -> String? {
        guard let first = attachments.first else { return nil }
        if attachments.count == 1 {
            switch first.kind {
            case .photo, .camera: return "Photo"
            case .screenshot: return "Screenshot"
            case .file:
                let name = first.name.trimmingCharacters(in: .whitespacesAndNewlines)
                return name.isEmpty ? "File" : String(name.prefix(maxLength))
            }
        }
        let n = attachments.count
        func kinds(_ set: Set<Attachment.Kind>) -> Bool { attachments.allSatisfy { set.contains($0.kind) } }
        if kinds([.photo, .camera]) { return "\(n) photos" }
        if kinds([.screenshot]) { return "\(n) screenshots" }
        if kinds([.photo, .camera, .screenshot]) { return "\(n) images" }
        if kinds([.file]) { return "\(n) files" }
        return "\(n) attachments"
    }
}

extension Conversation {
    /// The title to show: blank titles (chats saved before attachment-only
    /// messages were named, or an edited-away first message) fall back to
    /// what the first message holds, then to "New chat".
    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        if let first = turns.first,
           let derived = ConversationTitle.make(text: first.userText, attachments: first.attachments) {
            return derived
        }
        return ConversationTitle.placeholder
    }

    /// Whether the next message should (re)name the chat: it is untitled,
    /// or was named after attachments alone and now gets words.
    func wantsTitle(for text: String) -> Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == ConversationTitle.placeholder { return true }
        guard text.contains(where: { !$0.isWhitespace }),
              let first = turns.first, first.userText.allSatisfy(\.isWhitespace) else { return false }
        return trimmed == ConversationTitle.attachmentTitle(first.attachments)
    }
}
