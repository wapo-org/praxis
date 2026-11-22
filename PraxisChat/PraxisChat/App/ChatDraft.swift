import Foundation

/// In-memory unsent composer draft scoped per conversation.
struct ChatDraft: Sendable {
    var text: String = ""
    var attachments: [Attachment] = []
}
