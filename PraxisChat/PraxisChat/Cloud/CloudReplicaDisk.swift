import Foundation

/// Typed rows are prepared once after the final page, away from the UI actor.
struct CloudReplicaProjection: Sendable {
    let chats: [CloudRemoteChat]
    let messagesByChat: [String: [CloudSyncedMessage]]
    let runs: [CloudRun]
    var changedChatIDs: Set<String>?

    init(_ replica: CloudCursorReplica, changedChatIDs: Set<String>? = nil) throws {
        chats = try replica.rows("chat", as: CloudRemoteChat.self)
        messagesByChat = Dictionary(grouping: try replica.rows("message", as: CloudSyncedMessage.self), by: \.chatId)
            .mapValues { $0.sorted { $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt } }
        runs = try replica.rows("run", as: CloudRun.self)
        self.changedChatIDs = changedChatIDs
    }
}

/// All sync JSON coding and raw page commits run on this actor, never MainActor.
actor CloudReplicaDisk {
    func load(_ file: URL) throws -> CloudCursorReplica { try CloudCursorReplica.load(file) }
    func read(_ file: URL) -> Data? { try? Data(contentsOf: file) }
    func write(_ data: Data, to file: URL) throws {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    func project(_ replica: CloudCursorReplica, changedChatIDs: Set<String>? = nil) throws -> CloudReplicaProjection {
        try .init(replica, changedChatIDs: changedChatIDs)
    }
    func apply(_ page: CloudCursorReplica.Page, to replica: CloudCursorReplica, file: URL) throws -> (CloudCursorReplica, Set<String>) {
        struct Owner: Decodable { let chatId: String }
        var changed = Set<String>()
        for row in page.entities {
            if row.key.hasPrefix("chat:") { changed.insert(String(row.key.dropFirst(5))) }
            else if row.key.hasPrefix("message:") || row.key.hasPrefix("run:") {
                for value in [row.value, replica.values[row.key]].compactMap({ $0 }) {
                    if let data = try? JSONEncoder().encode(value), let owner = try? JSONDecoder().decode(Owner.self, from: data) { changed.insert(owner.chatId) }
                }
            }
        }
        var next = replica
        try next.apply(page, file: file, changedChatIDs: changed)
        return (next, changed)
    }
    func acknowledge(_ replica: CloudCursorReplica, file: URL) throws -> CloudCursorReplica {
        var next = replica; try next.acknowledgeChanges(file: file); return next
    }
    func remove(_ url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
    }
}
