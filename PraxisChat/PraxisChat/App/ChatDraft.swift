import Foundation

/// An unsent composer draft: the text plus its attachments. Stashed per
/// conversation in `ChatStore`, so attachments belong to the chat they
/// were added in and switching chats never carries a selection over —
/// but returning to a chat restores what was left unsent there.
/// In-memory only: a relaunch starts with clean composers.
struct ChatDraft: Sendable {
    var text: String = ""
    var attachments: [Attachment] = []
}
