import Foundation

/// Titles new chats from text or attachment summary.
enum ConversationTitle {
    static let placeholder = "New chat"
    private static let maxLength = 42

    static func make(text: String, attachments: [Attachment]) -> String? {
        let collapsed = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if !collapsed.isEmpty { return String(collapsed.prefix(maxLength)) }
        return attachmentTitle(attachments)
    }

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
    /// Falls back to attachment title before defaulting to New chat.
    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        if let first = turns.first,
           let derived = ConversationTitle.make(text: first.userText, attachments: first.attachments) {
            return derived
        }
        return ConversationTitle.placeholder
    }

    func wantsTitle(for text: String) -> Bool {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty || trimmed == ConversationTitle.placeholder { return true }
        guard text.contains(where: { !$0.isWhitespace }),
              let first = turns.first, first.userText.allSatisfy(\.isWhitespace) else { return false }
        return trimmed == ConversationTitle.attachmentTitle(first.attachments)
    }
}
