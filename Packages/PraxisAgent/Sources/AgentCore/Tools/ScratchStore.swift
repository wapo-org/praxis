import Foundation
import Synchronization

/// Durable per-conversation files for runtime state that must outlive a
/// launch: spilled tool output (`read_tool_output`) and the JS `kv` store.
///
/// Layout: `root/<conversation>/<name>`. The total size is capped; when a
/// write goes over, the least recently used files go first (any
/// conversation, never the file just written). Reads count as use.
/// Deleting a conversation removes its directory (`remove(conversationID:)`).
///
/// Names are plain file names chosen by the runtime; conversation ids
/// that aren't plain names are hashed, so nothing escapes `root`.
public final class ScratchStore: Sendable {
    public let root: URL
    public let maxTotalBytes: Int
    public let maxFileBytes: Int
    /// e.g. `[.atomic, .completeFileProtectionUntilFirstUserAuthentication]` on iOS.
    public let writingOptions: Data.WritingOptions

    private struct Entry {
        var size: Int
        var used: Date
    }

    /// Scanned from disk on first use.
    private let index = Mutex<[String: Entry]?>(nil)

    public enum StoreError: Error, Equatable {
        case tooLarge(bytes: Int, limit: Int)
        case invalidName(String)
    }

    public init(root: URL, maxTotalBytes: Int = 128 << 20, maxFileBytes: Int = 16 << 20,
                writingOptions: Data.WritingOptions = [.atomic]) {
        self.root = root
        self.maxTotalBytes = maxTotalBytes
        self.maxFileBytes = min(maxFileBytes, maxTotalBytes)
        self.writingOptions = writingOptions
    }

    public func write(_ data: Data, conversationID: String, name: String) throws {
        guard Self.isPlainName(name) else { throw StoreError.invalidName(name) }
        guard data.count <= maxFileBytes else { throw StoreError.tooLarge(bytes: data.count, limit: maxFileBytes) }
        let directory = self.directory(for: conversationID)
        let key = Self.key(directory.lastPathComponent, name)
        try index.withLock { index in
            var entries = index ?? scan()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: directory.appending(path: name, directoryHint: .notDirectory), options: writingOptions)
            entries[key] = Entry(size: data.count, used: Date())
            evict(&entries, keeping: key)
            index = entries
        }
    }

    public func read(conversationID: String, name: String) -> Data? {
        guard Self.isPlainName(name) else { return nil }
        let directory = self.directory(for: conversationID)
        let url = directory.appending(path: name, directoryHint: .notDirectory)
        let key = Self.key(directory.lastPathComponent, name)
        return index.withLock { index -> Data? in
            var entries = index ?? scan()
            defer { index = entries }
            guard let data = try? Data(contentsOf: url) else {
                entries[key] = nil
                return nil
            }
            let now = Date()
            entries[key] = Entry(size: data.count, used: now)
            try? FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: url.path)
            return data
        }
    }

    public func remove(conversationID: String, name: String) {
        guard Self.isPlainName(name) else { return }
        let directory = self.directory(for: conversationID)
        index.withLock { index in
            var entries = index ?? scan()
            try? FileManager.default.removeItem(at: directory.appending(path: name, directoryHint: .notDirectory))
            entries[Self.key(directory.lastPathComponent, name)] = nil
            index = entries
        }
    }

    /// Everything stored for a conversation (e.g. when it's deleted).
    public func remove(conversationID: String) {
        let directory = self.directory(for: conversationID)
        let prefix = directory.lastPathComponent + "/"
        index.withLock { index in
            var entries = index ?? scan()
            try? FileManager.default.removeItem(at: directory)
            entries = entries.filter { !$0.key.hasPrefix(prefix) }
            index = entries
        }
    }

    /// Drops directories of conversations that no longer exist.
    public func removeAll(except conversationIDs: Set<String>) {
        let keep = Set(conversationIDs.map { Self.directoryName(for: $0) })
        index.withLock { index in
            var entries = index ?? scan()
            let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
            for dir in dirs where !keep.contains(dir.lastPathComponent) {
                try? FileManager.default.removeItem(at: dir)
                entries = entries.filter { !$0.key.hasPrefix(dir.lastPathComponent + "/") }
            }
            index = entries
        }
    }

    public var totalBytes: Int {
        index.withLock { index in
            let entries = index ?? scan()
            index = entries
            return entries.values.reduce(0) { $0 + $1.size }
        }
    }

    // MARK: Internals

    func directory(for conversationID: String) -> URL {
        root.appending(path: Self.directoryName(for: conversationID), directoryHint: .isDirectory)
    }

    static func directoryName(for conversationID: String) -> String {
        isPlainName(conversationID) && !conversationID.hasPrefix(".")
            ? conversationID
            : "h-" + String(ToolName.stableHash(conversationID), radix: 36)
    }

    /// `[A-Za-z0-9._-]{1,128}`, not `.` or `..`.
    static func isPlainName(_ name: String) -> Bool {
        guard !name.isEmpty, name.utf8.count <= 128, name != ".", name != ".." else { return false }
        return name.utf8.allSatisfy { b in
            (48...57).contains(b) || (65...90).contains(b) || (97...122).contains(b) || b == 45 || b == 46 || b == 95
        }
    }

    private static func key(_ directory: String, _ name: String) -> String { directory + "/" + name }

    private func scan() -> [String: Entry] {
        var entries: [String: Entry] = [:]
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        let dirs = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        for dir in dirs {
            let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys)) ?? []
            for file in files {
                guard let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
                entries[Self.key(dir.lastPathComponent, file.lastPathComponent)] =
                    Entry(size: values.fileSize ?? 0, used: values.contentModificationDate ?? .distantPast)
            }
        }
        return entries
    }

    private func evict(_ entries: inout [String: Entry], keeping kept: String) {
        var total = entries.values.reduce(0) { $0 + $1.size }
        guard total > maxTotalBytes else { return }
        for (key, entry) in entries.sorted(by: { $0.value.used < $1.value.used }) where key != kept {
            let url = root.appending(path: key, directoryHint: .notDirectory)
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                // A failed delete keeps its accounting so the next write
                // retries eviction — unless the file is already gone, in
                // which case the index entry was stale and is dropped.
                if FileManager.default.fileExists(atPath: url.path) { continue }
            }
            entries[key] = nil
            total -= entry.size
            if total <= maxTotalBytes { break }
        }
    }
}
