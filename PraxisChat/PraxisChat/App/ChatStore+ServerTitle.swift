import Foundation

extension ChatStore {
    /// Title refresh is independent of streaming: failure leaves the local
    /// title intact until normal cursor sync reconciles it.
    @discardableResult
    func refreshCloudServerTitle(conversationID: UUID, client: CloudAPIClient) async -> Bool {
        guard let conversation = conversations.first(where: { $0.id == conversationID }) else { return false }
        let remoteID = conversation.cloudChatID ?? conversation.id.uuidString
        let previousTitle = conversation.title
        do {
            let remote: CloudChatIdentity = try await client.send("/v1/chats/" + CloudAPIClient.segment(remoteID))
            guard remote.id == remoteID, let title = remote.title,
                  !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  conversations.contains(where: { $0 === conversation }),
                  conversation.title == previousTitle else { return false }
            conversation.title = title
            persistConversation(conversation)
            persistCloudProjection([], indexChanged: true)
            return true
        } catch { return false }
    }
}
