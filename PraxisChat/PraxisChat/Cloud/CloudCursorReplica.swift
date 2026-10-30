import Foundation
import AgentCore

struct CloudRemoteChat: Decodable, Sendable {
    let id: String
    let title: String
    let updatedAt: String
    let pinned: Bool?
    let connectorIds: [String]?
    let disabledConnectorIds: [String]?
}
struct CloudSyncedMessage: Decodable, Sendable {
    let id: String
    let chatId: String
    let runId: String?
    let clientTurnId: String?
    let createdAt: String
    let role: String
    let parts: [CloudMessage.Content]
    let raw: CloudMessage.Raw?
    var native: Message {
        CloudMessage(id: id, role: role == "user" ? .user : .assistant, parts: parts,
                     raw: raw, clientTurnId: clientTurnId).native
    }
}

/// Cursor and raw entities are committed in one atomic file before a UI
/// projection is published. Rebuilding after a crash therefore loses no page.
struct CloudCursorReplica: Codable, Sendable {
    struct Entity: Codable, Sendable {
        let key: String
        let deleted: Bool
        let value: JSONValue?
    }
    struct Page: Decodable, Sendable {
        let cursor: String
        let nextCursor: String?
        let entities: [Entity]
    }
    struct Root: Decodable, Sendable { let cursor: String }
    struct Request: Encodable {
        let type = "sync.request"
        let strategy = "cursor"
        let cursor: String
        let limit = 500
    }
    var cursor = "0"
    var values: [String: JSONValue] = [:]

    static func load(_ url: URL) throws -> Self {
        guard FileManager.default.fileExists(atPath: url.path) else { return Self() }
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    }
    mutating func apply(_ page: Page, file: URL) throws {
        var next = self
        for row in page.entities {
            if row.deleted { next.values.removeValue(forKey: row.key) }
            else if let value = row.value { next.values[row.key] = value }
        }
        next.cursor = page.cursor
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(next).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        self = next
    }
    func rows<T: Decodable>(_ kind: String, as type: T.Type) throws -> [T] {
        try values.filter { $0.key.hasPrefix(kind + ":") }.sorted { $0.key < $1.key }.map {
            try JSONDecoder().decode(type, from: JSONEncoder().encode($0.value))
        }
    }
}
