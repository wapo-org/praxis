import Foundation
import AgentCore

/// Presentation-only server document references. They are not local bytes and
/// never change the attachments uploaded by a retry or the native runtime.
enum CloudDocumentChips {
    static func sameUserPresentation(_ lhs: Turn, _ rhs: Turn) -> Bool {
        lhs.id == rhs.id && lhs.userText == rhs.userText && visible(in: lhs) == visible(in: rhs)
    }
    static func visible(in turn: Turn) -> [Attachment] {
        guard turn.engine == .cloud else { return turn.attachments }
        var result = turn.attachments
        var matchedLocal = Set<UUID>(), seen = Set<UUID>()
        let prefix = Data("praxis-cloud-attachment:".utf8)
        for (messageIndex, message) in turn.transcript.enumerated() where message.role == .user {
            for (partIndex, part) in message.parts.enumerated() {
                guard case .document(let media) = part else { continue }
                let remoteID = media.data.starts(with: prefix) ? String(data: media.data.dropFirst(prefix.count), encoding: .utf8) : nil
                let key = remoteID.flatMap { $0.isEmpty ? nil : $0 } ?? "\(messageIndex):\(partIndex):\(media.name ?? "Document")"
                let id = CloudReplicaScope.localID("cloud-document:" + key)
                guard seen.insert(id).inserted else { continue }
                if let local = turn.attachments.first(where: { item in
                    guard item.kind == .file, !matchedLocal.contains(item.id) else { return false }
                    let sameName = media.name == nil || item.name == media.name || AttachmentMedia.fileName(for: item) == media.name
                    let mime = item.mediaType ?? AttachmentMedia.mediaType(forFileName: item.name)
                    return sameName && mime == media.mediaType
                }) { matchedLocal.insert(local.id); continue }
                result.append(Attachment(id: id, kind: .file, name: media.name ?? "Document", mediaType: media.mediaType))
            }
        }
        return result
    }
}
