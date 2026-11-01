import XCTest
@testable import PraxisChat

/// Real HTTP checks; the deterministic local registry is provided by the API,
/// not a client fallback. Probe failures remain failures in the presentation.
@MainActor
final class CloudFeatureLiveTests: XCTestCase {
    private func services() async throws -> CloudServices {
        guard ProcessInfo.processInfo.environment["PRAXIS_LIVE_API"] == "http://127.0.0.1:8807" else {
            throw XCTSkip("Set PRAXIS_LIVE_API=http://127.0.0.1:8807 for live feature checks")
        }
        let client = CloudAPIClient(configuration: try CloudServerConfiguration(baseURL: URL(string: "http://127.0.0.1:8807")!), session: URLSession(configuration: .ephemeral), tokens: CloudSessionStore(inMemory: true))
        try await client.tokens.setToken("dev-local", for: client.configuration.origin)
        return CloudServices(client: client)
    }
    func testLiveSkillUpdateCheckAndUpdatePreserveInstalledIdentity() async throws {
        let services = try await services()
        let registry = try await services.saveRegistry(input: CloudCatalogRegistryInput(name: "X1 live", url: "https://skills.praxis.local"))
        try await services.installSkill(registryID: registry.id, skillID: "local-example")
        let installed = try XCTUnwrap(services.skills.first)
        try await services.checkSkillUpdates()
        XCTAssertFalse(services.skillUpdates.contains { $0.skillId == installed.id }, "The deterministic fixture has no newer digest")
        try await services.updateSkill(installed.id)
        let updated = try XCTUnwrap(services.skills.first { $0.id == installed.id })
        XCTAssertEqual(updated.registryId, registry.id); XCTAssertEqual(updated.registryEntryId, "local-example")
        XCTAssertEqual(updated.document, installed.document); XCTAssertEqual(updated.enabled, installed.enabled)
        try await services.deleteSkill(installed.id); try await services.deleteRegistry(registry.id)
    }
    func testLiveArchiveImportsFilesAndReportsDroppedScript() async throws {
        let services = try await services()
        let name = "x1-" + UUID().uuidString.lowercased()
        let document = "---\nname: \(name)\ndescription: Live archive check\n---\nUse these instructions."
        let archive = tar([("SKILL.md", document), ("notes.txt", "Reference"), ("run.sh", "#!/bin/sh\necho no")])
        let result = try await services.importSkillArchive(bytes: archive, name: "skill.tar")
        XCTAssertEqual(result.skill.name, name); XCTAssertEqual(result.dropped, ["run.sh"])
        XCTAssertTrue(result.skill.enabled); XCTAssertTrue(services.skills.contains { $0.id == result.skill.id })
        try await services.deleteSkill(result.skill.id)
    }
    func testLiveMCPRegistrySearchAndHealthCheckedAdd() async throws {
        let services = try await services()
        let page = try await services.connectorRegistry(query: "fetch")
        let entry = try XCTUnwrap(page.items.first { !$0.requiresConfiguration })
        let added = try await services.saveConnector(input: entry.input)
        XCTAssertNotNil(added.status)
        XCTAssertTrue(["connected", "unreachable", "needs_auth", "needs_reauth", "error"].contains(added.status ?? ""))
        XCTAssertEqual(services.connectors.first?.id, added.id)
        XCTAssertNotEqual(added.presentationStatus, "Not checked")
        try await services.deleteConnector(added.id)
    }
    func testLiveProviderProbeSurfacesRealFailureWithoutInventingCapabilities() async throws {
        let services = try await services()
        // The seed profile is for scripted runs, not a listening provider.
        // Its real probe must return a typed failure, never fake a capability.
        try await services.setConsent(host: "localhost:8787", allowed: true)
        let result = try await services.testProvider("scripted", modelID: "scripted")
        XCTAssertFalse(result.ok); XCTAssertNil(result.probe)
        XCTAssertNotNil(result.error?.code); XCTAssertFalse(result.summary.isEmpty)
        XCTAssertFalse(result.summary.contains("Connection works"))
        try await services.setConsent(host: "localhost:8787", allowed: false)
    }

    private func tar(_ files: [(String, String)]) -> Data {
        var result = Data()
        for (name, text) in files {
            let bytes = Data(text.utf8)
            var header = [UInt8](repeating: 0, count: 512)
            func put(_ value: String, at offset: Int) {
                for (index, byte) in value.utf8.enumerated() { header[offset + index] = byte }
            }
            put(name, at: 0); put("0000644\0", at: 100); put("0000000\0", at: 108); put("0000000\0", at: 116)
            put(String(format: "%011o", bytes.count) + "\0", at: 124); put("00000000000\0", at: 136)
            put("        ", at: 148); header[156] = 48; put("ustar\0", at: 257); put("00", at: 263)
            put(String(format: "%06o", header.reduce(0) { $0 + Int($1) }) + "\0 ", at: 148)
            result.append(contentsOf: header); result.append(bytes)
            result.append(Data(repeating: 0, count: (512 - bytes.count % 512) % 512))
        }
        result.append(Data(repeating: 0, count: 1024)); return result
    }
}
