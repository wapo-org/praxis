import XCTest
import AgentCore
import AgentProviders
import AgentMCP
import AgentTestSupport
@testable import PraxisChat

/// Secret-like extra header values live in Keychain, never Providers.json; plain headers stay.
@MainActor
final class HeaderSecretsAppTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!

    private var file: URL { directory.appendingPathComponent("Providers.json") }

    override func setUp() async throws {
        directory = temporaryDirectory()
        secrets = InMemorySecretStore()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func settings() -> ProviderSettings {
        ProviderSettings(fileURL: file, secrets: secrets)
    }

    private func profile() -> ProviderProfile {
        var profile = ProviderProfile.draft(.openRouterOpenAI)
        profile.defaultModel = "some/model"
        return profile
    }

    func testSecretLikeHeaderValuesAreStoredInTheKeychainNotJSON() throws {
        let settings = settings()
        var profile = profile()
        profile.endpoint.extraHeaders = ["Authorization": "Bearer s3cr3t", "X-API-Key": "k-123", "X-Title": "Praxis"]
        try settings.save(profile, apiKey: "sk-or")

        let json = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(json.contains("s3cr3t"), "the Authorization value must not be in the JSON")
        XCTAssertFalse(json.contains("k-123"), "the X-API-Key value must not be in the JSON")
        XCTAssertTrue(json.contains("X-Title"), "plain headers stay in the JSON")

        let endpoint = try XCTUnwrap(settings.endpoint(for: profile.id))
        XCTAssertEqual(endpoint.extraHeaders["Authorization"], "Bearer s3cr3t", "runs still send the header")
        XCTAssertEqual(endpoint.extraHeaders["X-API-Key"], "k-123")
        XCTAssertEqual(endpoint.extraHeaders["X-Title"], "Praxis")

        let reloaded = self.settings()
        let reloadedEndpoint = try XCTUnwrap(reloaded.endpoint(for: profile.id))
        XCTAssertEqual(reloadedEndpoint.extraHeaders["Authorization"], "Bearer s3cr3t")
        XCTAssertEqual(reloadedEndpoint.extraHeaders["X-API-Key"], "k-123")
        XCTAssertEqual(reloadedEndpoint.extraHeaders["X-Title"], "Praxis")

        // Deleting the profile forgets its header secrets with its key.
        reloaded.delete(profile.id)
        XCTAssertTrue(secrets.allKeys.isEmpty)
    }

    func testPlaintextHeaderSecretsMigrateToTheKeychainOnLoad() throws {
        // Simulates a legacy Providers.json containing a plaintext header secret to test migration.
        let settings = settings()
        var profile = profile()
        profile.endpoint.extraHeaders = ["Authorization": "", "X-Title": "Praxis"]
        try settings.save(profile, apiKey: nil)
        let written = try String(contentsOf: file, encoding: .utf8)
        XCTAssertTrue(written.contains(#""Authorization":"""#), "shape check: the blanked row is in the JSON")
        try written.replacingOccurrences(of: #""Authorization":"""#, with: #""Authorization":"Bearer old-secret""#)
            .write(to: file, atomically: true, encoding: .utf8)

        let migrated = self.settings()
        let json = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(json.contains("old-secret"), "migration blanks the value in the JSON")
        XCTAssertEqual(migrated.endpoint(for: profile.id)?.extraHeaders["Authorization"], "Bearer old-secret",
                       "the migrated value still goes out on requests")
        XCTAssertEqual(migrated.endpoint(for: profile.id)?.extraHeaders["X-Title"], "Praxis")
    }

    func testRemovingAHeaderRowForgetsItsSecret() throws {
        let settings = settings()
        var profile = profile()
        profile.endpoint.extraHeaders = ["Authorization": "Bearer abc", "X-Title": "Praxis"]
        try settings.save(profile, apiKey: "sk-or")

        // Blank secret-like header rows preserve the existing Keychain value instead of clearing it.
        var roundTripped = try XCTUnwrap(settings.profile(profile.id))
        XCTAssertEqual(roundTripped.endpoint.extraHeaders["Authorization"], "")
        roundTripped.endpoint.extraHeaders["X-Title"] = "Praxis 2"
        try settings.save(roundTripped, apiKey: nil)
        XCTAssertEqual(settings.endpoint(for: profile.id)?.extraHeaders["Authorization"], "Bearer abc",
                       "a blanked row keeps its secret")
        XCTAssertEqual(settings.endpoint(for: profile.id)?.extraHeaders["X-Title"], "Praxis 2")

        roundTripped.endpoint.extraHeaders.removeValue(forKey: "Authorization")
        try settings.save(roundTripped, apiKey: nil)
        XCTAssertNil(settings.endpoint(for: profile.id)?.extraHeaders["Authorization"])
        XCTAssertFalse(secrets.allKeys.contains { $0.contains(".header.") })
    }
}
