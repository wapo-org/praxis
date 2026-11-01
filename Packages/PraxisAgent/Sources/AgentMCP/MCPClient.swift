import Foundation
import AgentCore

public struct MCPClientOptions: Sendable {
    public var clientInfo: MCPClientInfo
    /// Discovery, initialize, tools/list.
    public var requestTimeout: Duration
    /// Default per `tools/call` (includes any elicitation round trips).
    public var callTimeout: Duration
    /// Tool-list cache lifetime when the server sends no `ttlMs`.
    public var defaultToolListTTL: Duration
    /// Cap on MRTR `input_required` rounds per call.
    public var maxInputRounds: Int
    /// Keep a change-notification stream open (`subscriptions/listen`, or
    /// the legacy GET stream) while connected, for servers that announce
    /// list changes or resource subscriptions. Off for one-shot clients.
    public var listensForChanges: Bool
    /// Delay before the n-th reconnect of a dropped notification stream;
    /// the stream gives up after `maxListenFailures` drops in a row (any
    /// later request re-arms it).
    public var listenBackoff: @Sendable (_ failures: Int) -> Duration
    public var maxListenFailures: Int
    public var now: @Sendable () -> Date

    public init(clientInfo: MCPClientInfo = MCPClientInfo(name: "Praxis Chat", version: "1.0"),
                requestTimeout: Duration = .seconds(30), callTimeout: Duration = .seconds(120),
                defaultToolListTTL: Duration = .seconds(3600), maxInputRounds: Int = 4,
                listensForChanges: Bool = false,
                listenBackoff: @escaping @Sendable (_ failures: Int) -> Duration = { .seconds(min(60, 1 << min($0, 6))) },
                maxListenFailures: Int = 5,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.clientInfo = clientInfo
        self.requestTimeout = requestTimeout
        self.callTimeout = callTimeout
        self.defaultToolListTTL = defaultToolListTTL
        self.maxInputRounds = maxInputRounds
        self.listensForChanges = listensForChanges
        self.listenBackoff = listenBackoff
        self.maxListenFailures = maxListenFailures
        self.now = now
    }
}



/// An elicitation handler that tags each request with the run that
/// asked, so stopping one run resolves only its own waiters. Clients
/// call the scoped entry point when the handler supports it and fall
/// back to the plain one otherwise.
public protocol RunScopedElicitationHandler: MCPElicitationHandler {
    // UUID, not AnyHashable: the scope crosses isolations and
    // AnyHashable's Sendable conformance is explicitly unavailable.
    func elicit(_ request: MCPElicitation, scope: UUID?) async -> MCPElicitationResult
}

/// One remote MCP server. Connects lazily on first use, detecting the
/// protocol era (modern → legacy Streamable HTTP → HTTP+SSE) and caching
/// it per origin. Safe to call concurrently; calls run in parallel.
///
/// Also: resources (list, templates, read with a small cache), prompts,
/// and change notifications (`subscriptions/listen` on modern servers,
/// the GET stream on legacy ones) when `listensForChanges` is on.
/// Not implemented: SSE resumability, sampling, roots, completion.
public actor MCPClient {
    public nonisolated let config: MCPServerConfig
    private let transport: any HTTPTransport
    private let secrets: any SecretStore
    private let eraCache: MCPEraCache
    private let options: MCPClientOptions
    private let elicitation: (any MCPElicitationHandler)?
    private let oauth: MCPOAuthSession?
    private let onEvent: (@Sendable (MCPClientEvent) -> Void)?

    private struct Connection: Sendable {
        var generation: Int
        var era: MCPEra
        var protocolVersion: String
        var sessionID: String?
        var channel: LegacySSEChannel?
        var info: MCPServerInfo
    }

    private struct ToolCache {
        var tools: [MCPToolDefinition]
        var expires: Date
    }

    private var connection: Connection?
    private var connecting: Task<Connection, Error>?
    private var generation = 0
    private var nextID = 0
    private var toolCache: ToolCache?
    private var listing: Task<[MCPToolDefinition], Error>?
    private var promptCache: (prompts: [MCPPrompt], expires: Date)?
    private var readCache: [String: (contents: [MCPResourceContents], expires: Date)] = [:]
    /// Resources watched for `notifications/resources/updated`.
    private var subscribedURIs: [String] = []
    private var offerCache: MCPSignInOffer??
    private var listener: Task<Void, Never>?
    private var listenerID = 0
    /// The server has no notification stream (or nothing to listen for)
    /// on this connection generation; don't keep asking.
    private var listenUnsupportedGeneration: Int?
    /// Tools dropped from the last listing, with the reason (invalid
    /// `x-mcp-header` annotations).
    public private(set) var rejectedTools: [String: String] = [:]
    /// The last tools/prompts listing hit the list caps below: only the
    /// first entries were kept. Providers take ~128 tools, so anything past
    /// the cap is either a broken or a hostile server.
    public private(set) var toolListTruncated = false
    public private(set) var promptListTruncated = false

    /// A hostile server must not stuff gigabytes into the catalog through
    /// `nextCursor` paging: at most this many entries and retained bytes.
    private static let maxListedTools = 500
    private static let maxListedToolBytes = 4 << 20
    private static let maxListedPrompts = 200
    private static let maxListedPromptBytes = 1 << 20
    private static let maxListedTemplates = 200
    private static let maxListedTemplateBytes = 1 << 20

    public init(config: MCPServerConfig, transport: any HTTPTransport = URLSessionTransport(), secrets: any SecretStore,
                eraCache: MCPEraCache = MCPEraCache(), auth: MCPAuthEnvironment? = nil,
                elicitation: (any MCPElicitationHandler)? = nil, options: MCPClientOptions = MCPClientOptions(),
                onEvent: (@Sendable (MCPClientEvent) -> Void)? = nil) {
        self.config = config
        self.transport = transport
        self.secrets = secrets
        self.eraCache = eraCache
        self.options = options
        self.elicitation = elicitation
        self.onEvent = onEvent
        let manual: (id: String, secretKey: String?)?
        switch config.auth {
        case .oauth: manual = nil
        case .manualOAuth(let id, let key): manual = (id, key)
        case .none, .headers: manual = nil
        }
        switch config.auth {
        case .oauth, .manualOAuth:
            self.oauth = MCPOAuthSession(serverURL: config.url, transport: transport, secrets: secrets,
                                         environment: auth ?? MCPAuthEnvironment(presenter: nil), manualClient: manual,
                                         manualRedirectURI: config.oauthRedirectURI, scopes: config.oauthScopes)
        case .none, .headers:
            self.oauth = nil
        }
    }

    public nonisolated var source: ToolSource { config.source }

    public var serverInfo: MCPServerInfo? { connection?.info }

    /// Connects (signing in through the presenter if the server asks and
    /// the config is OAuth). Throws `MCPError.authorizationRequired` with
    /// what the UI should offer when credentials are missing.
    @discardableResult
    public func connect() async throws -> MCPServerInfo {
        try await connected().info
    }

    /// Tools, cached for the server's `ttlMs` (or `defaultToolListTTL`).
    public func listTools(refresh: Bool = false) async throws -> [MCPToolDefinition] {
        if !refresh, let cache = toolCache, cache.expires > options.now() { return cache.tools }
        if let listing { return try await listing.value }
        let task = Task { try await self.fetchTools() }
        listing = task
        defer { listing = nil }
        return try await task.value
    }

    /// What the server said it supports, once connected.
    public var features: MCPServerFeatures? { connection.map { MCPServerFeatures(capabilities: $0.info.capabilities) } }

    /// Calls a tool. Cancelling the task cancels the call on the server
    /// (closing the stream on modern servers, `notifications/cancelled`
    /// on legacy ones).
    ///
    /// Never opens the sign-in sheet: a server that wants credentials
    /// (401, 403 `insufficient_scope`, or an auth-looking error from a
    /// server that advertises sign-in) fails the call with
    /// `MCPError.authorizationRequired` and reports
    /// `MCPClientEvent.authorizationRequired`.
    public func callTool(_ name: String, arguments: JSONValue = [:], timeout: Duration? = nil,
                         elicitationScope: UUID? = nil,
                         progress: (@Sendable (MCPProgress) -> Void)? = nil) async throws -> MCPCallResult {
        // The scope stays before `progress` so existing trailing-closure
        // calls keep compiling. Unnamed calls read the ambient run scope.
        let scope = elicitationScope ?? ElicitationScope.current
        let result = try await agentRequest(timeout: timeout ?? options.callTimeout) {
            try await self.performCall(name, arguments: arguments, progress: progress, elicitationScope: scope)
        }
        if result.isError, let requirement = await missingCredentials(in: result.content.compactMap(\.textValue).joined(separator: "\n")) {
            emit(.authorizationRequired(requirement))
            throw MCPError.authorizationRequired(requirement)
        }
        return result
    }

    /// Runs a request made on the agent's behalf (`work` must pass
    /// `interactive: false` down): auth failures classified and reported.
    ///
    /// Tool calls, resource reads and the notification stream never open
    /// the sign-in sheet: the agent is mid-run, so they fail with
    /// `authorizationRequired` (and an event) instead, and the user signs
    /// in from the chat when they choose to.
    private func agentRequest<T: Sendable>(timeout: Duration, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        do {
            return try await withDeadline(timeout, work)
        } catch let error as MCPError {
            throw await classify(error)
        }
    }

    private func classify(_ error: MCPError) async -> MCPError {
        switch error {
        case .authorizationRequired(let requirement):
            emit(.authorizationRequired(requirement))
            return error
        case .server(_, let message, _), .http(_, let message):
            guard let requirement = await missingCredentials(in: message) else { return error }
            emit(.authorizationRequired(requirement))
            return .authorizationRequired(requirement)
        default:
            return error
        }
    }

    /// An error that reads like "you're not signed in", from a server that
    /// advertises sign-in while we hold no token for it. Status codes are
    /// handled in `send`; this catches servers that put the refusal in a
    /// 200 body instead.
    private func missingCredentials(in text: String) async -> MCPAuthRequirement? {
        guard MCPAuthHeuristics.looksLikeMissingCredentials(text), config.auth != .headers,
              await oauth?.isSignedIn() != true, let offer = await signInOffer() else { return nil }
        return signInRequirement(for: offer)
    }

    private func signInRequirement(for offer: MCPSignInOffer) -> MCPAuthRequirement {
        switch (config.auth, offer.requirement) {
        case (.manualOAuth, .oauthNeedsClientCredentials(let issuer)): return .oauthAutomatic(issuer: issuer)
        default: return offer.requirement
        }
    }

    // MARK: - Sign-in

    /// Whether signing in is possible according to the server's RFC 9728
    /// metadata — also for servers that answer anonymously until a tool
    /// call. Cached per client; nil when the server publishes none.
    public func signInOffer(refresh: Bool = false) async -> MCPSignInOffer? {
        if !refresh, let cached = offerCache { return cached }
        let found = await OAuthDiscovery(transport: transport, serverURL: config.url).offer()
        offerCache = .some(found)
        return found
    }

    /// Whether OAuth tokens are stored for this server.
    public var isSignedIn: Bool {
        get async { await oauth?.isSignedIn() ?? false }
    }

    /// Explicit sign-in through the presenter, even if the server hasn't
    /// refused anything yet. Requires an OAuth config (`.oauth` or
    /// `.manualOAuth`); the app switches the config first.
    public func signIn() async throws {
        guard let oauth else {
            throw MCPError.authorizationRequired(await signInOffer()?.requirement ?? .tokenHeader)
        }
        try await oauth.signIn()
        // Anything fetched anonymously may differ now.
        if let c = connection { await drop(c) }
        toolCache = nil
        promptCache = nil
        readCache = [:]
    }

    /// Ends a legacy session (HTTP DELETE) or event stream. Call when the
    /// server is removed or disabled.
    public func close() async {
        stopListening()
        guard let c = connection else { return }
        connection = nil
        toolCache = nil
        promptCache = nil
        readCache = [:]
        switch c.era {
        case .legacyStreamableHTTP:
            guard c.sessionID != nil else { return }
            var request = URLRequest(url: config.url)
            request.httpMethod = "DELETE"
            for (k, v) in legacyHeaders(c) { request.setValue(v, forHTTPHeaderField: k) }
            _ = try? await send(request, interactive: false).collect(limit: 64 << 10) // 405 is fine: the server keeps sessions itself
        case .legacySSE:
            await c.channel?.close()
        case .modern:
            break
        }
    }

    /// Forgets OAuth tokens for this server (keeps the client registration).
    public func signOut() async {
        await oauth?.signOut()
        stopListening()
        connection = nil
        toolCache = nil
        promptCache = nil
        readCache = [:]
    }

    // MARK: - Tools

    private func fetchTools() async throws -> [MCPToolDefinition] {
        let modern = try await connected().era == .modern
        var tools: [MCPToolDefinition] = []
        var names = Set<String>()
        var cursors = Set<String>()
        var cursor: String?
        var ttlMs: Double?
        var rejected: [String: String] = [:]
        var keptBytes = 0
        var truncated = false
        paging: for _ in 0..<100 {
            var params: [String: JSONValue] = [:]
            if let cursor { params["cursor"] = .string(cursor) }
            let page = params
            let result = try await withDeadline(options.requestTimeout) { try await self.rpc("tools/list", page) }
            if let ms = result["ttlMs"]?.doubleValue { ttlMs = min(ttlMs ?? ms, ms) }
            for item in result["tools"]?.arrayValue ?? [] {
                guard tools.count + rejected.count < Self.maxListedTools else { truncated = true; break paging }
                guard let tool = MCPToolDefinition(json: item), names.insert(tool.name).inserted else { continue }
                // Malformed x-mcp-header → exclude that tool only (spec MUST).
                if modern, case .failure(let problem) = MCPWire.headerBindings(in: tool.inputSchema) {
                    rejected[tool.name] = problem.reason
                    continue
                }
                keptBytes += item.encodedString().utf8.count
                guard keptBytes <= Self.maxListedToolBytes else { truncated = true; break paging }
                tools.append(tool)
            }
            guard let next = result["nextCursor"]?.stringValue, !next.isEmpty, cursors.insert(next).inserted else { break }
            cursor = next
        }
        let lifetime = ttlMs.map { $0 / 1000 } ?? Double(options.defaultToolListTTL.components.seconds)
        toolCache = ToolCache(tools: tools, expires: options.now().addingTimeInterval(max(0, lifetime)))
        rejectedTools = rejected
        toolListTruncated = truncated
        return tools
    }

    private func performCall(_ name: String, arguments: JSONValue, progress: (@Sendable (MCPProgress) -> Void)?,
                               elicitationScope: UUID?) async throws -> MCPCallResult {
        var definition = toolCache?.tools.first { $0.name == name }
        var inputResponses: JSONValue?
        var requestState: String?
        var retriedHeaders = false
        var retriedURLElicitation = false
        var rounds = 0
        while true {
            var params: [String: JSONValue] = ["name": .string(name), "arguments": arguments]
            if let inputResponses { params["inputResponses"] = inputResponses }
            if let requestState { params["requestState"] = .string(requestState) }
            let result: JSONValue
            do {
                result = try await rpc("tools/call", params, name: name, headerSchema: definition?.inputSchema,
                                       arguments: arguments, progress: progress, interactive: false)
            } catch MCPError.server(let code, _, _) where code == MCPError.headerMismatch && !retriedHeaders {
                // Our cached schema is stale: re-list and resend with the
                // right Mcp-Param-* headers.
                retriedHeaders = true
                definition = try await listTools(refresh: true).first { $0.name == name }
                continue
            } catch MCPError.server(let code, let message, let data) where code == MCPError.urlElicitationRequired && !retriedURLElicitation {
                retriedURLElicitation = true
                try await satisfyURLElicitations(data, otherwise: .server(code: code, message: message, data: data),
                                                 scope: elicitationScope)
                continue
            }
            // Legacy results have no resultType: "complete" by spec.
            guard result["resultType"]?.stringValue == "input_required" else { return MCPCallResult(json: result) }
            rounds += 1
            guard rounds <= options.maxInputRounds else {
                throw MCPError.inputUnavailable("\(config.name) kept asking for more input.")
            }
            (inputResponses, requestState) = try await gatherInput(result, scope: elicitationScope)
        }
    }

    /// Asks through the scoped entry point when the handler supports it,
    /// else the plain one (an unscoped handler still answers).
    private func askElicitation(_ handler: any MCPElicitationHandler, _ request: MCPElicitation,
                                scope: UUID?) async -> MCPElicitationResult {
        if let scoped = handler as? any RunScopedElicitationHandler {
            return await scoped.elicit(request, scope: scope)
        }
        return await handler.elicit(request)
    }

    /// MRTR: answers `inputRequests` and returns what the retry carries.
    private func gatherInput(_ result: JSONValue, scope: UUID?) async throws -> (JSONValue?, String?) {
        let state = result["requestState"]?.stringValue
        guard let requests = result["inputRequests"]?.objectValue, !requests.isEmpty else { return (nil, state) }
        guard let elicitation else {
            throw MCPError.inputUnavailable("\(config.name) asked for input, but no input UI is available here.")
        }
        var responses: [String: JSONValue] = [:]
        for (key, request) in requests.sorted(by: { $0.key < $1.key }) {
            let method = request["method"]?.stringValue ?? "?"
            guard method == "elicitation/create", let e = MCPElicitation(params: request["params"] ?? [:], server: config) else {
                throw MCPError.inputUnavailable("\(config.name) asked for \(method), which isn't supported.")
            }
            responses[key] = await askElicitation(elicitation, e, scope: scope).json
        }
        return (.object(responses), state)
    }

    /// Legacy `URLElicitationRequiredError` (-32042): ask the user to open
    /// each URL, then retry the call once.
    private func satisfyURLElicitations(_ data: JSONValue?, otherwise error: MCPError, scope: UUID?) async throws {
        let items = data?["elicitations"]?.arrayValue ?? []
        guard let elicitation, !items.isEmpty else { throw error }
        for item in items {
            guard let request = MCPElicitation(params: item, server: config), case .url = request.kind,
                  case .accept = await askElicitation(elicitation, request, scope: scope) else { throw error }
        }
    }

    // MARK: - Requests

    private func takeID() -> Int {
        nextID += 1
        return nextID
    }

    /// `interactive: false` = a 401 never opens the sign-in sheet (see
    /// `agentRequest`).
    private func rpc(_ method: String, _ params: [String: JSONValue], name: String? = nil, headerSchema: JSONValue? = nil,
                     arguments: JSONValue? = nil, progress: (@Sendable (MCPProgress) -> Void)? = nil,
                     interactive: Bool = true) async throws -> JSONValue {
        var replayed = false
        while true {
            let c = try await connected(interactive: interactive)
            do {
                switch c.era {
                case .modern:
                    let extra = MCPWire.paramHeaders(schema: headerSchema, arguments: arguments ?? [:])
                    return try await modernRequest(method, params, name: name, extraHeaders: extra, progress: progress,
                                                   interactive: interactive)
                case .legacyStreamableHTTP:
                    return try await legacyRequest(c, method, params, progress: progress, interactive: interactive)
                case .legacySSE:
                    return try await eventStreamRequest(c, method, params, progress: progress, interactive: interactive)
                }
            } catch is SessionLost {
                // Session expired (404) or the stream is gone before the
                // request was sent: reconnect and replay once.
                guard !replayed else { throw MCPError.protocolViolation("the server keeps dropping the session") }
                replayed = true
                await drop(c)
            }
        }
    }

    private func modernRequest(_ method: String, _ params: [String: JSONValue], name: String?, extraHeaders: [String: String],
                               progress: (@Sendable (MCPProgress) -> Void)?, interactive: Bool) async throws -> JSONValue {
        let id = takeID()
        var p = params
        p["_meta"] = modernMeta(progressToken: progress == nil ? nil : id)
        let headers = modernHeaders(method: method, name: name).merging(extraHeaders) { a, _ in a }
        // Closing this stream (task cancellation) is the cancel signal.
        let response = try await send(makePOST(config.url, RPC.request(id: id, method: method, params: .object(p)), headers: headers),
                                      interactive: interactive)
        guard response.head.isSuccess else { throw await MCPWire.failure(response).error }
        return try await MCPWire.readReply(response, id: id, handlers: handlers(requestID: id, progress: progress, legacy: nil))
    }

    private func legacyRequest(_ c: Connection, _ method: String, _ params: [String: JSONValue],
                               progress: (@Sendable (MCPProgress) -> Void)?, interactive: Bool) async throws -> JSONValue {
        let id = takeID()
        var p = params
        if progress != nil { p["_meta"] = ["progressToken": .number(Double(id))] }
        let body = RPC.request(id: id, method: method, params: .object(p))
        return try await withTaskCancellationHandler {
            let response = try await send(makePOST(config.url, body, headers: legacyHeaders(c)), interactive: interactive)
            if response.head.status == 404, c.sessionID != nil { throw SessionLost() }
            guard response.head.isSuccess else { throw await MCPWire.failure(response).error }
            return try await MCPWire.readReply(response, id: id, handlers: handlers(requestID: id, progress: progress, legacy: c))
        } onCancel: {
            // Disconnecting isn't cancellation on legacy servers.
            Task { await self.sendCancelled(id, on: c) }
        }
    }

    private func eventStreamRequest(_ c: Connection, _ method: String, _ params: [String: JSONValue],
                                    progress: (@Sendable (MCPProgress) -> Void)?,
                                    interactive: Bool) async throws -> JSONValue {
        guard let channel = c.channel, await !channel.isClosed else { throw SessionLost() }
        let id = takeID()
        var p = params
        if progress != nil { p["_meta"] = ["progressToken": .number(Double(id))] }
        return try await channel.request(id: id, message: RPC.request(id: id, method: method, params: .object(p)), progress: progress,
                                         interactive: interactive)
    }

    private func handlers(requestID: Int, progress: (@Sendable (MCPProgress) -> Void)?, legacy: Connection?) -> StreamHandlers {
        StreamHandlers(
            notification: { [weak self] method, params in
                if method == "notifications/progress" {
                    if let progress, RPC.matches(params["progressToken"], requestID) {
                        progress(MCPProgress(progress: params["progress"]?.doubleValue ?? 0, total: params["total"]?.doubleValue,
                                             message: params["message"]?.stringValue))
                    }
                    return
                }
                await self?.handleNotification(method, params)
            },
            request: { [weak self] id, method, params in
                // Modern servers must not send requests (MRTR instead).
                guard let self, let legacy else { return }
                let reply = await self.reply(to: id, method: method, params: params)
                await self.postReply(reply, on: legacy)
            })
    }

    private func handleNotification(_ method: String, _ params: JSONValue) {
        switch method {
        case "notifications/tools/list_changed":
            toolCache = nil
            emit(.toolsListChanged)
        case "notifications/prompts/list_changed":
            promptCache = nil
            emit(.promptsListChanged)
        case "notifications/resources/list_changed":
            emit(.resourcesListChanged)
        case "notifications/resources/updated":
            guard let uri = params["uri"]?.stringValue else { return }
            readCache[uri] = nil
            emit(.resourceUpdated(uri: uri))
        default:
            break
        }
    }

    private func emit(_ event: MCPClientEvent) { onEvent?(event) }

    /// Answers a legacy server→client request.
    private func reply(to id: JSONValue, method: String, params: JSONValue) async -> JSONValue {
        switch method {
        case "ping":
            return RPC.result(id: id, [:])
        case "elicitation/create":
            guard let elicitation else {
                return RPC.error(id: id, code: MCPError.methodNotFound, message: "Elicitation isn't supported by this client")
            }
            guard let request = MCPElicitation(params: params, server: config) else {
                return RPC.error(id: id, code: MCPError.invalidParams, message: "Unsupported elicitation mode")
            }
            // The wire carries no call context here; the ambient scope is
            // right when the call's own task consumes the stream.
            return RPC.result(id: id, await askElicitation(elicitation, request, scope: ElicitationScope.current).json)
        default:
            return RPC.error(id: id, code: MCPError.methodNotFound, message: "Method not found: \(method)")
        }
    }

    private func postReply(_ reply: JSONValue, on c: Connection) async {
        _ = try? await send(makePOST(config.url, reply, headers: legacyHeaders(c)), interactive: false).collect(limit: 64 << 10)
    }

    private func sendCancelled(_ id: Int, on c: Connection) async {
        let note = RPC.notification("notifications/cancelled", params: ["requestId": .number(Double(id)), "reason": "Cancelled by the client"])
        _ = try? await send(makePOST(config.url, note, headers: legacyHeaders(c)), interactive: false).collect(limit: 64 << 10)
    }

    // MARK: - Connection

    private func connected(interactive: Bool = true) async throws -> Connection {
        if let connection {
            armListener(connection)
            return connection
        }
        if let connecting { return try await connecting.value }
        let task = Task { try await self.establish(interactive: interactive) }
        connecting = task
        defer { connecting = nil }
        let c = try await task.value
        connection = c
        armListener(c)
        return c
    }

    private func drop(_ c: Connection) async {
        if connection?.generation == c.generation { connection = nil }
        await c.channel?.close()
    }

    private func establish(interactive: Bool) async throws -> Connection {
        for era in await eraCache.order(for: config.url, hint: config.transportHint) {
            let attempt: Connection?
            switch era {
            case .modern: attempt = try await probeModern(interactive: interactive)
            case .legacyStreamableHTTP: attempt = try await initializeLegacy(interactive: interactive)
            case .legacySSE: attempt = try await openEventStream(interactive: interactive)
            }
            if let attempt {
                await eraCache.record(era, for: config.url)
                return attempt
            }
        }
        throw MCPError.unsupportedServer("\(config.url.host() ?? "The server") doesn't speak a supported version of MCP over HTTP.")
    }

    /// Modern probe. Returns nil when the server is legacy (so the next
    /// era is tried); throws for real failures (auth, network, 5xx).
    private func probeModern(interactive: Bool) async throws -> Connection? {
        let id = takeID()
        let body = RPC.request(id: id, method: "server/discover", params: ["_meta": modernMeta(progressToken: nil)])
        let response = try await send(makePOST(config.url, body, headers: modernHeaders(method: "server/discover", name: nil)),
                                      interactive: interactive)
        guard response.head.isSuccess else {
            let failure = await MCPWire.failure(response)
            if case .server(let code, _, let data)? = failure.rpc { return try modernVerdict(code: code, data: data, error: failure.error) }
            if Self.indicatesOtherEra(failure.status) { return nil }
            throw failure.error
        }
        let result: JSONValue
        do {
            result = try await withDeadline(options.requestTimeout) {
                try await MCPWire.readReply(response, id: id, handlers: .ignoring)
            }
        } catch MCPError.server(let code, let message, let data) {
            return try modernVerdict(code: code, data: data, error: .server(code: code, message: message, data: data))
        } catch MCPError.protocolViolation {
            return nil
        }
        // A dual-era server lists the modern version; legacy-only lists don't.
        guard result["supportedVersions"]?.arrayValue?.contains(.string(MCPProtocol.modern)) == true else { return nil }
        let serverInfo = result["_meta"]?["io.modelcontextprotocol/serverInfo"]
        generation += 1
        return Connection(generation: generation, era: .modern, protocolVersion: MCPProtocol.modern, sessionID: nil, channel: nil,
                          info: MCPServerInfo(name: serverInfo?["name"]?.stringValue, version: serverInfo?["version"]?.stringValue,
                                              protocolVersion: MCPProtocol.modern, era: .modern,
                                              instructions: result["instructions"]?.stringValue,
                                              capabilities: result["capabilities"] ?? [:]))
    }

    /// Interprets a JSON-RPC error to `server/discover`. Only codes a modern
    /// server sends keep us modern; method-not-found etc. mean legacy
    /// (modern servers must implement `server/discover`).
    private func modernVerdict(code: Int, data: JSONValue?, error: MCPError) throws -> Connection? {
        switch code {
        case MCPError.headerMismatch, MCPError.missingClientCapability:
            throw error
        case MCPError.unsupportedProtocolVersion:
            let supported = data?["supported"]?.arrayValue?.compactMap(\.stringValue) ?? []
            if supported.contains(where: MCPProtocol.acceptedLegacy.contains) { return nil }
            throw MCPError.unsupportedServer("The server only supports MCP \(supported.joined(separator: ", ")).")
        default:
            return nil
        }
    }

    private func initializeLegacy(interactive: Bool) async throws -> Connection? {
        var version = MCPProtocol.legacy[0]
        for _ in 0..<2 {
            let id = takeID()
            let params: JSONValue = ["protocolVersion": .string(version), "capabilities": capabilities,
                                     "clientInfo": options.clientInfo.json]
            let response = try await send(makePOST(config.url, RPC.request(id: id, method: "initialize", params: params), headers: [:]),
                                          interactive: interactive)
            guard response.head.isSuccess else {
                let failure = await MCPWire.failure(response)
                if case .server(_, _, let data)? = failure.rpc, let next = Self.legacyVersion(in: data), next != version {
                    version = next
                    continue
                }
                if Self.indicatesOtherEra(failure.status) { return nil }
                throw failure.error
            }
            let result: JSONValue
            do {
                result = try await withDeadline(options.requestTimeout) {
                    try await MCPWire.readReply(response, id: id, handlers: .ignoring)
                }
            } catch MCPError.server(let code, let message, let data) {
                if let next = Self.legacyVersion(in: data), next != version { version = next; continue }
                throw MCPError.server(code: code, message: message, data: data)
            } catch MCPError.protocolViolation {
                return nil
            }
            guard let negotiated = result["protocolVersion"]?.stringValue, MCPProtocol.acceptedLegacy.contains(negotiated) else {
                throw MCPError.unsupportedServer("The server answered with MCP \(result["protocolVersion"]?.stringValue ?? "?"), which isn't supported.")
            }
            generation += 1
            let c = Connection(generation: generation, era: .legacyStreamableHTTP, protocolVersion: negotiated,
                               sessionID: response.head.header("mcp-session-id"), channel: nil,
                               info: Self.legacyInfo(result, version: negotiated, era: .legacyStreamableHTTP))
            let ack = try await send(makePOST(config.url, RPC.notification("notifications/initialized"), headers: legacyHeaders(c)),
                                     interactive: interactive)
            _ = try? await ack.collect(limit: 64 << 10)
            return c
        }
        return nil
    }

    private func openEventStream(interactive: Bool) async throws -> Connection? {
        var request = URLRequest(url: config.url)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let response = try await send(request, interactive: interactive)
        let type = response.head.header("content-type")?.lowercased() ?? ""
        guard response.head.isSuccess, type.contains("text/event-stream") else {
            let failure = await MCPWire.failure(response)
            if response.head.isSuccess || Self.indicatesOtherEra(failure.status) { return nil }
            throw failure.error
        }
        let config = self.config
        let channel = LegacySSEChannel(
            streamURL: config.url,
            post: { [weak self] url, message, interactive in
                guard let self else { throw CancellationError() }
                try await self.postToEventStream(url, message, interactive: interactive)
            },
            serverRequest: { [weak self] id, method, params in
                await self?.reply(to: id, method: method, params: params)
                    ?? RPC.error(id: id, code: MCPError.methodNotFound, message: "Client closed")
            },
            notification: { [weak self] method, params in await self?.handleNotification(method, params) })
        do {
            _ = try await channel.open(response, timeout: options.requestTimeout)
            let id = takeID()
            let initialize = RPC.request(id: id, method: "initialize", params: [
                "protocolVersion": .string(MCPProtocol.httpSSE), "capabilities": capabilities, "clientInfo": options.clientInfo.json,
            ])
            let result = try await withDeadline(options.requestTimeout) {
                try await channel.request(id: id, message: initialize, progress: nil, interactive: interactive)
            }
            let negotiated = result["protocolVersion"]?.stringValue ?? MCPProtocol.httpSSE
            guard MCPProtocol.acceptedLegacy.contains(negotiated) else {
                throw MCPError.unsupportedServer("The server answered with MCP \(negotiated), which isn't supported.")
            }
            try await channel.notify(RPC.notification("notifications/initialized"), interactive: interactive)
            generation += 1
            return Connection(generation: generation, era: .legacySSE, protocolVersion: negotiated, sessionID: nil, channel: channel,
                              info: Self.legacyInfo(result, version: negotiated, era: .legacySSE))
        } catch {
            await channel.close()
            if error is SessionLost { return nil }
            throw error
        }
    }

    private func postToEventStream(_ url: URL, _ message: JSONValue, interactive: Bool) async throws {
        let response = try await send(makePOST(url, message, headers: [:]), interactive: interactive)
        guard response.head.isSuccess else { throw await MCPWire.failure(response).error }
        _ = try? await response.collect(limit: 64 << 10)
    }

    // MARK: - HTTP

    /// Adds static + OAuth headers and handles 401 / 403
    /// `insufficient_scope` (refresh, sign-in, step-up) with a retry cap.
    private func send(_ base: URLRequest, interactive: Bool = true) async throws -> HTTPStreamResponse {
        var attempts = 0
        while true {
            var request = base
            try applyStaticHeaders(&request)
            let token = await oauth?.accessToken()
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let response = try await transport.stream(request)
            let status = response.head.status
            let challenge = WWWAuthenticate.bearer(in: response.head)
            guard status == 401 || (status == 403 && challenge?.isInsufficientScope == true) else { return response }
            guard let oauth else {
                if status == 403 { return response }
                throw MCPError.authorizationRequired(
                    await OAuthDiscovery(transport: transport, serverURL: config.url).requirement(challenge: challenge))
            }
            attempts += 1
            guard attempts <= 2 else {
                throw MCPError.http(status: status, message: status == 403 ? "still missing permissions after signing in" : "still unauthorized after signing in")
            }
            try await oauth.recover(from: response.head, sentToken: token, interactive: interactive)
        }
    }

    private func applyStaticHeaders(_ request: inout URLRequest) throws {
        for header in config.headers {
            switch header.value {
            case .plain(let value):
                request.setValue(value, forHTTPHeaderField: header.name)
            case .secret(let key):
                guard let value = try secrets.secret(for: key) else { throw MCPError.missingSecret(header.name) }
                request.setValue(value, forHTTPHeaderField: header.name)
            }
        }
    }

    private func makePOST(_ url: URL, _ body: JSONValue, headers: [String: String]) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.httpBody = body.encodedData()
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
        return request
    }

    private func modernHeaders(method: String, name: String?) -> [String: String] {
        var h = ["MCP-Protocol-Version": MCPProtocol.modern, "Mcp-Method": method]
        if let name { h["Mcp-Name"] = MCPWire.headerValue(name) }
        return h
    }

    private func legacyHeaders(_ c: Connection) -> [String: String] {
        var h = ["MCP-Protocol-Version": c.protocolVersion]
        if let session = c.sessionID { h["Mcp-Session-Id"] = session }
        return h
    }

    private func modernMeta(progressToken: Int?) -> JSONValue {
        var meta: [String: JSONValue] = [
            "io.modelcontextprotocol/protocolVersion": .string(MCPProtocol.modern),
            "io.modelcontextprotocol/clientInfo": options.clientInfo.json,
            "io.modelcontextprotocol/clientCapabilities": capabilities,
        ]
        if let progressToken { meta["progressToken"] = .number(Double(progressToken)) }
        return .object(meta)
    }

    /// Only what we implement: elicitation (both modes) when the app
    /// provides a handler. No sampling / roots (deprecated).
    private var capabilities: JSONValue {
        elicitation == nil ? [:] : ["elicitation": ["form": [:], "url": [:]]]
    }

    private static func indicatesOtherEra(_ status: Int) -> Bool {
        (400..<500).contains(status) && ![401, 403, 408, 429].contains(status)
    }

    private static func legacyVersion(in data: JSONValue?) -> String? {
        let supported = data?["supported"]?.arrayValue?.compactMap(\.stringValue) ?? []
        return MCPProtocol.legacy.first(where: supported.contains)
    }

    private static func legacyInfo(_ result: JSONValue, version: String, era: MCPEra) -> MCPServerInfo {
        MCPServerInfo(name: result["serverInfo"]?["name"]?.stringValue, version: result["serverInfo"]?["version"]?.stringValue,
                      protocolVersion: version, era: era, instructions: result["instructions"]?.stringValue,
                      capabilities: result["capabilities"] ?? [:])
    }
}

// MARK: - Resources, prompts, change notifications

extension MCPClient {
    // MARK: Resources

    /// One page of `resources/list`. The first page (no cursor) also
    /// carries the resource templates. Agent-side: never opens sign-in.
    public func listResources(cursor: String? = nil) async throws -> MCPResourcePage {
        try await agentRequest(timeout: options.requestTimeout) {
            try await self.fetchResourcePage(cursor: cursor)
        }
    }

    private func fetchResourcePage(cursor: String?) async throws -> MCPResourcePage {
        var params: [String: JSONValue] = [:]
        if let cursor { params["cursor"] = .string(cursor) }
        let result = try await completeRequest("resources/list", params, name: nil, interactive: false)
        let resources = (result["resources"]?.arrayValue ?? []).compactMap(MCPResource.init(json:))
        // Templates are optional for servers: a failure there isn't one here.
        let templates = cursor == nil ? ((try? await allTemplates()) ?? []) : []
        let next = result["nextCursor"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        return MCPResourcePage(resources: resources, templates: templates, nextCursor: next)
    }

    private func allTemplates() async throws -> [MCPResourceTemplate] {
        var out: [MCPResourceTemplate] = []
        var cursor: String?
        var seen = Set<String>()
        var keptBytes = 0
        paging: for _ in 0..<10 {
            var params: [String: JSONValue] = [:]
            if let cursor { params["cursor"] = .string(cursor) }
            let result = try await completeRequest("resources/templates/list", params, name: nil, interactive: false)
            for item in result["resourceTemplates"]?.arrayValue ?? [] {
                guard out.count < Self.maxListedTemplates else { break paging }
                guard let template = MCPResourceTemplate(json: item) else { continue }
                keptBytes += item.encodedString().utf8.count
                guard keptBytes <= Self.maxListedTemplateBytes else { break paging }
                out.append(template)
            }
            guard let next = result["nextCursor"]?.stringValue, !next.isEmpty, seen.insert(next).inserted else { break }
            cursor = next
        }
        return out
    }

    /// `resources/read`. Results are cached for the server's `ttlMs`, or —
    /// when the server supports subscriptions and this client listens —
    /// until `notifications/resources/updated` (at most 10 minutes).
    public func readResource(_ uri: String) async throws -> [MCPResourceContents] {
        if let cached = readCache[uri], cached.expires > options.now() { return cached.contents }
        let result = try await agentRequest(timeout: options.callTimeout) {
            try await self.completeRequest("resources/read", ["uri": .string(uri)], name: uri, interactive: false)
        }
        let contents = (result["contents"]?.arrayValue ?? []).map(MCPResourceContents.init(json:))
        let watching = await watch(uri)
        cacheRead(uri, contents, ttlMs: result["ttlMs"]?.doubleValue, watching: watching)
        return contents
    }

    /// Whether `uri` is cached right now (tests, diagnostics).
    public func isCached(resource uri: String) -> Bool {
        readCache[uri].map { $0.expires > options.now() } ?? false
    }

    /// Resources watched for updates (tests, diagnostics).
    public var watchedResources: [String] { subscribedURIs }

    private func cacheRead(_ uri: String, _ contents: [MCPResourceContents], ttlMs: Double?, watching: Bool) {
        let lifetime: Double? = ttlMs.map { $0 / 1000 } ?? (watching ? 600 : nil)
        guard let lifetime, lifetime > 0 else { return }
        let bytes = contents.reduce(0) { $0 + ($1.text?.utf8.count ?? 0) + ($1.blob?.count ?? 0) }
        guard bytes <= 1 << 20 else { return }
        if readCache[uri] == nil, readCache.count >= 32,
           let oldest = readCache.min(by: { $0.value.expires < $1.value.expires })?.key {
            readCache[oldest] = nil
        }
        readCache[uri] = (contents, options.now().addingTimeInterval(min(lifetime, 600)))
    }

    /// Subscribes to updates for `uri` where the server supports it and
    /// this client listens. Returns whether the resource is watched.
    private func watch(_ uri: String) async -> Bool {
        guard options.listensForChanges, let c = connection,
              MCPServerFeatures(capabilities: c.info.capabilities).resourcesSubscribe else { return false }
        if subscribedURIs.contains(uri) { return true }
        guard subscribedURIs.count < 32 else { return false }
        subscribedURIs.append(uri)
        switch c.era {
        case .modern:
            // The filter is fixed per stream: reopen it with the new URI.
            restartListening()
        case .legacyStreamableHTTP, .legacySSE:
            do {
                _ = try await withDeadline(options.requestTimeout) {
                    try await self.rpc("resources/subscribe", ["uri": .string(uri)], interactive: false)
                }
            } catch {
                subscribedURIs.removeAll { $0 == uri }
                return false
            }
            armListener(c)
        }
        return true
    }

    // MARK: Prompts

    /// Every prompt (all pages), cached for `ttlMs` or until
    /// `notifications/prompts/list_changed`.
    public func listPrompts(refresh: Bool = false) async throws -> [MCPPrompt] {
        if !refresh, let cache = promptCache, cache.expires > options.now() { return cache.prompts }
        var prompts: [MCPPrompt] = []
        var names = Set<String>()
        var cursors = Set<String>()
        var cursor: String?
        var ttlMs: Double?
        var keptBytes = 0
        var truncated = false
        paging: for _ in 0..<20 {
            var params: [String: JSONValue] = [:]
            if let cursor { params["cursor"] = .string(cursor) }
            let page = params
            let result = try await withDeadline(options.requestTimeout) { try await self.completeRequest("prompts/list", page, name: nil) }
            if let ms = result["ttlMs"]?.doubleValue { ttlMs = min(ttlMs ?? ms, ms) }
            for item in result["prompts"]?.arrayValue ?? [] {
                guard prompts.count < Self.maxListedPrompts else { truncated = true; break paging }
                guard let prompt = MCPPrompt(json: item), names.insert(prompt.name).inserted else { continue }
                keptBytes += item.encodedString().utf8.count
                guard keptBytes <= Self.maxListedPromptBytes else { truncated = true; break paging }
                prompts.append(prompt)
            }
            guard let next = result["nextCursor"]?.stringValue, !next.isEmpty, cursors.insert(next).inserted else { break }
            cursor = next
        }
        let lifetime = ttlMs.map { $0 / 1000 } ?? Double(options.defaultToolListTTL.components.seconds)
        promptCache = (prompts, options.now().addingTimeInterval(max(0, lifetime)))
        promptListTruncated = truncated
        return prompts
    }

    /// `prompts/get` — the user picked a prompt in the app.
    public func getPrompt(_ name: String, arguments: [String: String] = [:]) async throws -> MCPPromptResult {
        let params: [String: JSONValue] = ["name": .string(name), "arguments": .object(arguments.mapValues { .string($0) })]
        let result = try await withDeadline(options.requestTimeout) { try await self.completeRequest("prompts/get", params, name: name) }
        return MCPPromptResult(json: result)
    }

    /// A request that may come back `input_required` (MRTR) a few times.
    private func completeRequest(_ method: String, _ params: [String: JSONValue], name: String?,
                                 interactive: Bool = true) async throws -> JSONValue {
        var current = params
        var rounds = 0
        while true {
            let result = try await rpc(method, current, name: name, interactive: interactive)
            guard result["resultType"]?.stringValue == "input_required" else { return result }
            rounds += 1
            guard rounds <= options.maxInputRounds else {
                throw MCPError.inputUnavailable("\(config.name) kept asking for more input.")
            }
            let (responses, state) = try await gatherInput(result, scope: ElicitationScope.current)
            current = params
            if let responses { current["inputResponses"] = responses }
            if let state { current["requestState"] = .string(state) }
        }
    }

    // MARK: Change notifications

    /// Ends the notification stream (it re-arms on the next request).
    public func stopListening() {
        listener?.cancel()
        listener = nil
        listenerID += 1
    }

    /// Whether a notification stream is open or reconnecting (tests).
    public var isListening: Bool { listener != nil }

    /// Starts the stream when this client listens, the server announces
    /// something worth hearing, and it isn't running already.
    private func armListener(_ c: Connection) {
        guard options.listensForChanges, listener == nil, listenUnsupportedGeneration != c.generation else { return }
        let f = MCPServerFeatures(capabilities: c.info.capabilities)
        switch c.era {
        case .legacySSE:
            return // its event stream already carries notifications
        case .modern:
            guard f.toolsListChanged || f.promptsListChanged || f.resourcesListChanged
                    || (f.resourcesSubscribe && !subscribedURIs.isEmpty) else { return }
        case .legacyStreamableHTTP:
            guard f.wantsNotifications else { return }
        }
        listenerID += 1
        let id = listenerID
        listener = Task { await self.listenLoop(id: id) }
    }

    private func restartListening() {
        stopListening()
        if let c = connection { armListener(c) }
    }

    private enum ListenOutcome {
        /// No stream here (405, method not found, nothing to listen for).
        case unsupported
        /// The server closed the subscription gracefully.
        case ended
        /// Lost; `wasUp` = it had been acknowledged / open.
        case dropped(wasUp: Bool)
    }

    private func listenLoop(id: Int) async {
        var failures = 0
        while !Task.isCancelled, listenerID == id {
            let outcome: ListenOutcome
            do {
                outcome = try await listenOnce()
            } catch MCPError.authorizationRequired {
                outcome = .unsupported // until a sign-in starts a new connection
            } catch {
                outcome = .dropped(wasUp: false)
            }
            guard !Task.isCancelled, listenerID == id else { return }
            switch outcome {
            case .unsupported:
                listenUnsupportedGeneration = connection?.generation
                listener = nil
                return
            case .ended:
                listener = nil
                return
            case .dropped(let wasUp):
                failures = wasUp ? 1 : failures + 1
                guard failures <= options.maxListenFailures else {
                    listener = nil
                    return
                }
                try? await Task.sleep(for: options.listenBackoff(failures))
            }
        }
    }

    private func listenOnce() async throws -> ListenOutcome {
        let c = try await connected(interactive: false)
        switch c.era {
        case .modern:
            let f = MCPServerFeatures(capabilities: c.info.capabilities)
            var filter: [String: JSONValue] = [:]
            if f.toolsListChanged { filter["toolsListChanged"] = true }
            if f.promptsListChanged { filter["promptsListChanged"] = true }
            if f.resourcesListChanged { filter["resourcesListChanged"] = true }
            if f.resourcesSubscribe, !subscribedURIs.isEmpty {
                filter["resourceSubscriptions"] = .array(subscribedURIs.map { .string($0) })
            }
            guard !filter.isEmpty else { return .unsupported }
            let id = takeID()
            let body = RPC.request(id: id, method: "subscriptions/listen",
                                   params: ["_meta": modernMeta(progressToken: nil), "notifications": .object(filter)])
            let response = try await send(makePOST(config.url, body, headers: modernHeaders(method: "subscriptions/listen", name: nil)),
                                          interactive: false)
            return await readNotificationStream(response, requestID: id, legacy: nil)
        case .legacyStreamableHTTP:
            var request = URLRequest(url: config.url)
            request.httpMethod = "GET"
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            for (k, v) in legacyHeaders(c) { request.setValue(v, forHTTPHeaderField: k) }
            let response = try await send(request, interactive: false)
            if response.head.status == 404, c.sessionID != nil {
                await drop(c)
                return .dropped(wasUp: false)
            }
            return await readNotificationStream(response, requestID: nil, legacy: c)
        case .legacySSE:
            return .unsupported
        }
    }

    private func readNotificationStream(_ response: HTTPStreamResponse, requestID: Int?, legacy: Connection?) async -> ListenOutcome {
        let status = response.head.status
        let type = response.head.header("content-type")?.lowercased() ?? ""
        guard response.head.isSuccess, type.contains("text/event-stream") else {
            _ = try? await response.collect(limit: 64 << 10)
            if response.head.isSuccess { return .unsupported } // a JSON reply: an error or an immediate end
            return (400..<500).contains(status) && ![408, 429].contains(status) ? .unsupported : .dropped(wasUp: false)
        }
        var parser = SSEParser()
        var up = legacy != nil
        do {
            for try await chunk in response.body {
                for event in parser.feed(chunk) {
                    if let outcome = await handleStreamEvent(event, requestID: requestID, legacy: legacy, up: &up) { return outcome }
                }
            }
            for event in parser.finish() {
                if let outcome = await handleStreamEvent(event, requestID: requestID, legacy: legacy, up: &up) { return outcome }
            }
        } catch {
            return .dropped(wasUp: up)
        }
        return .dropped(wasUp: up)
    }

    private func handleStreamEvent(_ event: SSEEvent, requestID: Int?, legacy: Connection?, up: inout Bool) async -> ListenOutcome? {
        guard event.event == nil || event.event == "message" else { return nil }
        let text = event.data.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let value = try? JSONValue(parsing: text) else { return nil } // keep-alives
        for message in RPCMessage.parse(value) {
            switch message {
            case .notification(let method, let params):
                if method == "notifications/subscriptions/acknowledged" {
                    up = true
                } else {
                    handleNotification(method, params)
                }
            case .response(let id, _):
                if let requestID, RPC.matches(id, requestID) { return .ended }
            case .failure(let id, _):
                if let requestID, id == nil || RPC.matches(id, requestID) { return .unsupported }
            case .request(let id, let method, let params):
                guard let legacy else { continue }
                let reply = await reply(to: id, method: method, params: params)
                await postReply(reply, on: legacy)
            }
        }
        return nil
    }
}

/// Recognizes "you're not signed in" refusals that arrive without a 401
/// (a JSON-RPC error, or a tool result marked `isError`). Only consulted
/// for servers that advertise sign-in and when no token was sent, so a
/// false positive costs at most a "Sign in" offer.
enum MCPAuthHeuristics {
    private static let phrases = [
        "unauthorized", "unauthenticated", "not authenticated", "authentication required", "requires authentication",
        "missing required authentication", "authentication credential", "missing credentials", "no credentials",
        "invalid_token", "invalid token", "missing access token", "expected oauth", "access token is missing",
        "login required", "please log in", "please sign in", "sign in required", "not signed in", "not logged in",
    ]

    static func looksLikeMissingCredentials(_ text: String) -> Bool {
        let lowered = text.lowercased()
        return phrases.contains { lowered.contains($0) }
    }
}

/// Races `work` against a deadline; the loser is cancelled.
func withDeadline<T: Sendable>(_ limit: Duration, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await work() }
        group.addTask {
            try await Task.sleep(for: limit)
            throw MCPError.timeout(limit)
        }
        defer { group.cancelAll() }
        guard let first = try await group.next() else { throw CancellationError() }
        return first
    }
}
