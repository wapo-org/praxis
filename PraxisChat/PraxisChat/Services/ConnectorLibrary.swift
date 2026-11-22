import Foundation
import Observation
import AgentCore
import AgentMCP

/// Holds MCP configs & clients (secrets in SecretStore); config edits replace immutable clients.
@MainActor
@Observable
final class ConnectorLibrary {
    private struct File: Codable {
        var version = 1
        var servers: [MCPServerConfig] = []
        var eras = MCPEraCache.Snapshot()
        /// Denylist of disabled tool names per server so newly added tools default to on.
        var disabledTools: [String: Set<String>] = [:]
        var seenTools: [String: Set<String>] = [:]
    }

    private(set) var servers: [MCPServerConfig] = []
    private(set) var authRequirements: [String: MCPAuthRequirement] = [:]
    private(set) var lastErrors: [String: String] = [:]
    private(set) var tools: [String: [MCPToolDefinition]] = [:]
    /// RFC 9728 sign-in advertised despite anonymous response (e.g. tools/list works, call refuses).
    private(set) var signInOffers: [String: MCPSignInOffer] = [:]
    private(set) var signedIn: [String: Bool] = [:]
    private(set) var signingIn: Set<String> = []
    private(set) var prompts: [String: [MCPPrompt]] = [:]
    /// Last tools/list_changed timestamp; existing chats keep frozen tools, new chats get updates.
    private(set) var toolsChangedAt: [String: Date] = [:]
    /// Persisted disabled-tool denylist; frozen chats refuse calls, new chats omit them.
    private(set) var disabledTools: [String: Set<String>] = [:]
    private(set) var seenTools: [String: Set<String>] = [:]

    @ObservationIgnored let fileURL: URL
    @ObservationIgnored let secrets: any SecretStore
    @ObservationIgnored let eraCache: MCPEraCache
    @ObservationIgnored private let transport: any HTTPTransport
    @ObservationIgnored private let auth: MCPAuthEnvironment
    @ObservationIgnored private let elicitation: (any MCPElicitationHandler)?
    @ObservationIgnored private let listensForChanges: Bool
    @ObservationIgnored private var clients: [String: MCPClient] = [:]
    /// Last era snapshot written, so config writes keep it.
    @ObservationIgnored private var lastEras: MCPEraCache.Snapshot

    init(fileURL: URL, secrets: any SecretStore, transport: any HTTPTransport = URLSessionTransport(),
         auth: MCPAuthEnvironment = MCPAuthEnvironment(presenter: nil), elicitation: (any MCPElicitationHandler)? = nil,
         listensForChanges: Bool = false) {
        self.fileURL = fileURL
        self.secrets = secrets
        self.transport = transport
        self.auth = auth
        self.elicitation = elicitation
        self.listensForChanges = listensForChanges
        let file = (try? Data(contentsOf: fileURL)).flatMap { try? JSONDecoder().decode(File.self, from: $0) } ?? File()
        servers = file.servers
        disabledTools = file.disabledTools
        seenTools = file.seenTools
        eraCache = MCPEraCache(snapshot: file.eras)
        lastEras = file.eras
    }

    func server(_ id: String) -> MCPServerConfig? { servers.first { $0.id == id } }

    var defaultConversationServerIDs: [String] { servers.filter(\.enabled).map(\.id) }

    func client(for id: String) -> MCPClient? {
        if let client = clients[id] { return client }
        guard let config = server(id) else { return nil }
        // Client events arrive off MainActor and hop back here to apply.
        let client = MCPClient(config: config, transport: transport, secrets: secrets, eraCache: eraCache,
                               auth: auth, elicitation: elicitation,
                               options: MCPClientOptions(listensForChanges: listensForChanges),
                               onEvent: { [weak self] event in
                                   Task { @MainActor in self?.handle(event, serverID: id) }
                               })
        clients[id] = client
        return client
    }

    func handle(_ event: MCPClientEvent, serverID id: String) {
        guard server(id) != nil else { return }
        switch event {
        case .authorizationRequired(let requirement):
            guard requirement != .none else { return }
            authRequirements[id] = requirement
            signedIn[id] = false
        case .toolsListChanged:
            Task { await refreshTools(id) }
        case .promptsListChanged:
            Task { await loadPrompts(id) }
        case .resourcesListChanged, .resourceUpdated:
            break // the client already dropped its caches
        }
    }

    /// Refreshes tools for new chats after tools/list_changed; frozen chats stay unchanged.
    private func refreshTools(_ id: String) async {
        guard let client = client(for: id), let list = try? await client.listTools(refresh: true) else { return }
        if let old = tools[id], old != list { toolsChangedAt[id] = Date() }
        adoptListing(id, list)
    }

    /// First listing sets the baseline (none marked New); later additions badge until seen.
    private func adoptListing(_ id: String, _ list: [MCPToolDefinition]) {
        if tools[id] == nil {
            seenTools[id, default: []].formUnion(list.map(\.name))
        }
        tools[id] = list
        persist()
    }

    // MARK: Installing

    static func candidate(url: String, name: String? = nil) throws -> MCPInstallCandidate {
        try MCPInstaller.parse(url: url, name: name)
    }

    /// Parses mcp.json-style configs; local-process (stdio) entries are returned in rejected.
    static func candidates(config: String) throws -> MCPImportResult {
        try MCPInstaller.parse(config: config)
    }

    /// Persists config with SecretStore refs only; enabled: false installs provisionally for review.
    @discardableResult
    func install(_ candidate: MCPInstallCandidate, values: [String: String] = [:], trusted: Bool = false,
                 auth: MCPAuthKind? = nil, enabled: Bool = true) throws -> MCPServerConfig {
        var config = try candidate.makeConfig(values: values, secrets: secrets, trusted: trusted)
        if let auth { config.auth = auth }
        config.enabled = enabled
        servers.append(config)
        persist()
        return config
    }

    func review(_ id: String) async throws -> [MCPToolDefinition] {
        guard let client = client(for: id) else { throw MCPInstallError.invalidConfig("That connector isn't installed.") }
        do {
            let tools = try await client.listTools(refresh: true)
            lastErrors[id] = nil
            authRequirements[id] = nil
            adoptListing(id, tools)
            await saveEraSnapshot()
            await checkSignIn(id, client)
            await loadPrompts(id)
            return tools
        } catch {
            note(error, for: id)
            throw error
        }
    }

    private func checkSignIn(_ id: String, _ client: MCPClient) async {
        signedIn[id] = await client.isSignedIn
        guard let config = server(id), config.auth != .headers else {
            signInOffers[id] = nil
            return
        }
        signInOffers[id] = await client.signInOffer()
    }

    private func note(_ error: Error, for id: String) {
        guard server(id) != nil else { return }
        lastErrors[id] = error.localizedDescription
        if case MCPError.authorizationRequired(let requirement) = error, requirement != .none {
            authRequirements[id] = requirement
        }
    }

    /// Closes session and wipes secrets; chats that froze its tools retain them as refused.
    func remove(_ id: String) async {
        guard let config = server(id) else { return }
        servers.removeAll { $0.id == id }
        authRequirements[id] = nil
        lastErrors[id] = nil
        tools[id] = nil
        signInOffers[id] = nil
        signedIn[id] = nil
        prompts[id] = nil
        toolsChangedAt[id] = nil
        disabledTools[id] = nil
        seenTools[id] = nil
        persist()
        if let client = clients.removeValue(forKey: id) {
            await client.signOut()
            await client.close()
        }
        for header in config.headers {
            if case .secret(let key) = header.value { try? secrets.removeSecret(for: key) }
        }
        if case .manualOAuth(_, let key?) = config.auth { try? secrets.removeSecret(for: key) }
    }

    /// Replaces headers (nil secret keeps stored, unused deleted); updates non-OAuth auth.
    func setHeaders(_ id: String, _ edits: [HeaderEdit]) async throws {
        guard let config = server(id) else { return }
        var headers: [MCPHeader] = []
        var kept = Set<String>()
        for edit in edits {
            let name = edit.name.trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { continue }
            if edit.isSecret {
                let key = "mcp.header|\(id)|\(name.lowercased())"
                if let value = edit.value?.trimmingCharacters(in: .whitespaces), !value.isEmpty {
                    try secrets.setSecret(value, for: key)
                } else if !config.headers.contains(where: { $0.value == .secret(key: key) }) {
                    continue // a new secret header with nothing typed
                }
                kept.insert(key)
                headers.append(MCPHeader(name: name, value: .secret(key: key)))
            } else {
                headers.append(MCPHeader(name: name, value: .plain(edit.value ?? "")))
            }
        }
        for header in config.headers {
            if case .secret(let key) = header.value, !kept.contains(key) { try? secrets.removeSecret(for: key) }
        }
        var next = config
        next.headers = headers
        let hasCredential = headers.contains { if case .secret = $0.value { return true }; return false }
        switch next.auth {
        case .none, .headers: next.auth = hasCredential ? .headers : .none
        case .oauth, .manualOAuth: break
        }
        await replace(next)
        authRequirements[id] = nil
        lastErrors[id] = nil
    }

    /// Manual OAuth without DCR; stores secret in SecretStore and defaults empty scopes.
    func setManualOAuth(_ id: String, clientID: String, clientSecret: String?, redirectURI: String? = nil,
                        scopes: [String]? = nil) async throws {
        guard var config = server(id) else { return }
        let key = "mcp.oauth-client|\(id)"
        let secret = clientSecret?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let trimmedID = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        let redirect = redirectURI?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !redirect.isEmpty {
            guard let url = URL(string: redirect), let scheme = url.scheme, !["http", "https"].contains(scheme.lowercased()) else {
                throw MCPInstallError.invalidConfig("The redirect must use the app's own scheme, like com.example.app:/oauth.")
            }
        }
        if secret.isEmpty { try? secrets.removeSecret(for: key) } else { try secrets.setSecret(secret, for: key) }
        // Clear pinned issuer on save so re-saving binds the new credentials to current server issuer.
        try? secrets.removeSecret(for: OAuthKeys.manualIssuer(secretKey: key))
        config.auth = .manualOAuth(clientID: trimmedID, clientSecretKey: secret.isEmpty ? nil : key)
        config.oauthRedirectURI = redirect.isEmpty ? nil : redirect
        config.oauthScopes = scopes.flatMap { $0.isEmpty ? nil : $0 }
        await replace(config)
    }

    func useAutomaticOAuth(_ id: String) async {
        guard var config = server(id), config.auth != .oauth else { return }
        if case .manualOAuth(_, let key?) = config.auth { try? secrets.removeSecret(for: key) }
        config.auth = .oauth
        await replace(config)
    }

    /// Trusted servers' tool annotations are believed by `ToolPolicy`.
    func setTrusted(_ id: String, _ trusted: Bool) async {
        await update(id) { $0.trusted = trusted }
    }

    /// Disabled servers are omitted from new chats and refused by frozen chats until re-enabled.
    func setEnabled(_ id: String, _ enabled: Bool) async {
        await update(id) { $0.enabled = enabled }
    }

    func rename(_ id: String, to name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await update(id) { $0.name = trimmed }
    }

    func replace(_ config: MCPServerConfig) async {
        await update(config.id) { $0 = config }
    }

    private func update(_ id: String, _ change: (inout MCPServerConfig) -> Void) async {
        guard let i = servers.firstIndex(where: { $0.id == id }) else { return }
        var config = servers[i]
        change(&config)
        guard config != servers[i] else { return }
        servers[i] = config
        persist()
        // Drop cached client so the next client(for:) rebuilds with the new config.
        await clients.removeValue(forKey: id)?.close()
    }

    // MARK: Per-tool switches

    func isToolEnabled(_ id: String, tool: String) -> Bool {
        !(disabledTools[id]?.contains(tool) ?? false)
    }

    /// Toggles a tool without rebuilding the client; runtime checks disabledTools on each run.
    func setToolEnabled(_ id: String, tool: String, on: Bool) {
        guard server(id) != nil else { return }
        var off = disabledTools[id, default: []]
        if on { off.remove(tool) } else { off.insert(tool) }
        let next: Set<String>? = off.isEmpty ? nil : off
        guard disabledTools[id] != next else { return }
        disabledTools[id] = next
        persist()
    }

    /// Enabling all clears the denylist so future server tools also start enabled.
    func setAllToolsEnabled(_ id: String, on: Bool) {
        guard server(id) != nil else { return }
        if on {
            guard disabledTools[id] != nil else { return }
            disabledTools[id] = nil
        } else {
            let names = Set((tools[id] ?? []).map(\.name))
            guard !names.isEmpty, disabledTools[id] != names else { return }
            disabledTools[id] = names
        }
        persist()
    }

    func isToolNew(_ id: String, tool: String) -> Bool {
        tools[id] != nil && !(seenTools[id]?.contains(tool) ?? false)
    }

    func markToolsSeen(_ id: String) {
        guard let list = tools[id] else { return }
        var seen = seenTools[id, default: []]
        seen.formUnion(list.map(\.name))
        guard seen != seenTools[id, default: []] else { return }
        seenTools[id] = seen
        persist()
    }

    // MARK: Sign-in

    func signIn(_ id: String, force: Bool = false) async throws {
        guard let client = client(for: id) else { return }
        signingIn.insert(id)
        defer { signingIn.remove(id) }
        do {
            if !force { try await client.connect() }
            let hasTokens = await client.isSignedIn
            if force || !hasTokens { try await client.signIn() }
            authRequirements[id] = nil
            lastErrors[id] = nil
            signedIn[id] = true
            await saveEraSnapshot()
        } catch {
            note(error, for: id)
            throw error
        }
        // Re-list tools and prompts under the newly signed-in identity.
        _ = try? await review(id)
    }

    func signOut(_ id: String) async {
        await client(for: id)?.signOut()
        tools[id] = nil
        signedIn[id] = false
    }

    func signInNeed(_ id: String) -> MCPAuthRequirement? {
        if let requirement = authRequirements[id], requirement != .none { return requirement }
        guard signedIn[id] != true, let offer = signInOffers[id] else { return nil }
        return offer.requirement
    }

    func canSignInDirectly(_ id: String) -> Bool {
        guard let config = server(id) else { return false }
        switch (config.auth, signInNeed(id)) {
        case (.manualOAuth, _): return true
        case (_, .oauthAutomatic?): return true
        case (.oauth, nil): return true
        default: return false
        }
    }

    func signInDirectly(_ id: String) async throws {
        guard let config = server(id) else { return }
        switch config.auth {
        case .none, .headers: await useAutomaticOAuth(id)
        case .oauth, .manualOAuth: break
        }
        try await signIn(id)
    }

    // MARK: Prompts

    /// Fetches prompts silently; skips unauthenticated OAuth servers so it never triggers sign-in.
    func loadPrompts(_ id: String) async {
        guard let client = client(for: id) else { return }
        guard await client.features?.prompts == true else {
            prompts[id] = nil
            return
        }
        if let list = try? await client.listPrompts() { prompts[id] = list }
    }

    func refreshPrompts(for ids: [String]) async {
        for id in ids {
            guard let config = server(id), config.enabled, let client = client(for: id) else { continue }
            if tools[id] == nil {
                switch config.auth {
                case .none, .headers:
                    _ = try? await review(id)
                    continue
                case .oauth, .manualOAuth:
                    guard await client.isSignedIn else { continue }
                }
            }
            await loadPrompts(id)
        }
    }

    func prompt(_ id: String, name: String, arguments: [String: String]) async throws -> MCPPromptResult {
        guard let client = client(for: id) else { throw MCPInstallError.invalidConfig("That connector isn't installed.") }
        return try await client.getPrompt(name, arguments: arguments)
    }

    func record(_ failures: [MCPToolset.Failure]) {
        for failure in failures {
            lastErrors[failure.serverID] = failure.message
            if let requirement = failure.authRequirement { authRequirements[failure.serverID] = requirement }
        }
    }

    // MARK: UI-test seed

    /// UI test mock connector (-PraxisMockConnector YES); pre-populated tools avoid network calls.
    func installMockConnectorIfRequested() {
        guard UserDefaults.standard.bool(forKey: "PraxisMockConnector") else { return }
        guard !servers.contains(where: { $0.id == Self.mockConnectorID }) else { return }
        guard let candidate = try? Self.candidate(url: "https://mock.invalid/mcp", name: "Mock Server"),
              let config = try? install(candidate) else { return }
        // A stable id, so tests can find it.
        servers.removeAll { $0.id == config.id }
        var seeded = config
        seeded.id = Self.mockConnectorID
        servers.append(seeded)
        tools[seeded.id] = [
            MCPToolDefinition(name: "search_docs", title: "Search docs",
                              description: "Searches the documentation for an answer.",
                              annotations: MCPToolAnnotations(readOnlyHint: true)),
            MCPToolDefinition(name: "list_projects",
                              description: "Lists your projects with their status."),
            MCPToolDefinition(name: "create_ticket", title: "Create ticket",
                              description: "Files a new support ticket.",
                              annotations: MCPToolAnnotations(destructiveHint: true)),
        ]
        seenTools[seeded.id] = Set(tools[seeded.id, default: []].map(\.name))
        // UI test flag adding an unseen tool to trigger the New badge.
        if UserDefaults.standard.bool(forKey: "PraxisMockConnectorNewTool") {
            tools[seeded.id]?.append(MCPToolDefinition(name: "summarize_thread", title: "Summarize thread",
                                                       description: "Summarizes the current support thread."))
        }
        persist()
    }

    static let mockConnectorID = "mock-connector"

    // MARK: Persistence

    /// Writes the detected eras so relaunches skip the probe.
    func saveEraSnapshot() async {
        let snapshot = await eraCache.snapshot()
        persist(eras: snapshot)
    }

    private func persist(eras: MCPEraCache.Snapshot? = nil) {
        if let eras { lastEras = eras }
        let file = File(servers: servers, eras: lastEras, disabledTools: disabledTools, seenTools: seenTools)
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(file).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            assertionFailure("ConnectorLibrary write failed: \(error)")
        }
    }
}

/// Header editor row; nil value on a secret header preserves the stored secret.
struct HeaderEdit: Equatable {
    var name: String
    var value: String?
    var isSecret: Bool
}
