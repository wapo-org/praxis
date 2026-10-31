import Foundation
import Observation

/// A verified bearer identity selects the namespace. Cached UI paints before
/// network verification; disk cleanup is serialized with subsequent sign-in.
@MainActor
@Observable
final class CloudAccountReplica {
    private(set) var error: String?
    private(set) var userID: String?
    private let root: URL
    private let client: CloudAPIClient
    private let disk = CloudReplicaDisk()
    private weak var store: ChatStore?
    private var isBackgrounded = false
    private var generation = UUID()
    private var task: Task<Void, Never>?
    private var cleanup: Task<Void, Never>?
    private var replica = CloudCursorReplica()
    private var directory: URL?
    private(set) var lifecycle: CloudLifecycleEngine?
    private struct Identity: Codable { let userID: String; let tokenHash: String }
    private var identityURL: URL {
        root.appendingPathComponent("Cloud/" + CloudReplicaScope.digest(client.configuration.origin) + ".identity")
    }
    init(store: ChatStore, client: CloudAPIClient, root: URL) { self.store = store; self.client = client; self.root = root }

    func restoreBeforeNetwork() async {
        guard userID == nil else { return }
        let revision = generation
        await cleanup?.value
        do {
            guard let token = try await client.tokens.token(for: client.configuration.origin),
                  let data = await disk.read(identityURL),
                  let identity = try? JSONDecoder().decode(Identity.self, from: data),
                  identity.tokenHash == CloudReplicaScope.digest(token),
                  generation == revision, userID == nil else { return }
            store?.clearCloudReplica()
            try await select(identity.userID, revision: revision)
        } catch { if generation == revision { self.error = error.localizedDescription } }
    }
    func sessionChanged(_ user: CloudUser?) {
        let previous = task
        previous?.cancel()
        generation = UUID()
        let revision = generation
        let oldLifecycle = lifecycle
        let oldDirectory = directory
        let persistence = store?.cloudPersistenceForCleanup
        guard let user else {
            userID = nil; directory = nil; replica = CloudCursorReplica(); lifecycle = nil
            store?.clearCloudReplica()
            let priorCleanup = cleanup
            let identityURL = identityURL, disk = disk
            let work = Task {
                // Block late journal writes first, then drain queued persistence.
                await oldLifecycle?.eraseAccountJournal()
                await previous?.value
                await priorCleanup?.value
                await persistence?.flush()
                do {
                    if let oldDirectory { try await disk.remove(oldDirectory) }
                    try await disk.remove(identityURL)
                } catch { if self.generation == revision { self.error = error.localizedDescription } }
            }
            cleanup = work; task = work
            return
        }
        let changed = userID != user.id
        if changed {
            userID = nil; directory = nil; lifecycle = nil
            store?.clearCloudReplica()
        }
        let priorCleanup = cleanup
        task = Task {
            await priorCleanup?.value
            await previous?.value
            guard generation == revision, !Task.isCancelled else { return }
            do {
                if changed {
                    await oldLifecycle?.detachAll()
                    try await select(user.id, revision: revision)
                }
                guard generation == revision, !Task.isCancelled else { return }
                if let token = try await client.tokens.token(for: client.configuration.origin) {
                    guard generation == revision else { return }
                    try await disk.write(JSONEncoder().encode(Identity(userID: user.id, tokenHash: CloudReplicaScope.digest(token))), to: identityURL)
                }
                try await reconcile(revision: revision)
            } catch { if generation == revision, !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
    private func select(_ id: String, revision: UUID) async throws {
        let directory = CloudReplicaScope.directory(root: root, origin: client.configuration.origin, userID: id)
        let replica = try await disk.load(directory.appendingPathComponent("replica.json"))
        let projection = try await disk.project(replica)
        guard generation == revision, !Task.isCancelled, let store else { return }
        self.userID = id; self.directory = directory; self.replica = replica
        let lifecycle = CloudLifecycleEngine(client: client, journal: CloudRunJournal(directory: directory), elicitations: store.cloudElicitations, backgrounded: isBackgrounded,
            onRunStarted: { [weak store] conversation, turn, run in
                await store?.recordCloudRun(conversationID: conversation, turnID: turn, runID: run)
            })
        self.lifecycle = lifecycle
        store.installCloudPersistence(ConversationStore(directory: directory.appendingPathComponent("Conversations")), engine: lifecycle)
        store.applyCloudProjection(projection)
        if store.conversations.isEmpty { store.newChat() }
    }
    func foreground() {
        isBackgrounded = false
        guard userID != nil else { return }
        task?.cancel()
        let revision = generation
        task = Task {
            // Journal catchup must not depend on session endpoint availability.
            await lifecycle?.setBackgrounded(false)
            for attempt in 0..<4 {
                guard generation == revision, !isBackgrounded, !Task.isCancelled else { return }
                do {
                    let session = try await client.currentSession()
                    guard generation == revision, !isBackgrounded, !Task.isCancelled else { return }
                    guard userID == session.user.id else {
                        sessionChanged(nil)
                        await store?.cloudServices?.reload()
                        return
                    }
                    try await reconcile(revision: revision)
                    return
                } catch {
                    guard generation == revision, !Task.isCancelled else { return }
                    if (error as? CloudAPIError)?.statusCode == 401 { sessionChanged(nil); return }
                    self.error = error.localizedDescription
                    guard attempt < 3 else { return }
                    do { try await Task.sleep(for: .milliseconds(250 * (1 << attempt))) } catch { return }
                }
            }
        }
    }
    func background() {
        isBackgrounded = true
        if let lifecycle { Task { await lifecycle.setBackgrounded(true) } }
    }
    func waitForSync() async { await task?.value; await task?.value; await cleanup?.value }
    private func reconcile(revision: UUID) async throws {
        guard let directory else { return }
        let _: CloudCursorReplica.Root = try await client.send("/v1/sync/root")
        var seen = Set<String>(), changed = Set<String>()
        repeat {
            try Task.checkCancellation()
            let body = try JSONEncoder().encode(CloudCursorReplica.Request(cursor: replica.cursor))
            let page: CloudCursorReplica.Page = try await client.send("/v1/sync/pull", method: "POST", body: body)
            guard generation == revision else { return }
            let (next, changes) = try await disk.apply(page, to: replica, file: directory.appendingPathComponent("replica.json"))
            guard generation == revision, !Task.isCancelled else { return }
            replica = next; changed.formUnion(changes)
            guard let cursor = page.nextCursor else { break }
            guard seen.insert(cursor).inserted else { throw CloudSettingsError.repeatedCursor }
        } while true
        let projection = try await disk.project(replica, changedChatIDs: changed)
        guard generation == revision, !Task.isCancelled else { return }
        store?.applyCloudProjection(projection)
        if let lifecycle { try await store?.resumeCloudRuns(projection.runs, engine: lifecycle, client: client) }
        guard generation == revision else { return }
        error = nil
    }
}
