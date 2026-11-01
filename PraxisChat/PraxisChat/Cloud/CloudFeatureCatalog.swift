import Foundation

struct CloudSkillUpdate: Decodable, Sendable {
    var skillId: String
    var registryId: String
    var entryId: String
    var digest: String
    var updateAvailable: Bool
}

struct CloudSkillImportResult: Decodable, Sendable {
    var skill: CloudCatalogSkill
    var dropped: [String]
    var summary: String {
        "Imported \(skill.name)." + (dropped.isEmpty ? "" : " Left out: " + dropped.joined(separator: ", "))
    }
}

struct CloudCapabilityProbe: Decodable, Sendable {
    var tools: Bool
    var vision: Bool
    var streaming: Bool
    var reasoningEfforts: [String]

    func applying(to current: CloudCatalogCapabilities) -> CloudCatalogCapabilities {
        var result = current
        result.tools = tools; result.vision = vision
        result.reasoningEffort = !reasoningEfforts.isEmpty
        // Streaming is a transport result, not the separate streamUsage claim.
        return result
    }
}

struct CloudProviderProbeError: Decodable, Sendable {
    var code: String
    var message: String
}

extension CloudCatalogProbe {
    var summary: String {
        if !ok { return error?.message ?? message ?? "The server could not verify this connection." }
        guard let probe else { return "Connection works · \(models.count) models" }
        return "Streaming: \(probe.streaming ? "yes" : "no") · Tools: \(probe.tools ? "yes" : "unconfirmed") · Vision: \(probe.vision ? "yes" : "no") · Reasoning: \(probe.reasoningEfforts.joined(separator: ", "))"
    }
}

struct CloudConnectorRegistryEntry: Decodable, Sendable, Identifiable {
    var id: String
    var description: String
    var input: CloudCatalogConnectorInput
    var headerNames: [String]
    var requiresConfiguration: Bool
    // One registry entry can advertise several remote addresses.
    var selectionID: String { id + "\u{0}" + input.transport + "\u{0}" + input.url }
}

extension CloudServices {
    func checkSkillUpdates() async throws {
        let revision = accountRevision
        let updates: [CloudSkillUpdate] = try await Self.allPages(client, "/v1/skills/updates")
        acceptUpdates(updates, revision: revision)
    }

    func updateSkill(_ id: String) async throws {
        let revision = accountRevision
        let skill: CloudCatalogSkill = try await client.send("/v1/skills/" + CloudCatalogPath.component(id) + "/update", method: "POST")
        acceptSkill(skill, revision: revision)
    }

    func importSkillArchive(bytes: Data, name: String) async throws -> CloudSkillImportResult {
        guard !bytes.isEmpty, bytes.count <= 25_000_000, CloudSkillArchive.isArchive(name) else { throw CloudSkillArchiveError.invalid }
        let revision = accountRevision
        let id = try await CloudFileUpload.send(client: client, bytes: bytes, name: name, mediaType: CloudSkillArchive.mediaType(name))
        try Task.checkCancellation()
        guard revision == accountRevision else { throw CancellationError() }
        struct Input: Encodable { var type = "skill.import"; var attachmentId: String }
        let result: CloudSkillImportResult = try await client.send("/v1/skills/import", method: "POST", body: JSONEncoder().encode(Input(attachmentId: id)))
        acceptSkill(result.skill, revision: revision)
        return result
    }

    func connectorRegistry(query: String, cursor: String? = nil) async throws -> CloudCatalogPage<CloudConnectorRegistryEntry> {
        var filters = [URLQueryItem(name: "q", value: String(query.prefix(500)))]
        if let cursor { filters.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await client.send(CloudCatalogPath.list("/v1/connectors/registry", query: filters))
    }
}

enum CloudSkillArchiveError: LocalizedError {
    case invalid
    var errorDescription: String? { "Choose a non-empty .zip, .tar or .tar.gz skill archive smaller than 25 MB." }
}

enum CloudSkillArchive {
    static func isArchive(_ name: String) -> Bool {
        [".zip", ".tar", ".tar.gz"].contains { name.lowercased().hasSuffix($0) }
    }
    static func mediaType(_ name: String) -> String {
        name.lowercased().hasSuffix(".zip") ? "application/zip" : name.lowercased().hasSuffix(".gz") ? "application/gzip" : "application/x-tar"
    }
    nonisolated static func read(_ url: URL) throws -> Data {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard isArchive(url.lastPathComponent), values.isRegularFile == true, let size = values.fileSize, size > 0, size <= 25_000_000 else { throw CloudSkillArchiveError.invalid }
        let bytes = try Data(contentsOf: url, options: .mappedIfSafe)
        guard !bytes.isEmpty, bytes.count <= 25_000_000 else { throw CloudSkillArchiveError.invalid }
        return bytes
    }
}
