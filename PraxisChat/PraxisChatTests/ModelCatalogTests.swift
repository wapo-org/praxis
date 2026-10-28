import XCTest
import AgentCore
import AgentMCP
@testable import PraxisChat

/// Model picker search (filter + ranking), favourites partitioning and
/// pin persistence. The composer binds `store.modelQuery` while the Model
/// page is open; the draft is never touched (covered by UI tests).
@MainActor
final class ModelCatalogTests: XCTestCase {
    private func model(_ id: String, name: String? = nil, tagline: String = "") -> AIModel {
        AIModel(id: id, name: name ?? id, tagline: tagline, speed: 0, intelligence: 0, streamMultiplier: 1)
    }

    // MARK: Filtering

    func testEmptyQueryReturnsListUnchanged() {
        let models = [model("b", name: "Bee"), model("a", name: "Aye")]
        XCTAssertEqual(ModelSearch.filter(models, query: ""), models)
        XCTAssertEqual(ModelSearch.filter(models, query: "   "), models)
    }

    func testMatchesNameCaseAndDiacriticInsensitively() {
        let models = [model("m1", name: "Café Writer"), model("m2", name: "Code")]
        XCTAssertEqual(ModelSearch.filter(models, query: "cafe").map(\.id), ["m1"])
        XCTAssertEqual(ModelSearch.filter(models, query: "CAFÉ").map(\.id), ["m1"])
        XCTAssertEqual(ModelSearch.filter(models, query: "  code ").map(\.id), ["m2"])
    }

    func testMatchesIDAndProviderTagline() {
        let models = [
            model("openai/gpt-5-mini", name: "GPT-5 Mini", tagline: "OpenRouter · 128K context"),
            model("local", name: "Local", tagline: "LM Studio"),
        ]
        XCTAssertEqual(ModelSearch.filter(models, query: "gpt-5").map(\.id), ["openai/gpt-5-mini"])
        XCTAssertEqual(ModelSearch.filter(models, query: "openrouter").map(\.id), ["openai/gpt-5-mini"])
        XCTAssertEqual(ModelSearch.filter(models, query: "lm studio").map(\.id), ["local"])
    }

    func testPrefixMatchesRankFirst() {
        let models = [
            model("chat", name: "ChatAtlas"),          // name contains
            model("atlas-mini", name: "Mini"),         // id prefix
            model("a", name: "Atlas Pro"),             // name prefix
            model("b", name: "Bob", tagline: "by Atlas Labs"), // tagline contains
        ]
        XCTAssertEqual(ModelSearch.filter(models, query: "atlas").map(\.id),
                       ["a", "atlas-mini", "chat", "b"])
    }

    func testTiesKeepOriginalOrder() {
        let models = [model("m1", name: "Atlas One"), model("m2", name: "Atlas Two")]
        XCTAssertEqual(ModelSearch.filter(models, query: "atlas").map(\.id), ["m1", "m2"])
    }

    func testNoMatchIsEmpty() {
        let models = [model("m1", name: "Atlas")]
        XCTAssertTrue(ModelSearch.filter(models, query: "zzz-no-such-model").isEmpty)
    }

    // MARK: Partitioning

    func testFavoritesKeepPinOrderAndRestExcludesThem() {
        let models = [model("a"), model("b"), model("c")]
        let sections = ModelSections.make(models: models, pinnedIDs: ["c", "a"], query: "")
        XCTAssertEqual(sections.favorites.map(\.id), ["c", "a"])
        XCTAssertEqual(sections.rest.map(\.id), ["b"])
        XCTAssertTrue(sections.unavailableIDs.isEmpty)
    }

    func testUnlistedPinsStayAsUnavailable() {
        let models = [model("a")]
        let sections = ModelSections.make(models: models, pinnedIDs: ["gone/model", "a"], query: "")
        XCTAssertEqual(sections.favorites.map(\.id), ["a"])
        XCTAssertEqual(sections.unavailableIDs, ["gone/model"])
        XCTAssertTrue(sections.rest.isEmpty)
    }

    func testSearchFiltersEverySection() {
        let models = [model("atlas", name: "Atlas"), model("mini", name: "Mini")]
        let sections = ModelSections.make(models: models, pinnedIDs: ["atlas", "gone/gpt"], query: "gpt")
        XCTAssertTrue(sections.favorites.isEmpty)
        XCTAssertEqual(sections.unavailableIDs, ["gone/gpt"])
        XCTAssertTrue(sections.rest.isEmpty)
        let ranked = ModelSections.make(models: models, pinnedIDs: ["mini", "atlas"], query: "at")
        XCTAssertEqual(ranked.favorites.map(\.id), ["atlas"])
        XCTAssertTrue(ranked.rest.isEmpty)
    }

    func testDuplicateAndEmptyPinsAreIgnored() {
        let models = [model("a")]
        let sections = ModelSections.make(models: models, pinnedIDs: ["", "a", "a"], query: "")
        XCTAssertEqual(sections.favorites.map(\.id), ["a"])
        XCTAssertTrue(sections.unavailableIDs.isEmpty)
        XCTAssertTrue(sections.rest.isEmpty)
    }

    // MARK: Pin persistence

    private var directory: URL!
    private var secrets: InMemorySecretStore!

    override func setUp() async throws {
        directory = temporaryDirectory()
        secrets = InMemorySecretStore()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var providersFile: URL { directory.appendingPathComponent("Providers.json") }

    private func settings() -> ProviderSettings {
        ProviderSettings(fileURL: providersFile, secrets: secrets)
    }

    func testPinsRoundTripThroughDisk() {
        let settings = settings()
        settings.setPinned(true, profileID: .demoProfileID, model: "atlas")
        settings.setPinned(true, profileID: .demoProfileID, model: "mini")
        settings.setPinned(false, profileID: .demoProfileID, model: "atlas")
        XCTAssertEqual(settings.pinnedModels(for: .demoProfileID), ["mini"])
        let reopened = settings()
        XCTAssertEqual(reopened.pinnedModels(for: .demoProfileID), ["mini"])
        XCTAssertTrue(reopened.isPinned(profileID: .demoProfileID, model: "mini"))
        XCTAssertFalse(reopened.isPinned(profileID: .demoProfileID, model: "atlas"))
    }

    func testPinOrderAndNoDuplicates() {
        let settings = settings()
        settings.setPinned(true, profileID: .demoProfileID, model: "a")
        settings.setPinned(true, profileID: .demoProfileID, model: "b")
        settings.setPinned(true, profileID: .demoProfileID, model: "a")
        settings.setPinned(false, profileID: .demoProfileID, model: "absent")
        XCTAssertEqual(settings.pinnedModels(for: .demoProfileID), ["a", "b"])
    }

    func testPinsArePerProfile() throws {
        let settings = settings()
        var profile = ProviderProfile.draft(.openRouterOpenAI)
        profile.defaultModel = "x"
        try settings.save(profile, apiKey: nil)
        settings.setPinned(true, profileID: profile.id, model: "a")
        settings.setPinned(true, profileID: .demoProfileID, model: "b")
        XCTAssertEqual(settings.pinnedModels(for: profile.id), ["a"])
        XCTAssertEqual(settings.pinnedModels(for: .demoProfileID), ["b"])
        settings.delete(profile.id)
        XCTAssertTrue(settings.pinnedModels(for: profile.id).isEmpty)
        XCTAssertEqual(settings.pinnedModels(for: .demoProfileID), ["b"])
    }

    func testPinsForUnknownProfilesAndEmptyModelsAreIgnored() {
        let settings = settings()
        settings.setPinned(true, profileID: UUID(), model: "a")
        settings.setPinned(true, profileID: .demoProfileID, model: "")
        XCTAssertTrue(settings.pinnedModels(for: .demoProfileID).isEmpty)
    }

    func testFilesFromBeforePinsStillDecode() throws {
        try Data(#"{"version":1,"profiles":[]}"#.utf8).write(to: providersFile)
        XCTAssertTrue(settings().pinnedModels(for: .demoProfileID).isEmpty)
    }

    // MARK: Smoothness

    /// A provider-sized list must filter in a fraction of a keystroke
    /// (the UI runs this on every keystroke over a lazy list).
    func testFilterStaysFastOnThousandsOfModels() {
        let models = (0..<5000).map {
            model("vendor/model-\($0)", name: "Vendor Model \($0)", tagline: "Demo provider")
        }
        let start = Date()
        let matches = ModelSearch.filter(models, query: "model 42")
        let elapsed = Date().timeIntervalSince(start)
        XCTAssertFalse(matches.isEmpty)
        XCTAssertLessThan(elapsed, 1.0, "filtering 5000 models took \(elapsed)s")
    }
}

private extension UUID {
    static var demoProfileID: UUID { ProviderSettings.demoProfileID }
}
