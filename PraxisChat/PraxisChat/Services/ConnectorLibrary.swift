import Foundation
import Observation
import AgentCore
import AgentMCP

/// Installed remote MCP servers ("connectors"): their configs, one shared
/// `MCPClient` per server, and the protocol-era cache. Configs and the
/// era snapshot are one JSON file; credentials (header secrets, OAuth
/// tokens) live in the `SecretStore` (Keychain in the app).
///
/// The runtime reaches servers through `client(for:)`; a server that's
/// removed returns nil, so frozen conversations report it as gone. Config
/// changes (enable, trust, rename) replace the client — `MCPClient.config`
/// is immutable, and the runtime always asks for the current one.
///
/// Part B's management UI binds to `servers`, `authRequirements`,
/// `lastErrors` and calls the install / trust / enable / sign-in APIs.
@MainActor
@Observable
final class ConnectorLibrary {
    private struct File: Codable {
        var version = 1
        var servers: [MCPServerConfig] = []
        var eras = MCPEraCache.Snapshot()
        /// Tool names the user turned off, by server id. A denylist, so
        /// tools a server adds later start on.
        var disabledTools: [String: Set<String>] = [:]
        /// Tool names the user has seen in the detail screen, by server
        /// id. Names outside it get a "New" badge once.
        var seenTools: [String: Set<String>] = [:]
    }

    private(set) var servers: [MCPServerConfig] = []
    /// What a server last said it needs before it can be used ("Sign in").
    private(set) var authRequirements: [String: MCPAuthRequirement] = [:]
    /// Last connection / listing error per server, for display.
    private(set) var lastErrors: [String: String] = [:]
    /// Tools from each server's last successful listing this session
    /// (counts in the list, names in the detail screen).
    private(set) var tools: [String: [MCPToolDefinition]] = [:]
    /// Sign-in the server advertises (RFC 9728) even though it answered
    /// without credentials — e.g. Gmail lists tools anonymously and only
    /// refuses `tools/call`. Shown as "Sign-in available".
    private(set) var signInOffers: [String: MCPSignInOffer] = [:]
    /// Whether OAuth tokens are stored, as of the last check.
    private(set) var signedIn: [String: Bool] = [:]
    /// Servers with a sign-in in progress (chat buttons show "Signing in…").
    private(set) var signingIn: Set<String> = []
    /// Prompts of servers that offer them (the tray's prompt list).
    private(set) var prompts: [String: [MCPPrompt]] = [:]
    /// When a server's tool list last changed (`tools/list_changed`).
    /// Conversations keep their frozen tools; new chats get the new ones.
    private(set) var toolsChangedAt: [String: Date] = [:]
    /// Tool names the user turned off, by server id (persisted). New
    /// conversations leave them out; chats that froze them refuse
    /// their calls. Tools a server adds later start on.
    private(set) var disabledTools: [String: Set<String>] = [:]
    /// Tool names the user has seen in the detail screen, by server id
    /// (persisted). Anything else listed gets a "New" badge once.
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

    /// `listensForChanges`: keep change-notification streams open for
    /// servers that announce list changes (off in tests).
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

    /// Servers a new conversation starts with (the per-conversation
    /// toggles start from these).
    var defaultConversationServerIDs: [String] { servers.filter(\.enabled).map(\.id) }

    /// The shared client for an installed server; nil once it's removed.
    func client(for id: String) -> MCPClient? {
        if let client = clients[id] { return client }
        guard let config = server(id) else { return nil }
        // Events arrive off the main actor (tool calls, notification
        // streams); they're applied here.
        let client = MCPClient(config: config, transport: transport, secrets: secrets, eraCache: eraCache,
                               auth: auth, elicitation: elicitation,
                               options: MCPClientOptions(listensForChanges: listensForChanges),
                               onEvent: { [weak self] event in
                                   Task { @MainActor in self?.handle(event, serverID: id) }
                               })
        clients[id] = client
        return client
    }

    /// A client event: a refused call marks the server as needing sign-in;
    /// list changes refresh what new chats will get.
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

    /// Re-lists after `tools/list_changed`. Frozen conversations are left
    /// alone (their tool list can't change); new chats freeze the new list.
    private func refreshTools(_ id: String) async {
        guard let client = client(for: id), let list = try? await client.listTools(refresh: true) else { return }
        if let old = tools[id], old != list { toolsChangedAt[id] = Date() }
        adoptListing(id, list)
    }

    /// Keeps a fresh listing. The first listing is the baseline (nothing
    /// in it is "New"); names that appear in later listings badge until
    /// the user looks at them (`markToolsSeen`).
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

    /// Pasted `mcp.json` / Claude Desktop / VS Code / registry JSON.
    /// Entries that would run a local process come back in `rejected`.
    static func candidates(config: String) throws -> MCPImportResult {
        try MCPInstaller.parse(config: config)
    }

    /// Installs a candidate once its inputs are filled in. Secret values
    /// go to the `SecretStore`; the persisted config only references them.
    /// Call `review(_:)` next to connect and show the tools.
    /// `enabled: false` installs provisionally (the add flow, while the
    /// user reviews the tools): new chats leave it out until confirmed.
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

    /// Connects (signing in if the server asks and the config is OAuth)
    /// and lists the tools, e.g. to review them right after install.
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

    /// Whether we hold tokens, and — unless credentials travel in headers —
    /// whether the server advertises sign-in even though it answered
    /// anonymously (some servers only refuse `tools/call`).
    private func checkSignIn(_ id: String, _ client: MCPClient) async {
        signedIn[id] = await client.isSignedIn
        guard let config = server(id), config.auth != .headers else {
            signInOffers[id] = nil
            return
        }
        signInOffers[id] = await client.signInOffer()
    }

    /// Keeps what a failure says the server needs ("Sign in", a token…).
    private func note(_ error: Error, for id: String) {
        guard server(id) != nil else { return }
        lastErrors[id] = error.localizedDescription
        if case MCPError.authorizationRequired(let requirement) = error, requirement != .none {
            authRequirements[id] = requirement
        }
    }

    /// Removes a server: closes its session, forgets its tokens and secrets.
    /// Conversations that froze its tools keep them, refused as removed.
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

    /// Replaces the static headers. `value: nil` on a secret header keeps
    /// the stored secret; secrets no longer referenced are deleted. Auth
    /// follows: credentials in headers → `.headers`, none → `.none`
    /// (OAuth kinds are left alone).
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

    /// Sign-in through a client the user registered with the provider
    /// (servers without Dynamic Client Registration). The secret, if
    /// any, goes to the `SecretStore`.
    /// `redirectURI`: the redirect registered with that client when it
    /// isn't Praxis's default (e.g. Google's reversed-client-ID scheme).
    /// `scopes`: what to ask for; nil/empty = least-privilege defaults
    /// (`MCPScopeSelection`: Google's Gmail pair, else what the server lists).
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
        // Fresh credentials, fresh issuer binding: re-saving is how the user
        // confirms these credentials for whatever issuer the server now names.
        try? secrets.removeSecret(for: OAuthKeys.manualIssuer(secretKey: key))
        config.auth = .manualOAuth(clientID: trimmedID, clientSecretKey: secret.isEmpty ? nil : key)
        config.oauthRedirectURI = redirect.isEmpty ? nil : redirect
        config.oauthScopes = scopes.flatMap { $0.isEmpty ? nil : $0 }
        await replace(config)
    }

    /// Switches a server to OAuth with automatic registration, e.g. when
    /// it answered 401 and offers sign-in.
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

    /// Turned-off servers are left out of new conversations, and frozen
    /// conversations refuse their tools until they're back on.
    func setEnabled(_ id: String, _ enabled: Bool) async {
        await update(id) { $0.enabled = enabled }
    }

    func rename(_ id: String, to name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        await update(id) { $0.name = trimmed }
    }

    /// Replaces a config wholesale (headers, auth kind, URL).
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
        // The next `client(for:)` builds one from the new config.
        await clients.removeValue(forKey: id)?.close()
    }

    // MARK: Per-tool switches

    func isToolEnabled(_ id: String, tool: String) -> Bool {
        !(disabledTools[id]?.contains(tool) ?? false)
    }

    /// Turns one tool off (or back on). Off tools are left out of new
    /// conversations; chats that froze them refuse their calls. Unlike
    /// `update`, this never rebuilds the client: the runtime reads the
    /// live set on every run.
    func setToolEnabled(_ id: String, tool: String, on: Bool) {
        guard server(id) != nil else { return }
        var off = disabledTools[id, default: []]
        if on { off.remove(tool) } else { off.insert(tool) }
        let next: Set<String>? = off.isEmpty ? nil : off
        guard disabledTools[id] != next else { return }
        disabledTools[id] = next
        persist()
    }

    /// "Enable all" clears the list (tools the server adds later start
    /// on); "Disable all" turns off every currently listed tool.
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

    /// Whether the tool arrived after the user last looked at the list
    /// (it gets a "New" badge once).
    func isToolNew(_ id: String, tool: String) -> Bool {
        tools[id] != nil && !(seenTools[id]?.contains(tool) ?? false)
    }

    /// The user looked at the connector's tools: nothing in the current
    /// list is "New" anymore.
    func markToolsSeen(_ id: String) {
        guard let list = tools[id] else { return }
        var seen = seenTools[id, default: []]
        seen.formUnion(list.map(\.name))
        guard seen != seenTools[id, default: []] else { return }
        seenTools[id] = seen
        persist()
    }

    // MARK: Sign-in

    /// Signs in through the OAuth presenter ("Sign in"). Connecting may
    /// already do it (a server that answers 401 at once); a server that
    /// answered anonymously gets an explicit sign-in. `force` signs in
    /// again even with tokens stored ("Sign in again").
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
        // Tools (and prompts) as the signed-in user sees them.
        _ = try? await review(id)
    }

    func signOut(_ id: String) async {
        await client(for: id)?.signOut()
        tools[id] = nil
        signedIn[id] = false
    }

    /// What the server needs, from a refused call or its advertised
    /// sign-in, while we hold no tokens.
    func signInNeed(_ id: String) -> MCPAuthRequirement? {
        if let requirement = authRequirements[id], requirement != .none { return requirement }
        guard signedIn[id] != true, let offer = signInOffers[id] else { return nil }
        return offer.requirement
    }

    /// Whether a tap can sign in right away (no form to fill): the client
    /// is configured, or the server registers apps automatically.
    func canSignInDirectly(_ id: String) -> Bool {
        guard let config = server(id) else { return false }
        switch (config.auth, signInNeed(id)) {
        case (.manualOAuth, _): return true
        case (_, .oauthAutomatic?): return true
        case (.oauth, nil): return true
        default: return false
        }
    }

    /// "Sign in to <server>" from a chat step: switches a plain config to
    /// OAuth when the server registers apps itself, then signs in.
    func signInDirectly(_ id: String) async throws {
        guard let config = server(id) else { return }
        switch config.auth {
        case .none, .headers: await useAutomaticOAuth(id)
        case .oauth, .manualOAuth: break
        }
        try await signIn(id)
    }

    // MARK: Prompts

    /// Lists a server's prompts if it offers them. Never opens a sign-in
    /// sheet: OAuth servers are only asked once signed in.
    func loadPrompts(_ id: String) async {
        guard let client = client(for: id) else { return }
        guard await client.features?.prompts == true else {
            prompts[id] = nil
            return
        }
        if let list = try? await client.listPrompts() { prompts[id] = list }
    }

    /// Prompts for the tray: checks servers not looked at this session
    /// (plain ones by listing; OAuth ones only when signed in).
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

    /// Fetches a prompt the user picked.
    func prompt(_ id: String, name: String, arguments: [String: String]) async throws -> MCPPromptResult {
        guard let client = client(for: id) else { throw MCPInstallError.invalidConfig("That connector isn't installed.") }
        return try await client.getPrompt(name, arguments: arguments)
    }

    /// Notes what servers that failed to list their tools need, so the UI
    /// can offer "Sign in" (from `AgentRuntime.prepare` failures).
    func record(_ failures: [MCPToolset.Failure]) {
        for failure in failures {
            lastErrors[failure.serverID] = failure.message
            if let requirement = failure.authRequirement { authRequirements[failure.serverID] = requirement }
        }
    }

    // MARK: UI-test seed

    /// `-PraxisMockConnector YES` (UI tests): installs a hermetic
    /// connector with scripted tools. Nothing reaches the network: the
    /// install only parses a URL, and the detail screen never refreshes
    /// it because a listing is already there.
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

/// One row of the headers editor. `value` nil on a secret = keep the
/// stored one.
struct HeaderEdit: Equatable {
    var name: String
    var value: String?
    var isSecret: Bool
}
