import CryptoKit
import Foundation

/// Scoped by account and server; cached UI never reconciles across accounts.
enum CloudReplicaScope {
    static func directory(root: URL, origin: String, userID: String) -> URL {
        root.appendingPathComponent("Cloud", isDirectory: true)
            .appendingPathComponent(digest(origin + "\n" + userID), isDirectory: true)
    }

    /// Maps opaque cloud IDs to deterministic UUIDs for SwiftUI identity.
    static func localID(_ remoteID: String) -> UUID {
        if let id = UUID(uuidString: remoteID) { return id }
        var bytes = Array(SHA256.hash(data: Data(remoteID.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x50
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// Journals wire events pre-coalescer and discards partial tail so cursors stay valid.
actor CloudRunJournal {
    struct Record: Codable, Sendable, Equatable {
        var conversationID: UUID
        var turnID: UUID
        var runID: String
    }
    struct Replay: Sendable {
        var events: [Data]
        var cursor: Int
        var byteCount: UInt64
        var snapshot: Data? = nil
    }
    private struct WireRecord: Codable { let data: Data }
    private struct Envelope: Decodable {
        let type: String
        let id: Int
        let runId: String
    }
    enum Failure: Error { case invalidEvent, writeFailed }

    let directory: URL
    private var cursors: [String: Int] = [:]
    private var blocked = Set<String>()
    private var closed = false

    init(directory: URL) { self.directory = directory.appendingPathComponent("Runs", isDirectory: true) }

    func register(_ record: Record) throws {
        guard !closed else { throw Failure.writeFailed }
        try prepareDirectory()
        try JSONEncoder().encode(record).write(to: metadataURL(record.runID),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func records() -> [Record] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }.compactMap {
            guard let data = try? Data(contentsOf: $0) else { return nil }
            return try? JSONDecoder().decode(Record.self, from: data)
        }
    }

    @discardableResult
    func append(_ data: Data, runID: String) throws -> Bool {
        guard !closed, !blocked.contains(runID) else { throw Failure.writeFailed }
        let header = try JSONDecoder().decode(Envelope.self, from: data)
        guard header.type == "run.event", header.runId == runID, header.id > 0,
              header.id <= 9_007_199_254_740_991 else { throw Failure.invalidEvent }
        // Base64 framing preserves unknown fields and multi-line JSON verbatim.
        var line = try JSONEncoder().encode(WireRecord(data: data))
        line.append(10)
        do {
            try prepareDirectory()
            let url = eventsURL(runID)
            if cursors[runID] == nil {
                let replay = replay(runID: runID)
                cursors[runID] = replay.cursor
                if FileManager.default.fileExists(atPath: url.path) {
                    let file = try FileHandle(forWritingTo: url)
                    defer { try? file.close() }
                    try file.truncate(atOffset: replay.byteCount)
                }
            }
            guard header.id > (cursors[runID] ?? 0) else { return false }
            if !FileManager.default.fileExists(atPath: url.path) {
                try Data().write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
            let file = try FileHandle(forWritingTo: url)
            defer { try? file.close() }
            try file.seekToEnd()
            try file.write(contentsOf: line)
            cursors[runID] = header.id
            return true
        } catch {
            // Block later cursors after a failed write to prevent Last-Event-ID gaps.
            blocked.insert(runID)
            throw error
        }
    }

    func replay(runID: String) -> Replay {
        let snapshotData = try? Data(contentsOf: snapshotURL(runID))
        let snapshot = snapshotData.flatMap { try? JSONDecoder().decode(CloudRunSnapshot.self, from: $0) }
        var replay = Replay(events: [], cursor: snapshot?.lastEventId ?? 0, byteCount: 0, snapshot: snapshotData)
        guard let data = try? Data(contentsOf: eventsURL(runID)) else { return replay }
        var start = data.startIndex
        while let newline = data[start...].firstIndex(of: 10) {
            guard let record = try? JSONDecoder().decode(WireRecord.self, from: Data(data[start..<newline])),
                  let envelope = try? JSONDecoder().decode(Envelope.self, from: record.data),
                  envelope.type == "run.event", envelope.runId == runID,
                  envelope.id > 0, envelope.id <= 9_007_199_254_740_991 else { break }
            if envelope.id > replay.cursor {
                replay.events.append(record.data)
                replay.cursor = envelope.id
            }
            start = data.index(after: newline)
            replay.byteCount = UInt64(start)
        }
        return replay
    }

    func checkpoint(_ data: Data, runID: String) throws {
        guard !closed else { throw Failure.writeFailed }
        let snapshot = try JSONDecoder().decode(CloudRunSnapshot.self, from: data)
        guard snapshot.run.id == runID else { throw Failure.invalidEvent }
        _ = try snapshot.presentationEvents()
        try prepareDirectory()
        // Write snapshot before unlinking log since replay ignores covered entries.
        try data.write(to: snapshotURL(runID), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try Data().write(to: eventsURL(runID), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        cursors[runID] = snapshot.lastEventId
        blocked.remove(runID)
    }
    private func snapshotURL(_ runID: String) -> URL {
        directory.appendingPathComponent(CloudReplicaScope.digest(runID)).appendingPathExtension("snapshot")
    }

    /// Remove journal only after persisting terminal turn projection.
    func remove(runID: String) throws {
        for url in [eventsURL(runID), metadataURL(runID), snapshotURL(runID)] where FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        cursors.removeValue(forKey: runID)
        blocked.remove(runID)
    }

    /// Closing prevents late detached readers from recreating signed-out data.
    func erase() throws {
        closed = true
        cursors.removeAll(); blocked.removeAll()
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
    }
    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                               ofItemAtPath: directory.path)
    }
    private func eventsURL(_ runID: String) -> URL {
        directory.appendingPathComponent(CloudReplicaScope.digest(runID)).appendingPathExtension("ndjson")
    }
    private func metadataURL(_ runID: String) -> URL {
        directory.appendingPathComponent(CloudReplicaScope.digest(runID)).appendingPathExtension("json")
    }
}
