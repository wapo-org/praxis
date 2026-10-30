import CryptoKit
import Foundation

/// Local replicas and journals are scoped by verified account and server. The
/// last account's cached UI may paint before session validation; it is never
/// reconciled into another account's store.
enum CloudReplicaScope {
    static func directory(root: URL, origin: String, userID: String) -> URL {
        root.appendingPathComponent("Cloud", isDirectory: true)
            .appendingPathComponent(digest(origin + "\n" + userID), isDirectory: true)
    }

    /// Cloud resource ids are opaque; a deterministic local UUID preserves the
    /// existing SwiftUI/persistence identity without requiring UUID server ids.
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

/// The wire log is written BEFORE presentation events enter the coalescer. On
/// relaunch a fresh reducer replays this log, then SSE resumes after its last
/// complete record. A partial final write is discarded, so an acknowledged
/// cursor can never outrun the durable projection used to rebuild the UI.
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

    init(directory: URL) { self.directory = directory.appendingPathComponent("Runs", isDirectory: true) }

    func register(_ record: Record) throws {
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

    func append(_ data: Data, runID: String) throws {
        guard !blocked.contains(runID) else { throw Failure.writeFailed }
        let header = try JSONDecoder().decode(Envelope.self, from: data)
        guard header.type == "run.event", header.runId == runID, header.id > 0,
              header.id <= 9_007_199_254_740_991 else { throw Failure.invalidEvent }
        // Codable base64 framing preserves the original bytes and all unknown
        // fields, including multi-line JSON, without a dynamic JSON parser.
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
            guard header.id > (cursors[runID] ?? 0) else { return }
            if !FileManager.default.fileExists(atPath: url.path) {
                try Data().write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
            let file = try FileHandle(forWritingTo: url)
            defer { try? file.close() }
            try file.seekToEnd()
            try file.write(contentsOf: line)
            cursors[runID] = header.id
        } catch {
            // Do not append a later cursor after a failed record: it would
            // create a gap that could not be recovered by Last-Event-ID.
            blocked.insert(runID)
            throw error
        }
    }

    func replay(runID: String) -> Replay {
        guard let data = try? Data(contentsOf: eventsURL(runID)) else {
            return Replay(events: [], cursor: 0, byteCount: 0)
        }
        var replay = Replay(events: [], cursor: 0, byteCount: 0)
        var start = data.startIndex
        while let newline = data[start...].firstIndex(of: 10) {
            guard let record = try? JSONDecoder().decode(WireRecord.self, from: Data(data[start..<newline])),
                  let envelope = try? JSONDecoder().decode(Envelope.self, from: record.data),
                  envelope.type == "run.event", envelope.runId == runID,
                  envelope.id > replay.cursor, envelope.id <= 9_007_199_254_740_991 else { break }
            replay.events.append(record.data)
            replay.cursor = envelope.id
            start = data.index(after: newline)
            replay.byteCount = UInt64(start)
        }
        return replay
    }

    /// Call only after the terminal turn projection has been persisted. Keeping
    /// a journal longer is safe; deleting it before that commit loses recovery.
    func remove(runID: String) throws {
        for url in [eventsURL(runID), metadataURL(runID)] where FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.removeItem(at: url)
        }
        cursors.removeValue(forKey: runID)
        blocked.remove(runID)
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
