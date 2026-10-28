import Foundation
import Observation
import AgentCore
import AgentSkills

/// The app's skills: imported ones in Application Support (no bundled
/// directory yet). New conversations freeze the catalog at first send;
/// skills imported later are announced to running conversations by the
/// runtime's turn notes.
///
/// Part B's UI binds to `skills` / `problems` and calls `importSkill(from:)`
/// (a document-picker or share-sheet URL) and `remove(_:)`.
@MainActor
@Observable
final class SkillLibrary {
    private(set) var skills: [Skill] = []
    private(set) var problems: [SkillLoadProblem] = []
    /// Registries the user added; `registries` puts the built-in ones first.
    private(set) var customRegistries: [SkillRegistry] = []
    /// Installed registry skills with newer content, by skill name.
    private(set) var updates: [String: RegistryUpdate] = [:]
    private(set) var checkingUpdates = false

    @ObservationIgnored let store: SkillStore
    @ObservationIgnored let registryClient: SkillRegistryClient
    @ObservationIgnored private let registriesFileURL: URL?

    init(store: SkillStore, registryClient: SkillRegistryClient = SkillRegistryClient(), registriesFileURL: URL? = nil) {
        self.store = store
        self.registryClient = registryClient
        self.registriesFileURL = registriesFileURL
        if let registriesFileURL, let data = try? Data(contentsOf: registriesFileURL),
           let saved = try? JSONDecoder().decode([SkillRegistry].self, from: data) {
            customRegistries = saved.filter { !$0.isBuiltIn }
        }
    }

    convenience init(importedDirectory: URL, bundledDirectory: URL? = nil, registriesFileURL: URL? = nil,
                     registryCache: URL? = nil, transport: any HTTPTransport = URLSessionTransport()) {
        self.init(store: SkillStore(bundledDirectory: bundledDirectory, importedDirectory: importedDirectory),
                  registryClient: SkillRegistryClient(transport: transport, cacheDirectory: registryCache),
                  registriesFileURL: registriesFileURL)
    }

    var registries: [SkillRegistry] { SkillRegistry.builtIns + customRegistries }

    func registry(id: String?) -> SkillRegistry? { registries.first { $0.id == id } }

    func reload() async {
        await store.reload()
        await refresh()
    }

    /// Imports a folder or `.zip` / `.skill` archive. Picker URLs are
    /// security-scoped: access is held only for the copy.
    /// A lone `SKILL.md` (no folder) is wrapped in a temporary folder
    /// named after its frontmatter `name`, which is what the importer
    /// expects.
    @discardableResult
    func importSkill(from url: URL) async throws -> SkillImportReport {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard url.pathExtension.lowercased() == "md" else {
            let report = try await store.importSkill(from: url)
            await refresh()
            return report
        }
        let data = try Data(contentsOf: url)
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent("skill-import-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: staging) }
        let folder = staging.appendingPathComponent(Self.frontmatterName(in: data) ?? "skill", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try data.write(to: folder.appendingPathComponent("SKILL.md"))
        let report = try await store.importSkill(from: folder)
        await refresh()
        return report
    }

    /// `name:` from a SKILL.md's frontmatter, if it's a safe folder name.
    static func frontmatterName(in data: Data) -> String? {
        let text = String(decoding: data.prefix(8 * 1024), as: UTF8.self)
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard lines.first == "---" else { return nil }
        lines.removeFirst()
        for line in lines {
            if line == "---" { break }
            guard line.hasPrefix("name:") else { continue }
            let value = line.dropFirst(5).trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
            let safe = !value.isEmpty && value.unicodeScalars.allSatisfy {
                CharacterSet.alphanumerics.contains($0) || "-_.".unicodeScalars.contains($0)
            } && !value.hasPrefix(".")
            return safe ? value : nil
        }
        return nil
    }

    func remove(_ name: String) async throws {
        try await store.remove(named: name)
        await refresh()
    }

    private func refresh() async {
        skills = await store.skills()
        problems = await store.problems()
        updates = updates.filter { name, update in
            skills.first { $0.name == name }?.source?.revision.map { $0 != update.latest.revision } ?? false
        }
    }

    // MARK: Agent-made skills

    /// The editable fields of a skill (Skills → Edit).
    func draft(for name: String) async throws -> SkillDraft {
        try await store.draft(for: name)
    }

    /// Saves the user's edit of an agent-made skill, with the same rules
    /// as when the agent writes one. Reference files are kept.
    @discardableResult
    func saveEdit(_ draft: SkillDraft) async throws -> SkillImportReport {
        let report = try await store.saveAgentSkill(draft, replace: true)
        await refresh()
        return report
    }

    // MARK: Registries

    /// Adds a GitHub repo (`owner/repo`, a repo or folder URL) or an Agent
    /// Skills discovery index (a site or `index.json` URL). Checks it can
    /// be listed before saving it.
    @discardableResult
    func addRegistry(_ text: String) async throws -> SkillRegistry {
        let source = try SkillRegistrySource.parse(text)
        if let existing = registries.first(where: { $0.source == source }) { return existing }
        let registry = SkillRegistry(name: source.displayLocation, source: source)
        _ = try await registryClient.listing(for: registry, refresh: true)
        customRegistries.append(registry)
        persistRegistries()
        return registry
    }

    func removeRegistry(_ id: String) {
        customRegistries.removeAll { $0.id == id }
        persistRegistries()
    }

    func listing(for registry: SkillRegistry, refresh: Bool = false) async throws -> RegistryListing {
        try await registryClient.listing(for: registry, refresh: refresh)
    }

    func cachedListing(for registry: SkillRegistry) async -> RegistryListing? {
        await registryClient.cachedListing(for: registry)
    }

    func preview(_ skill: RegistrySkill) async throws -> RegistryPreview {
        try await registryClient.preview(skill)
    }

    @discardableResult
    func install(_ skill: RegistrySkill, from registry: SkillRegistry) async throws -> SkillImportReport {
        let report = try await registryClient.install(skill, from: registry, into: store)
        await refresh()
        return report
    }

    /// Compares installed registry skills with their registries' current
    /// listings (cached ones while fresh, so it's cheap on open). Returns
    /// registries that couldn't be checked.
    @discardableResult
    func checkForUpdates(refresh: Bool = false) async -> [String] {
        guard !checkingUpdates else { return [] }
        checkingUpdates = true
        defer { checkingUpdates = false }
        let result = await registryClient.updates(installed: skills, registries: registries, refresh: refresh)
        updates = Dictionary(result.updates.map { ($0.installedName, $0) }, uniquingKeysWith: { a, _ in a })
        return result.errors
    }

    @discardableResult
    func applyUpdate(_ name: String) async throws -> SkillImportReport {
        guard let update = updates[name] else { throw SkillError.notFound("No update for “\(name)”.") }
        let report = try await registryClient.install(update.latest, from: update.registry, into: store)
        updates[name] = nil
        await refresh()
        return report
    }

    private func persistRegistries() {
        guard let registriesFileURL else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        try? FileManager.default.createDirectory(at: registriesFileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? encoder.encode(customRegistries).write(to: registriesFileURL, options: .atomic)
    }
}
