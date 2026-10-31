import Foundation
import Observation

/// A verified bearer identity selects the namespace. A cached identity is
/// painted only when its token fingerprint matches the current credential.
@MainActor
@Observable
final class CloudAccountReplica {
    private(set) var error: String?
    private(set) var userID: String?
    private let root: URL
    private let client: CloudAPIClient
    private weak var store: ChatStore?
    private var isBackgrounded = false
    private var generation = UUID()
    private var task: Task<Void, Never>?
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
        do {
            guard let token = try await client.tokens.token(for: client.configuration.origin),
                  let data = try? Data(contentsOf: identityURL),
                  let identity = try? JSONDecoder().decode(Identity.self, from: data),
                  identity.tokenHash == CloudReplicaScope.digest(token) else { return }
            guard userID == nil else { return }
            try select(identity.userID)
        } catch { self.error = error.localizedDescription }
    }
    func sessionChanged(_ user: CloudUser?) {
        generation = UUID(); task?.cancel()
        guard let user else {
            userID = nil; directory = nil; replica = CloudCursorReplica()
            if let lifecycle { Task { await lifecycle.detachAll() } }
            lifecycle = nil
            store?.clearCloudReplica()
            try? FileManager.default.removeItem(at: identityURL)
            return
        }
        do { if userID != user.id { try select(user.id) } }
        catch { self.error = error.localizedDescription; return }
        let revision = generation
        task = Task {
            do {
                if let token = try await client.tokens.token(for: client.configuration.origin) {
                    guard generation == revision else { return }
                    try FileManager.default.createDirectory(at: identityURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try JSONEncoder().encode(Identity(userID: user.id, tokenHash: CloudReplicaScope.digest(token)))
                        .write(to: identityURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                }
                try await reconcile(revision: revision)
            } catch { if generation == revision, !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
    private func select(_ id: String) throws {
        let directory = CloudReplicaScope.directory(root: root, origin: client.configuration.origin, userID: id)
        // Clear the previous account before any fallible disk read. A corrupt
        // new namespace must fail closed rather than leave the old chats visible.
        if let lifecycle { Task { await lifecycle.detachAll() } }
        lifecycle = nil; userID = nil; self.directory = nil
        store?.clearCloudReplica()
        let replica = try CloudCursorReplica.load(directory.appendingPathComponent("replica.json"))
        self.userID = id; self.directory = directory; self.replica = replica
        guard let store else { return }
        let lifecycle = CloudLifecycleEngine(client: client, journal: CloudRunJournal(directory: directory), elicitations: store.cloudElicitations, backgrounded: isBackgrounded,
            onRunStarted: { [weak store] conversation, turn, run in
                await store?.recordCloudRun(conversationID: conversation, turnID: turn, runID: run)
            })
        self.lifecycle = lifecycle
        store.installCloudPersistence(ConversationStore(directory: directory.appendingPathComponent("Conversations")), engine: lifecycle)
        try store.applyCloudReplica(replica)
        if store.conversations.isEmpty { store.newChat() }
    }
    func foreground() {
        isBackgrounded = false
        guard userID != nil else { return }
        task?.cancel()
        let revision = generation
        task = Task {
            do {
                try Task.checkCancellation()
                let session = try await client.currentSession()
                guard generation == revision, !Task.isCancelled else { return }
                if userID == session.user.id, let lifecycle { await lifecycle.setBackgrounded(false) }
                guard generation == revision, !Task.isCancelled else { return }
                sessionChanged(session.user)
            } catch {
                guard generation == revision, !Task.isCancelled else { return }
                if (error as? CloudAPIError)?.statusCode == 401 { sessionChanged(nil) }
                else if !Task.isCancelled { self.error = error.localizedDescription }
            }
        }
    }
    func background() { isBackgrounded = true; if let lifecycle { Task { await lifecycle.setBackgrounded(true) } } }
    func waitForSync() async { await task?.value }
    private func reconcile(revision: UUID) async throws {
        guard let directory else { return }
        let _: CloudCursorReplica.Root = try await client.send("/v1/sync/root")
        var seen = Set<String>()
        repeat {
            try Task.checkCancellation()
            let body = try JSONEncoder().encode(CloudCursorReplica.Request(cursor: replica.cursor))
            let page: CloudCursorReplica.Page = try await client.send("/v1/sync/pull", method: "POST", body: body)
            guard generation == revision else { return }
            try replica.apply(page, file: directory.appendingPathComponent("replica.json"))
            try store?.applyCloudReplica(replica)
            if let lifecycle { try await store?.resumeCloudRuns(replica, engine: lifecycle) }
            guard generation == revision else { return }
            guard let cursor = page.nextCursor else { break }
            guard seen.insert(cursor).inserted else { throw CloudSettingsError.repeatedCursor }
        } while true
        error = nil
    }
}
