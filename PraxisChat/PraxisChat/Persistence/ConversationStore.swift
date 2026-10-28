import Foundation
import AgentCore

/// Conversations on disk: one JSON file per conversation plus an index
/// (order, titles, pins, tool policy). The store only writes when the app
/// reaches a commit point — a block closed, a turn finished or stopped,
/// a thread edited — never per streamed token.
///
/// Writes are queued in order through one stream and applied on the
/// actor, so a later snapshot can never be overtaken by an earlier one.
/// Reads are synchronous (`load()`), used once at launch.
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
        case saveIndex(Index)
        case delete([UUID])
        case barrier(CheckedContinuation<Void, Never>)
    }

    nonisolated let directory: URL
    private nonisolated let queue: AsyncStream<Operation>.Continuation
    /// Writes performed so far (barriers excluded). `flush` watches it
    /// to tell a quiet queue from one a Task is still feeding.
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

    nonisolated func save(_ record: ConversationRecord) { queue.yield(.save(record)) }
    nonisolated func saveIndex(_ index: Index) { queue.yield(.saveIndex(index)) }
    nonisolated func delete(_ ids: [UUID]) { queue.yield(.delete(ids)) }

    /// Returns once the queue is empty and stays empty (tests).
    /// Barriers are repeated, pausing between rounds so Tasks that are
    /// about to enqueue get a chance to run, until three barriers in a
    /// row see no new write. Bounded, so a live run can't stall the
    /// caller; afterwards `tearDown` owns the directory again.
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
            // A queued write racing a deleted directory (a test removing
            // its temp folder, the container going away mid-write) has
            // nowhere to land: drop it. Anything else still asserts in
            // Debug, where a failing write is a bug worth catching.
            if isDirectoryGone(error) { return }
            assertionFailure("ConversationStore write failed: \(error)")
        }
    }

    /// Whether the write failed because its directory is gone: a
    /// missing (or not-a-) directory anywhere in the error chain, or
    /// the folder simply not being there anymore.
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

    /// Everything on disk, in index order; nil on first launch (no index
    /// yet), which is when the demo conversations get seeded. Files that
    /// fail to decode are skipped rather than taking the app down.
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

    // Fresh coders per use: cheap next to the file I/O, and no shared
    // mutable state between the actor and the nonisolated reader.
    private static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys]
        return e
    }

    private static var decoder: JSONDecoder { JSONDecoder() }
}

extension ConversationRecord {
    /// A thread saved mid-run (the app was killed or suspended for good)
    /// comes back settled: nothing running, nothing streaming, no card
    /// waiting on an approval nobody can deliver, finished activity folded.
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
