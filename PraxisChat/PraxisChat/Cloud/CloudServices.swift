import Foundation
import Observation

/// Account-scoped cloud settings. No provider/MCP/Groq credential store is
/// constructed or read here; the only persisted credential is the client's
/// origin-scoped session token. The native service graph is sunset separately.
@MainActor
@Observable
final class CloudServices: VoiceSettingsReader {
    @ObservationIgnored let client: CloudAPIClient
    @ObservationIgnored var onSessionChanged: (@MainActor (CloudUser?) -> Void)?
    private(set) var account: CloudUser?
    /// Shows the "Account deleted" notice until the next sign-in.
    private(set) var accountDeleted = false
    private(set) var providers: [CloudCatalogProvider] = []
    private(set) var models: [CloudCatalogModel] = []
    private(set) var favoriteModels: [CloudCatalogModel] = []
    private(set) var connectors: [CloudCatalogConnector] = []
    private(set) var skills: [CloudCatalogSkill] = []
    private(set) var skillUpdates: [CloudSkillUpdate] = []
    private(set) var registries: [CloudCatalogRegistry] = []
    private(set) var consents: [CloudCatalogConsent] = []
    private(set) var preferences: CloudCatalogPreferences?
    private(set) var modelQuery = ""
    private(set) var modelProviderID: String?
    private(set) var nextModelCursor: String?
    private(set) var loadingModels = false
    private(set) var refreshing = false
    private(set) var lastError: String?
    @ObservationIgnored private var searchRevision = UUID()
    @ObservationIgnored private(set) var accountRevision = UUID()
    @ObservationIgnored private var hasLoaded = false

    init(client: CloudAPIClient) { self.client = client }

    var serverURL: URL { client.configuration.baseURL }
    var isSignedIn: Bool { account != nil }
    /// Cloud transcription is authenticated by the app session. Configuration
    /// and provider credentials are checked by the server, never the device.
    var isConfigured: Bool { isSignedIn && preferences?.voice.configured == true }
    var availableModels: [AIModel] { models.map(adapter) }
    var pinnedModelIDs: [String] { favoriteModels.filter(\.pinned).map(\.selectionID) }

    func model(selectionID: String) -> CloudCatalogModel? {
        models.first { $0.selectionID == selectionID } ?? favoriteModels.first { $0.selectionID == selectionID }
    }

    func adapter(_ model: CloudCatalogModel) -> AIModel {
        model.aiModel(providerName: providers.first { $0.id == model.providerId }?.name)
    }

    func providerName(_ id: String) -> String { providers.first { $0.id == id }?.name ?? id }

    func loadIfNeeded() async {
        guard !hasLoaded else { return }
        hasLoaded = true
        // Account bootstrap belongs to the facade, not a transient view task.
        // A dismissed/cancelled view must not leave hasLoaded true with no account.
        let bootstrap = Task { await self.reload() }
        await bootstrap.value
    }

    func reload() async {
        guard !refreshing else { return }
        refreshing = true
        lastError = nil
        var revision = accountRevision
        defer { if revision == accountRevision { refreshing = false } }
        do {
            let session = try await client.currentSession()
            guard revision == accountRevision else { return }
            let changed = account?.id != session.user.id
            if changed {
                clearAccount()
                revision = accountRevision
                refreshing = true
            }
            account = session.user
            if changed { onSessionChanged?(account) }
            try await refreshCatalogs()
        } catch is CancellationError {
            hasLoaded = false
        } catch {
            guard revision == accountRevision else { return }
            if (error as? CloudAPIError)?.statusCode == 401 {
                try? await client.tokens.setToken(nil, for: client.configuration.origin)
                clearAccount()
                onSessionChanged?(nil)
            } else { lastError = error.localizedDescription }
        }
    }

    func signIn(email: String, password: String) async throws {
        let session = try await client.signIn(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
        await acceptSignedInSession(session)
    }

    func acceptSignedInSession(_ session: CloudSession) async {
        clearAccount()
        account = session.user
        onSessionChanged?(account)
        hasLoaded = true
        do { try await refreshCatalogs() } catch { lastError = error.localizedDescription }
    }

    func signOut() async throws {
        try await client.signOut()
        clearAccount()
        onSessionChanged?(nil)
        hasLoaded = true
    }

    /// Success signs out through `onSessionChanged`, which wipes the replica,
    /// journals, attachments and recordings of the deleted account.
    func deleteAccount(password: String) async throws {
        try await client.deleteAccount(password: password)
        clearAccount()
        accountDeleted = true
        onSessionChanged?(nil)
        hasLoaded = true
    }

    private func clearAccount() {
        accountRevision = UUID(); searchRevision = UUID()
        account = nil; accountDeleted = false
        providers = []; models = []; favoriteModels = []; connectors = []
        skills = []; skillUpdates = []; registries = []; consents = []; preferences = nil
        nextModelCursor = nil; modelQuery = ""; modelProviderID = nil
        loadingModels = false; refreshing = false; lastError = nil
    }

    func refreshCatalogs() async throws {
        let revision = accountRevision
        let client = client
        async let providerRows: [CloudCatalogProvider] = Self.allPages(client, "/v1/providers")
        async let connectorRows: [CloudCatalogConnector] = Self.allPages(client, "/v1/connectors")
        async let skillRows: [CloudCatalogSkill] = Self.allPages(client, "/v1/skills")
        async let registryRows: [CloudCatalogRegistry] = Self.allPages(client, "/v1/skill-registries")
        async let settings: CloudCatalogPreferences = client.send("/v1/preferences")
        async let consentRows: [CloudCatalogConsent] = Self.allPages(client, "/v1/consents")
        let result = try await (providerRows, connectorRows, skillRows, registryRows, consentRows, settings)
        guard revision == accountRevision else { return }
        providers = result.0; connectors = result.1; skills = result.2; registries = result.3; consents = result.4; preferences = result.5
        try await searchModels(query: modelQuery, providerID: modelProviderID)
        try await refreshFavorites()
    }

    /// One small page is rendered. The server performs filtering/ranking;
    /// superseded responses cannot replace a newer query (or account).
    func searchModels(query: String, providerID: String? = nil) async throws {
        let query = String(query.trimmingCharacters(in: .whitespacesAndNewlines).prefix(500))
        let revision = UUID()
        searchRevision = revision
        modelQuery = query; modelProviderID = providerID
        models = []; nextModelCursor = nil; loadingModels = true
        defer { if revision == searchRevision { loadingModels = false } }
        do {
            let page: CloudCatalogPage<CloudCatalogModel> = try await client.send(modelPath(query: query, providerID: providerID))
            try Task.checkCancellation()
            guard revision == searchRevision else { return }
            models = Self.uniqueModels(page.items); nextModelCursor = page.nextCursor
            lastError = nil
        } catch {
            if revision == searchRevision, !(error is CancellationError) { lastError = error.localizedDescription }
            throw error
        }
    }

    func loadMoreModels() async throws {
        guard !loadingModels, let cursor = nextModelCursor else { return }
        let revision = searchRevision
        loadingModels = true
        defer { if revision == searchRevision { loadingModels = false } }
        let page: CloudCatalogPage<CloudCatalogModel> = try await client.send(modelPath(query: modelQuery, providerID: modelProviderID, cursor: cursor))
        try Task.checkCancellation()
        guard revision == searchRevision else { return }
        guard page.nextCursor != cursor else { throw CloudSettingsError.repeatedCursor }
        models = Self.uniqueModels(models + page.items); nextModelCursor = page.nextCursor
    }

    private func modelPath(query: String, providerID: String?, cursor: String? = nil) -> String {
        var items = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: "50")]
        if let providerID { items.append(URLQueryItem(name: "providerId", value: providerID)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return CloudCatalogPath.list("/v1/models", query: items)
    }

    func refreshFavorites() async throws {
        let revision = accountRevision
        let pinned: [CloudCatalogModel] = try await Self.allPages(client, "/v1/models", filters: [URLQueryItem(name: "pinned", value: "true")])
        let favorites: [CloudCatalogModel] = try await Self.allPages(client, "/v1/models", filters: [URLQueryItem(name: "favorite", value: "true")])
        guard revision == accountRevision else { return }
        favoriteModels = Self.uniqueModels(pinned + favorites)
    }

    func setModelPreference(_ model: CloudCatalogModel, pinned: Bool? = nil, favorite: Bool? = nil) async throws {
        let revision = accountRevision
        let updated: CloudCatalogModel = try await client.send("/v1/models/preferences", method: "PATCH", body: encoded(CloudCatalogModelPreference(providerId: model.providerId, modelId: model.id, pinned: pinned, favorite: favorite)))
        guard revision == accountRevision else { return }
        models = models.map { $0.selectionID == updated.selectionID ? updated : $0 }
        favoriteModels.removeAll { $0.selectionID == updated.selectionID }
        if updated.pinned || updated.favorite { favoriteModels.append(updated) }
    }

    @discardableResult
    func saveProvider(id: String? = nil, input: CloudCatalogProviderInput) async throws -> CloudCatalogProvider {
        try CloudSettingsValidation.remoteURL(input.baseUrl)
        let revision = accountRevision
        let path = id.map { "/v1/providers/" + CloudCatalogPath.component($0) } ?? "/v1/providers"
        let provider: CloudCatalogProvider = try await client.send(path, method: id == nil ? "POST" : "PATCH", body: encoded(input))
        guard revision == accountRevision else { return provider }
        providers.removeAll { $0.id == provider.id }; providers.append(provider)
        return provider
    }

    func deleteProvider(_ id: String) async throws {
        let revision = accountRevision
        try await client.sendVoid("/v1/providers/" + CloudCatalogPath.component(id), method: "DELETE")
        guard revision == accountRevision else { return }
        providers.removeAll { $0.id == id }; models.removeAll { $0.providerId == id }; favoriteModels.removeAll { $0.providerId == id }
    }

    func testProvider(_ id: String, modelID: String? = nil) async throws -> CloudCatalogProbe {
        struct Input: Encodable { var type = "provider.test"; var modelId: String? }
        return try await client.send("/v1/providers/" + CloudCatalogPath.component(id) + "/test", method: "POST", body: encoded(Input(modelId: modelID)))
    }

    func refreshProviderModels(_ id: String) async throws {
        try await client.sendVoid("/v1/providers/" + CloudCatalogPath.component(id) + "/refresh-models", method: "POST", body: encoded(CloudSettingsActionInput(type: "models.refresh")))
        try await searchModels(query: modelQuery, providerID: modelProviderID)
    }

    @discardableResult
    func saveConnector(id: String? = nil, input: CloudCatalogConnectorInput) async throws -> CloudCatalogConnector {
        try CloudSettingsValidation.remoteURL(input.url)
        let revision = accountRevision
        let connector: CloudCatalogConnector
        if let id {
            let patch = CloudCatalogConnectorPatch(name: input.name, url: input.url, transport: input.transport, enabled: input.enabled, trusted: input.trusted, disabledTools: input.disabledTools, token: input.token, extraHeaders: input.extraHeaders)
            connector = try await client.send("/v1/connectors/" + CloudCatalogPath.component(id), method: "PATCH", body: encoded(patch))
        } else {
            connector = try await client.send("/v1/connectors", method: "POST", body: encoded(input))
        }
        if revision == accountRevision { replaceConnector(connector) }
        return connector
    }

    func patchConnector(_ id: String, patch: CloudCatalogConnectorPatch) async throws {
        let revision = accountRevision
        let connector: CloudCatalogConnector = try await client.send("/v1/connectors/" + CloudCatalogPath.component(id), method: "PATCH", body: encoded(patch))
        if revision == accountRevision { replaceConnector(connector) }
    }

    func deleteConnector(_ id: String) async throws {
        let revision = accountRevision
        try await client.sendVoid("/v1/connectors/" + CloudCatalogPath.component(id), method: "DELETE")
        guard revision == accountRevision else { return }
        connectors.removeAll { $0.id == id }
    }

    func connectorTools(_ id: String) async throws -> [CloudCatalogTool] {
        try await Self.allPages(client, "/v1/connectors/" + CloudCatalogPath.component(id) + "/tools")
    }

    func setToolEnabled(connectorID: String, name: String, enabled: Bool) async throws {
        struct Input: Encodable { var type = "connector.tool"; var enabled: Bool }
        let revision = accountRevision
        let connector: CloudCatalogConnector = try await client.send("/v1/connectors/" + CloudCatalogPath.component(connectorID) + "/tools/" + CloudCatalogPath.component(name), method: "PATCH", body: encoded(Input(enabled: enabled)))
        if revision == accountRevision { replaceConnector(connector) }
    }

    func refreshConnector(_ id: String) async throws {
        let revision = accountRevision
        let connector: CloudCatalogConnector = try await client.send("/v1/connectors/" + CloudCatalogPath.component(id) + "/refresh", method: "POST")
        if revision == accountRevision { replaceConnector(connector) }
    }

    func signInToConnector(_ id: String, authorizer: any CloudOAuthAuthorizing = CloudOAuthAuthorizer()) async throws {
        struct Input: Encodable { var type = "oauth.start"; var returnUrl = "praxis-app://oauth/callback" }
        let revision = accountRevision
        let authorization: CloudCatalogOAuthAuthorization = try await client.send("/v1/connectors/" + CloudCatalogPath.component(id) + "/oauth/start", method: "POST", body: encoded(Input()))
        _ = try await authorizer.authorize(authorization)
        let connector: CloudCatalogConnector = try await client.send("/v1/connectors/" + CloudCatalogPath.component(id))
        guard connector.authStatus == "connected" else { throw CloudSettingsError.invalidOAuthCallback }
        if revision == accountRevision { replaceConnector(connector) }
    }

    private func replaceConnector(_ connector: CloudCatalogConnector) {
        if let index = connectors.firstIndex(where: { $0.id == connector.id }) { connectors[index] = connector }
        else { connectors.append(connector) }
    }

    func connectorPrompts(_ id: String) async throws -> [CloudCatalogPrompt] {
        try await Self.allPages(client, "/v1/connectors/" + CloudCatalogPath.component(id) + "/prompts")
    }

    func prompt(connectorID: String, name: String, arguments: [String: String]) async throws -> String {
        struct Input: Encodable { var type = "mcp.prompt.get"; var name: String; var arguments: [String: String] }
        let result: CloudCatalogPromptResult = try await client.send("/v1/connectors/" + CloudCatalogPath.component(connectorID) + "/prompts/get", method: "POST", body: encoded(Input(name: name, arguments: arguments)))
        guard !result.composerText.isEmpty else { throw CloudSettingsError.emptyPrompt }
        return result.composerText
    }

    func connectorResources(_ id: String) async throws -> [CloudCatalogResource] {
        try await Self.allPages(client, "/v1/connectors/" + CloudCatalogPath.component(id) + "/resources")
    }

    func readResource(connectorID: String, uri: String) async throws -> CloudCatalogResourceResult {
        struct Input: Encodable { var type = "mcp.resource.read"; var uri: String }
        return try await client.send("/v1/connectors/" + CloudCatalogPath.component(connectorID) + "/resources/read", method: "POST", body: encoded(Input(uri: uri)))
    }

    func setConsent(host: String, allowed: Bool) async throws {
        let revision = accountRevision
        let consent: CloudCatalogConsent = try await client.send("/v1/consents", method: "POST", body: encoded(CloudCatalogConsent(host: host, allowed: allowed)))
        guard revision == accountRevision else { return }
        consents.removeAll { $0.host == host }; consents.append(consent)
    }

    @discardableResult
    func saveSkill(id: String? = nil, input: CloudCatalogSkillInput) async throws -> CloudCatalogSkill {
        let revision = accountRevision
        let skill: CloudCatalogSkill = try await client.send(id.map { "/v1/skills/" + CloudCatalogPath.component($0) } ?? "/v1/skills", method: id == nil ? "POST" : "PATCH", body: encoded(input))
        if revision == accountRevision { skills.removeAll { $0.id == skill.id }; skills.append(skill) }
        return skill
    }

    func deleteSkill(_ id: String) async throws {
        let revision = accountRevision
        try await client.sendVoid("/v1/skills/" + CloudCatalogPath.component(id), method: "DELETE")
        guard revision == accountRevision else { return }
        skills.removeAll { $0.id == id }
    }

    @discardableResult
    func saveRegistry(id: String? = nil, input: CloudCatalogRegistryInput) async throws -> CloudCatalogRegistry {
        try CloudSettingsValidation.remoteURL(input.url)
        let revision = accountRevision
        let registry: CloudCatalogRegistry = try await client.send(id.map { "/v1/skill-registries/" + CloudCatalogPath.component($0) } ?? "/v1/skill-registries", method: id == nil ? "POST" : "PATCH", body: encoded(input))
        if revision == accountRevision { registries.removeAll { $0.id == registry.id }; registries.append(registry) }
        return registry
    }

    func deleteRegistry(_ id: String) async throws {
        let revision = accountRevision
        try await client.sendVoid("/v1/skill-registries/" + CloudCatalogPath.component(id), method: "DELETE")
        guard revision == accountRevision else { return }
        registries.removeAll { $0.id == id }
    }

    func registrySearch(_ id: String, query: String, cursor: String? = nil) async throws -> CloudCatalogPage<CloudCatalogRegistryEntry> {
        var filters = [URLQueryItem(name: "q", value: String(query.prefix(500))), URLQueryItem(name: "limit", value: "50")]
        if let cursor { filters.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await client.send(CloudCatalogPath.list("/v1/skill-registries/" + CloudCatalogPath.component(id) + "/search", query: filters))
    }

    func installSkill(registryID: String, skillID: String) async throws {
        struct Input: Encodable { var type = "skill.install"; var skillId: String }
        let revision = accountRevision
        let skill: CloudCatalogSkill = try await client.send("/v1/skill-registries/" + CloudCatalogPath.component(registryID) + "/install", method: "POST", body: encoded(Input(skillId: skillID)))
        if revision == accountRevision { skills.removeAll { $0.id == skill.id }; skills.append(skill) }
    }

    func savePreferences(_ input: CloudCatalogPreferencesInput) async throws {
        let revision = accountRevision
        let result: CloudCatalogPreferences = try await client.send("/v1/preferences", method: "PATCH", body: encoded(input))
        if revision == accountRevision { preferences = result }
    }

    func acceptSkill(_ skill: CloudCatalogSkill, revision: UUID) {
        guard revision == accountRevision else { return }
        skills.removeAll { $0.id == skill.id }; skills.append(skill)
        skillUpdates.removeAll { $0.skillId == skill.id }
    }

    func acceptUpdates(_ updates: [CloudSkillUpdate], revision: UUID) {
        if revision == accountRevision { skillUpdates = updates }
    }

    private func encoded<Input: Encodable>(_ value: Input) throws -> Data { try JSONEncoder().encode(value) }

    nonisolated private static func uniqueModels(_ values: [CloudCatalogModel]) -> [CloudCatalogModel] {
        var seen: Set<String> = []
        return values.filter { seen.insert($0.selectionID).inserted }
    }

}

private struct CloudSettingsActionInput: Encodable { var type: String }
