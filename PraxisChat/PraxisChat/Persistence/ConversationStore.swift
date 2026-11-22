import Foundation
import AgentCore

/// Serializes writes in-order at commit points (never per token) so snapshots never reorder.
actor ConversationStore {
    struct Index: Codable, Sendable, Equatable {
        struct Entry: Codable, Sendable, Equatable {
            var id: UUID
            var title: String
            var updatedAt: Date
            var isPinned: Bool
        }
        var version = 1
        var conversations: [Entry] = []
        var policy = ToolPolicy()
    }

    struct Snapshot: Sendable {
        var conversations: [ConversationRecord]
        var policy: ToolPolicy
    }

    private enum Operation: Sendable {
        case save(ConversationRecord)
        case batch([ConversationRecord], Index)
        case saveIndex(Index)
        case delete([UUID])
        case barrier(CheckedContinuation<Void, Never>)
    }

    nonisolated let directory: URL
    private nonisolated let queue: AsyncStream<Operation>.Continuation
    /// Counts real writes (excluding barriers) so flush() detects a quiet queue vs active Tasks.
    private var performedWrites = 0

    init(directory: URL) {
        self.directory = directory
        let (stream, continuation) = AsyncStream.makeStream(of: Operation.self)
        self.queue = continuation
        Task { [weak self] in
            for await operation in stream {
                guard let self else { break }
                await self.perform(operation)
            }
        }
    }

    deinit { queue.finish() }

    // MARK: Writes (queued, in order)

    nonisolated func saveBatch(_ records: [ConversationRecord], index: Index) { queue.yield(.batch(records, index)) }

    nonisolated func save(_ record: ConversationRecord) { queue.yield(.save(record)) }
    nonisolated func saveIndex(_ index: Index) { queue.yield(.saveIndex(index)) }
    nonisolated func delete(_ ids: [UUID]) { queue.yield(.delete(ids)) }

    /// Repeats bounded barriers until three see no new writes, letting pending Tasks enqueue first.
    func flush() async {
        var quiet = 0
        var settled = performedWrites
        for _ in 0..<30 {
            await withCheckedContinuation { queue.yield(.barrier($0)) }
            if performedWrites == settled {
                quiet += 1
                if quiet == 3 { return }
            } else {
                quiet = 0
                settled = performedWrites
            }
            try? await Task.sleep(for: .milliseconds(5))
        }
    }

    private func perform(_ operation: Operation) {
        switch operation {
        case .batch(let records, let index):
            for record in records { performedWrites += 1; write(record, to: fileURL(for: record.id)) }
            performedWrites += 1
            write(index, to: indexURL)
        case .save(let record):
            performedWrites += 1
            write(record, to: fileURL(for: record.id))
        case .saveIndex(let index):
            performedWrites += 1
            write(index, to: indexURL)
        case .delete(let ids):
            performedWrites += 1
            for id in ids { try? FileManager.default.removeItem(at: fileURL(for: id)) }
        case .barrier(let continuation):
            continuation.resume()
        }
    }

    private func write<T: Encodable>(_ value: T, to url: URL) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            // Best effort: a write must not fail over directory attributes.
            try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                                   ofItemAtPath: directory.path)
            try Self.encoder.encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            // Drop writes racing a deleted directory; assert other write failures in Debug.
            if isDirectoryGone(error) { return }
            assertionFailure("ConversationStore write failed: \(error)")
        }
    }

    private func isDirectoryGone(_ error: Error) -> Bool {
        var current: Error? = error
        for _ in 0..<8 {
            guard let ns = current as NSError? else { break }
            if ns.domain == NSPOSIXErrorDomain, ns.code == Int(ENOENT) || ns.code == Int(ENOTDIR) { return true }
            if ns.domain == NSCocoaErrorDomain, ns.code == NSFileNoSuchFileError { return true }
            current = ns.userInfo[NSUnderlyingErrorKey] as? Error
        }
        return !FileManager.default.fileExists(atPath: directory.path)
    }

    // MARK: Reads

    /// Returns nil only when no index exists (triggers seeding); corrupt files are skipped.
    nonisolated func load() -> Snapshot? {
        guard let data = try? Data(contentsOf: indexURL),
              let index = try? Self.decoder.decode(Index.self, from: data) else { return nil }
        let records = index.conversations.compactMap { entry -> ConversationRecord? in
            guard let data = try? Data(contentsOf: fileURL(for: entry.id)) else {
                // Indexed before its first turn was written: still a chat.
                return ConversationRecord(id: entry.id, title: entry.title, updatedAt: entry.updatedAt,
                                          isPinned: entry.isPinned, turns: [])
            }
            return try? Self.decoder.decode(ConversationRecord.self, from: data)
        }
        return Snapshot(conversations: records, policy: index.policy)
    }

    nonisolated var indexURL: URL { directory.appendingPathComponent("index.json") }

    nonisolated func fileURL(for id: UUID) -> URL {
        directory.appendingPathComponent(id.uuidString).appendingPathExtension("json")
    }

    // Fresh coder per use avoids shared mutable state between actor and nonisolated load().
    private static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }

    private static var decoder: JSONDecoder { JSONDecoder() }
}

extension ConversationRecord {
    /// Clears in-flight run/stream/approval state after app kill and folds finished activity.
    func settledAfterRelaunch() -> ConversationRecord {
        var record = self
        for t in record.turns.indices {
            var turn = record.turns[t]
            if turn.isRunning || !turn.isFinished {
                turn.isRunning = false
                turn.isFinished = true
                if turn.outcome == nil { turn.outcome = .stopped }
            }
            turn.blocks.removeAll { if case .markdown(_, let source, true) = $0 { return source.isEmpty }; return false }
            for b in turn.blocks.indices {
                if case .markdown(let id, let source, true) = turn.blocks[b] {
                    turn.blocks[b] = .markdown(id: id, source: source, isStreaming: false)
                }
                turn.updateActivity(at: b) { activity in
                    if activity.isRunning {
                        activity.isRunning = false
                        activity.isStopped = true
                    }
                    for s in activity.steps.indices where activity.steps[s].isRunning {
                        activity.steps[s].status = .cancelled
                        activity.steps[s].approval = nil
                        activity.steps[s].codeApprovals = []
                        activity.steps[s].command?.isRunning = false
                    }
                    if activity.userExpanded == nil { activity.isExpanded = false }
                }
            }
            record.turns[t] = turn
        }
        return record
    }
}
