import Foundation
import Synchronization

/// Attachment bytes, keyed by attachment id. Models only ever carry the
/// id: composer attachments are staged in memory, and sending a turn
/// writes its attachments to disk (`persist`), so unsent picks and the
/// demo screenshot tiles never touch the file system.
final class AttachmentStore: Sendable {
    static let shared = AttachmentStore(directory: AppDirectories.attachments)

    let directory: URL
    private let staged = Mutex<[UUID: Data]>([:])
    /// Recently read files; thumbnails decode once, but the photo viewer
    /// and the engine may read the same bytes again.
    private let recent = Mutex<[UUID: Data]>([:])
    /// Serializes disk writes and deletes (R3-M4): `persist` queues its
    /// writes here, `remove` deletes through it, so a write can never
    /// land after a later `remove` and resurrect the file. Never call
    /// `remove` from this queue (it deletes synchronously).
    private let io = DispatchQueue(label: "AttachmentStore.io", qos: .utility)

    init(directory: URL) {
        self.directory = directory
    }

    func stage(_ data: Data, id: UUID) {
        staged.withLock { $0[id] = data }
    }

    func data(for id: UUID) -> Data? {
        if let hit = staged.withLock({ $0[id] }) ?? recent.withLock({ $0[id] }) { return hit }
        guard let data = try? Data(contentsOf: url(for: id)) else { return nil }
        recent.withLock { cache in
            if cache.count >= 32 { cache.removeAll(keepingCapacity: true) }
            cache[id] = data
        }
        return data
    }

    /// Writes staged bytes for `ids` to disk off the main thread. Bytes
    /// stay readable from memory until the write lands.
    func persist(_ ids: [UUID]) {
        let pending = staged.withLock { s in ids.compactMap { id in s[id].map { (id, $0) } } }
        guard !pending.isEmpty else { return }
        let directory = directory
        io.async { [self] in
            Self.ensureDirectory(directory)
            for (id, data) in pending {
                if (try? data.write(to: url(for: id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil {
                    staged.withLock { _ = $0.removeValue(forKey: id) }
                }
            }
        }
    }

    /// Forgets `ids` everywhere. A barrier for `persist`: writes queued
    /// before this call have all landed (and been deleted) when it
    /// returns, so nothing queued earlier can resurrect a file.
    func remove(_ ids: [UUID]) {
        staged.withLock { s in ids.forEach { s.removeValue(forKey: $0) } }
        recent.withLock { s in ids.forEach { s.removeValue(forKey: $0) } }
        io.sync {
            for id in ids {
                try? FileManager.default.removeItem(at: url(for: id))
                try? FileManager.default.removeItem(at: sidecarURL(for: id))
            }
        }
    }

    /// Forgets every attachment (account sign-out). Same barrier as `remove`.
    func removeAll() {
        staged.withLock { $0.removeAll() }
        recent.withLock { $0.removeAll() }
        io.sync { try? FileManager.default.removeItem(at: directory) }
    }

    /// Creates the directory with Data Protection (R3-M2). Best effort
    /// on the attributes: a write must not fail over them.
    private static func ensureDirectory(_ directory: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                                               ofItemAtPath: directory.path)
    }

    /// Bytes exist for `id` (staged or on disk), without reading them.
    func contains(_ id: UUID) -> Bool {
        staged.withLock { $0[id] != nil } || recent.withLock { $0[id] != nil }
            || FileManager.default.fileExists(atPath: url(for: id).path)
    }

    func url(for id: UUID) -> URL {
        directory.appendingPathComponent(id.uuidString).appendingPathExtension("bin")
    }

    // MARK: Model sidecars

    /// The exact bytes sent to the model for an attachment, when they
    /// differ from the original (e.g. a HEIC photo re-encoded as JPEG).
    /// Kept so every later request replays identical bytes.
    func sidecar(for id: UUID) -> Data? {
        try? Data(contentsOf: sidecarURL(for: id))
    }

    func setSidecar(_ data: Data, for id: UUID) {
        Self.ensureDirectory(directory)
        try? data.write(to: sidecarURL(for: id), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func sidecarURL(for id: UUID) -> URL {
        directory.appendingPathComponent(id.uuidString).appendingPathExtension("model.bin")
    }
}

/// Application Support layout. Everything the app keeps lives under one
/// folder so `-PraxisResetData YES` (UI tests) can wipe it in one go.
enum AppDirectories {
    static let root: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("PraxisChat", isDirectory: true)
    }()

    static var conversations: URL { root.appendingPathComponent("Conversations", isDirectory: true) }
    static var attachments: URL { root.appendingPathComponent("Attachments", isDirectory: true) }
    /// Provider profiles (no keys: those are Keychain items).
    static var providers: URL { root.appendingPathComponent("Providers.json") }
    /// Installed MCP servers + protocol-era cache (no secrets).
    static var connectors: URL { root.appendingPathComponent("Connectors.json") }
    static var importedSkills: URL { root.appendingPathComponent("Skills", isDirectory: true) }
    /// Skill registries the user added (built-in ones aren't stored).
    static var skillRegistries: URL { root.appendingPathComponent("SkillRegistries.json") }
    /// Registry listings (re-fetchable; kept to spare GitHub's rate limit).
    static var skillRegistryCache: URL {
        (FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ?? root)
            .appendingPathComponent("PraxisChat/SkillRegistries", isDirectory: true)
    }
    /// Provider hosts the user allowed to receive chat data.
    static var consent: URL { root.appendingPathComponent("Consent.json") }
    /// Groq voice settings: selected model, cached model list, language
    /// (no key: that is a Keychain item). Owned by `GroqVoiceSettings`.
    static var voiceSettings: URL { root.appendingPathComponent("voice-settings.json") }
    /// Per-conversation runtime state: spilled tool output, JS `kv`.
    static var runtimeScratch: URL { root.appendingPathComponent("RuntimeScratch", isDirectory: true) }

    static func reset() {
        try? FileManager.default.removeItem(at: root)
    }
}
