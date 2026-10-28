import Foundation
import Synchronization
import AgentCore
import AgentProviders
import AgentSkills
import AgentJS
import AgentMCP

/// One turn for `AgentRuntime.run`.
public struct RunRequest: Sendable {
    public var conversationID: String
    public var model: String
    public var setup: ConversationSetup
    /// Prior turns plus the new user message (see `AgentRuntime.userMessage`).
    public var transcript: [Message]
    public var mode: AgentMode
    public var effort: Effort
    /// The user's web search toggle; only honoured where it's available.
    public var webSearch: Bool
    /// Trust for connectors marked trusted in their config is added on top.
    public var policy: ToolPolicy
    public var approvals: any ApprovalHandler
    /// Attachments exposed to tools (JS `fs`).
    public var files: (any VirtualFileSystem)?
    /// The model's output cap (`ModelInfo.maxOutputTokens`); the effort's
    /// token budget is clamped to it.
    public var maxOutputTokens: Int?
    /// Frozen connectors the user turned off for this conversation. Their
    /// tools stay offered (the prefix can't change) but refuse to run.
    public var disabledServerIDs: Set<String>
    /// Frozen tools the user turned off in connector settings, by server
    /// id. Like `disabledServerIDs` they stay offered (the prefix can't
    /// change) but refuse to run; new conversations leave them out at
    /// `prepare` time instead. Read live on every run, so toggling a
    /// tool applies to existing chats at once.
    public var disabledTools: [String: Set<String>]
    /// The model's context window (`ModelInfo.contextWindow`) when known;
    /// compaction budgets against it (or a fallback).
    public var contextWindow: Int?
    /// The conversation's last persisted compaction (from an
    /// `AgentEvent.compaction` `.finished` update). Used while it still
    /// matches the transcript's prefix.
    public var compaction: ContextCompaction?
    /// The conversation's last persisted prompt measurement (from an
    /// `AgentEvent.contextMeasured`). Budgets the first request while it
    /// still matches the transcript.
    public var measurement: ContextMeasurement?
    /// The image-reading model `look_at_image` asks (resolved at send
    /// time, key included). Only used by conversations that froze the tool.
    public var imageReader: ImageReaderAccess
    /// True once the run was stopped. The producer and the loop watch it
    /// and end the run; a task suspended in `for await` over the event
    /// stream would otherwise never notice.
    public var isCancelled: @Sendable () -> Bool
    /// The run's elicitation scope, fresh per run (nil leaves
    /// elicitations unscoped).
    public var elicitationScope: UUID?

    public init(conversationID: String, model: String, setup: ConversationSetup, transcript: [Message],
                mode: AgentMode, effort: Effort, webSearch: Bool = false, policy: ToolPolicy = ToolPolicy(),
                approvals: any ApprovalHandler, files: (any VirtualFileSystem)? = nil, maxOutputTokens: Int? = nil,
                disabledServerIDs: Set<String> = [], disabledTools: [String: Set<String>] = [:],
                contextWindow: Int? = nil, compaction: ContextCompaction? = nil,
                imageReader: ImageReaderAccess = .notConfigured, measurement: ContextMeasurement? = nil,
                isCancelled: @escaping @Sendable () -> Bool = { false }, elicitationScope: UUID? = nil) {
        self.measurement = measurement
        self.conversationID = conversationID
        self.model = model
        self.setup = setup
        self.transcript = transcript
        self.mode = mode
        self.effort = effort
        self.webSearch = webSearch
        self.policy = policy
        self.approvals = approvals
        self.files = files
        self.maxOutputTokens = maxOutputTokens
        self.disabledServerIDs = disabledServerIDs
        self.disabledTools = disabledTools
        self.contextWindow = contextWindow
        self.compaction = compaction
        self.imageReader = imageReader
        self.isCancelled = isCancelled
        self.elicitationScope = elicitationScope
    }
}

/// Wires providers, skills, the JS runner and MCP connectors into the
/// agent the app runs. Per conversation, `prepare` freezes a
/// `ConversationSetup` at the first send; every run rebuilds the tools
/// from it, so the request prefix never changes.
///
/// Holds no conversation state besides the output spills and JS `kv`
/// stores (on disk when given a `ScratchStore`): create one at launch and
/// share it.
public struct AgentRuntime: Sendable {
    public let skillStore: SkillStore?
    public let jsRunner: QuickJSRunner
    public let providerTransport: any HTTPTransport
    public let spills: OutputSpills
    /// Durable spills and `kv` stores; nil keeps both in memory.
    public let scratch: ScratchStore?
    /// The app's client for an installed server; nil once it's removed.
    public let mcpClient: @Sendable (_ serverID: String) async -> MCPClient?

    /// - Parameter scratch: where spills and `kv` stores persist. Used for
    ///   the default `spills` and `jsRunner`; pass runners/spills built on
    ///   the same store if you supply your own.
    public init(skillStore: SkillStore? = nil, jsRunner: QuickJSRunner? = nil,
                providerTransport: any HTTPTransport = URLSessionTransport(), spills: OutputSpills? = nil,
                scratch: ScratchStore? = nil,
                mcpClient: @escaping @Sendable (_ serverID: String) async -> MCPClient? = { _ in nil }) {
        self.skillStore = skillStore
        self.jsRunner = jsRunner ?? QuickJSRunner(configuration: QuickJSRunner.Configuration(kvStorage: scratch))
        self.providerTransport = providerTransport
        self.spills = spills ?? OutputSpills(store: scratch)
        self.scratch = scratch
        self.mcpClient = mcpClient
    }

    // MARK: Freezing

    public struct Preparation: Sendable {
        public var setup: ConversationSetup
        /// Servers whose tools couldn't be listed; they're left out of the
        /// setup. `authRequirement` says when to offer "Sign in".
        public var failures: [MCPToolset.Failure]
    }

    /// Builds a new setup: lists the given servers' tools live (concurrently;
    /// failures and disabled or unknown servers are left out), snapshots
    /// the skill catalog and builds the system prompt.
    ///
    /// Call at the conversation's first send — or again before it, e.g.
    /// after the user signs in to a failed server — and persist the result.
    /// Never call it for a conversation that already has messages.
    ///
    /// - Parameter disabledTools: tool names the user turned off, by
    ///   server id. They're left out of the frozen setup (and don't
    ///   count towards the gateway threshold).
    ///
    /// - Parameter includeImageReader: offer `look_at_image`. Pass true when
    ///   the chat model has no image input, **or when that isn't known**
    ///   (and the model does have tools): if its images then have to go out
    ///   as placeholders — known up front, or learned from the provider
    ///   turning them down — it can ask about them. Decided once here, like
    ///   every tool; later model switches don't change it. (A conversation
    ///   frozen without it can still gain it if its very first request is
    ///   rejected for images: `addingImageReader`.)
    public func prepare(mcpServerIDs: [String] = [], includeJavaScript: Bool = true, includeSkills: Bool = true,
                        includeImageReader: Bool = false,
                        instructions: String? = nil, gatewayThreshold: Int = 30, now: Date = Date(),
                        disabledTools: [String: Set<String>] = [:]) async -> Preparation {
        var clients: [MCPClient] = []
        for id in Set(mcpServerIDs).sorted() {
            if let client = await mcpClient(id) { clients.append(client) }
        }
        let listed = await MCPToolset.build(servers: clients, threshold: gatewayThreshold, disabledTools: disabledTools)
        let failed = Set(listed.failures.map(\.serverID))
        let servers = clients.filter { $0.config.enabled && !failed.contains($0.config.id) }.map { client in
            MCPServerSnapshot(id: client.config.id, name: client.config.name,
                              tools: listed.catalog.filter { $0.source == client.source }.map(\.definition),
                              offersResources: listed.features[client.config.id]?.resources == true ? true : nil)
        }

        let setup = await freeze(servers: servers, gateway: listed.isGateway, includeJavaScript: includeJavaScript,
                                 includeSkills: includeSkills, includeImageReader: includeImageReader,
                                 instructions: instructions, gatewayThreshold: gatewayThreshold, now: now)
        return Preparation(setup: setup, failures: listed.failures)
    }

    /// `setup` rebuilt with `look_at_image` (and its system-prompt note), from
    /// the same connector snapshot — nothing is listed again.
    ///
    /// Only for a conversation whose **first request was turned down**
    /// because the chat model takes no image input (`RunOutcome.isImageInputRejection`):
    /// no request was accepted with the old prefix, so, like re-preparing
    /// before the first send, nothing that was frozen in use changes. Never
    /// call it once the provider has answered a request of the conversation.
    public func addingImageReader(to setup: ConversationSetup, instructions: String? = nil,
                                  now: Date = Date()) async -> ConversationSetup {
        guard !setup.offersImageReader else { return setup }
        let gateway = MCPToolset(listings: setup.mcpServers.map { (Self.standIn(for: $0), $0.tools) },
                                 threshold: setup.gatewayThreshold).isGateway
        return await freeze(servers: setup.mcpServers, gateway: gateway, includeJavaScript: setup.includesJavaScript,
                            includeSkills: setup.includesSkills, includeImageReader: true, instructions: instructions,
                            gatewayThreshold: setup.gatewayThreshold, now: now)
    }

    /// Snapshots the skill catalog, builds the system prompt and freezes
    /// the tool specs for the given (already listed) servers.
    private func freeze(servers: [MCPServerSnapshot], gateway: Bool, includeJavaScript: Bool, includeSkills: Bool,
                        includeImageReader: Bool, instructions: String?, gatewayThreshold: Int,
                        now: Date) async -> ConversationSetup {
        let store = includeSkills ? skillStore : nil
        let skills = await store?.skills() ?? []
        let prompt = SystemPrompt.build(SystemPrompt.Sections(
            instructions: instructions,
            skillsCatalog: SkillCatalog.systemPromptSection(for: skills),
            toolNotes: Self.toolNotes(servers, gateway: gateway, javaScript: includeJavaScript)
                + (includeImageReader ? [Self.imageReaderNote] : [])))

        let draft = ConversationSetup(createdAt: now, systemPrompt: prompt, skillNames: skills.map(\.name),
                                      includesSkills: store != nil, includesJavaScript: includeJavaScript,
                                      mcpServers: servers, gatewayThreshold: gatewayThreshold, toolSpecs: [])
        let offered = assemble(draft, spill: OutputSpill(), connectors: [:]).offered
            .filter { includeImageReader || $0.spec.name != LookAtImageTool.name }
        return draft.withToolSpecs(ToolRegistry(offered).specs)
    }

    /// Worded for models whose image support was unknown at freeze time too:
    /// it only talks about images that arrive as placeholders, never claims
    /// the model is blind (a model that can see must not be told it can't).
    static let imageReaderNote = "An image you can't see arrives as an [Image img_…] placeholder instead of the picture. For those, use \(LookAtImageTool.name) to have an image-reading model answer questions about the image, and ask follow-up questions or zoom into a region when details matter."

    /// Short, stable notes for the system prompt. Server instructions are
    /// left out on purpose: they're untrusted text.
    static func toolNotes(_ servers: [MCPServerSnapshot], gateway: Bool, javaScript: Bool) -> [String] {
        let connected = servers.filter { !$0.tools.isEmpty }
        guard !connected.isEmpty else { return [] }
        var notes = connected.map { "\($0.name) (MCP connector): \($0.tools.count) tool\($0.tools.count == 1 ? "" : "s")." }
        if gateway {
            notes.append("Find connector tools with \(MCPGateway.searchName), check their inputs with \(MCPGateway.describeName) and call them with \(MCPGateway.callName).")
        }
        if javaScript {
            notes.append("Code run with \(RunJavaScriptTool.name) can call connector tools as tools.<server>.<tool>(args); use it to chain or batch calls.")
        }
        return notes
    }

    // MARK: Tools

    /// The conversation's tools: exactly `setup.toolSpecs`, backed by live
    /// implementations where they still exist.
    public func tools(for setup: ConversationSetup, conversationID: String,
                      disabledTools: [String: Set<String>] = [:]) async -> ToolRegistry {
        registry(setup, spill: spills.spill(for: conversationID), connectors: await connectors(for: setup),
                 disabledTools: disabledTools)
    }

    enum Connector: Sendable {
        case live(MCPClient)
        case disabled
        /// Off for this conversation only (`RunRequest.disabledServerIDs`).
        case offHere
        case removed

        var liveConfig: MCPServerConfig? {
            if case .live(let client) = self { return client.config }
            return nil
        }
    }

    func connectors(for setup: ConversationSetup, offHere: Set<String> = []) async -> [String: Connector] {
        var out: [String: Connector] = [:]
        for server in setup.mcpServers {
            guard let client = await mcpClient(server.id) else { out[server.id] = .removed; continue }
            out[server.id] = !client.config.enabled ? .disabled : offHere.contains(server.id) ? .offHere : .live(client)
        }
        return out
    }

    func registry(_ setup: ConversationSetup, spill: OutputSpill, connectors: [String: Connector],
                  images: ImageIndex = ImageIndex(), imageReader: ImageReaderAccess = .notConfigured,
                  disabledTools: [String: Set<String>] = [:]) -> ToolRegistry {
        let (offered, hidden) = assemble(setup, spill: spill, connectors: connectors, images: images,
                                         imageReader: imageReader, disabledTools: disabledTools)
        let live = Dictionary(offered.map { ($0.spec.name, $0) }, uniquingKeysWith: { a, _ in a })
        let pinned: [any AgentTool] = setup.toolSpecs.map { spec in
            guard let tool = live[spec.name] else { return RetiredTool(spec: spec) }
            return tool.spec == spec ? tool : PinnedTool(spec: spec, base: tool)
        }
        return ToolRegistry(pinned, hidden: hidden)
    }

    /// Tools built from the setup's inputs. MCP specs come from stand-in
    /// clients carrying the frozen server id and name, so they don't depend
    /// on the live config; execution goes to the live client.
    ///
    /// Tools added in later builds (`save_skill`, `delete_skill`,
    /// `look_at_image`) are built here too, but only conversations whose
    /// frozen `toolSpecs` name them offer them (`registry` pins the list).
    private func assemble(_ setup: ConversationSetup, spill: OutputSpill, connectors: [String: Connector],
                          images: ImageIndex = ImageIndex(),
                          imageReader: ImageReaderAccess = .notConfigured,
                          disabledTools: [String: Set<String>] = [:]) -> (offered: [any AgentTool], hidden: [any AgentTool]) {
        var offered: [any AgentTool] = [ReadToolOutputTool(spill: spill),
                                        LookAtImageTool(access: imageReader, images: images, transport: providerTransport)]
        if setup.includesSkills, let skillStore {
            offered += skillStore.tools(codeToolName: setup.includesJavaScript ? RunJavaScriptTool.name : nil)
            offered += skillStore.authoringTools()
        }

        let frozen = MCPToolset(listings: setup.mcpServers.map { (Self.standIn(for: $0), $0.tools) },
                                threshold: setup.gatewayThreshold)
        var executors: [String: [String: MCPTool]] = [:]
        for server in setup.mcpServers {
            guard case .live(let client) = connectors[server.id] else { continue }
            let live = MCPToolset(listings: [(client, server.tools)], threshold: .max).catalog
            executors[server.id] = Dictionary(live.map { ($0.definition.name, $0) }, uniquingKeysWith: { a, _ in a })
        }
        let mcpTools = frozen.catalog.map { tool -> ConnectorTool in
            let id = if case .mcp(let id, _) = tool.source { id } else { "" }
            if let live = executors[id]?[tool.definition.name] {
                // The server is live but this tool was turned off: it
                // stays offered (the prefix can't change) and refuses.
                if disabledTools[id, default: []].contains(tool.definition.name) {
                    return ConnectorTool(frozen: tool, target: .unavailable("The user turned this tool off"))
                }
                return ConnectorTool(frozen: tool, target: .live(live))
            }
            let reason = switch connectors[id] {
            case .disabled?:
                "The \(tool.serverName) connector is turned off, so its tools can't run. The user can turn it back on in connector settings."
            case .offHere?:
                "The user turned off the \(tool.serverName) connector for this conversation, so its tools can't run here."
            default:
                "The \(tool.serverName) connector was removed from the app, so its tools can't run anymore."
            }
            return ConnectorTool(frozen: tool, target: .unavailable(reason))
        }

        // Resources: one tool pair for every server that offered them.
        let resourceTools = MCPResourceTools(servers: setup.mcpServers.filter { $0.offersResources == true }.map { server in
            if case .live(let client)? = connectors[server.id] {
                return MCPResourceTools.Server(id: server.id, name: server.name, target: .live(client))
            }
            let reason = switch connectors[server.id] {
            case .disabled?: "The \(server.name) connector is turned off. The user can turn it back on in connector settings."
            case .offHere?: "The user turned off the \(server.name) connector for this conversation."
            default: "The \(server.name) connector was removed from the app."
            }
            return MCPResourceTools.Server(id: server.id, name: server.name, target: .unavailable(reason))
        }).tools

        if setup.includesJavaScript {
            offered.append(RunJavaScriptTool(runner: jsRunner, hostTools: frozen.specs))
        }
        offered += resourceTools
        guard frozen.isGateway else { return (offered + mcpTools, []) }
        let targets = Dictionary(mcpTools.map { ($0.spec.name, $0) }, uniquingKeysWith: { a, _ in a })
        offered += frozen.tools.map { $0.spec.name == MCPGateway.callName ? GatewayCallTool(base: $0, targets: targets) : $0 }
        return (offered, mcpTools)
    }

    private static func standIn(for server: MCPServerSnapshot) -> MCPClient {
        MCPClient(config: MCPServerConfig(id: server.id, name: server.name, url: URL(string: "https://connector.invalid/")!),
                  transport: DetachedTransport(), secrets: InMemorySecretStore())
    }

    // MARK: Running

    /// Hosted web search is the only search in v1: hide the toggle elsewhere.
    public static func isWebSearchAvailable(on capabilities: Capabilities) -> Bool {
        capabilities.tools && capabilities.serverWebSearch
    }

    public static func isWebSearchAvailable(on endpoint: ProviderEndpoint) -> Bool {
        isWebSearchAvailable(on: endpoint.capabilities)
    }

    /// Runs one turn against an endpoint. Events are uncoalesced.
    public func run(_ request: RunRequest, endpoint: ProviderEndpoint) -> AsyncStream<AgentEvent> {
        run(request, provider: ProviderFactory.make(endpoint, transport: providerTransport))
    }

    /// Runs one turn against any provider (scripted engines, previews).
    /// Without tool support the turn is plain chat; the setup stays as it
    /// is for when the conversation moves back to a tool-capable model.
    public func run(_ request: RunRequest, provider: any ModelProvider) -> AsyncStream<AgentEvent> {
        AsyncStream(bufferingPolicy: .unbounded) { continuation in
            let task = Task {
                let spill = spills.spill(for: request.conversationID)
                var policy = request.policy
                var tools = ToolRegistry.empty
                let images = ImageIndex(request.transcript)
                if provider.capabilities.tools {
                    let connectors = await connectors(for: request.setup, offHere: request.disabledServerIDs)
                    tools = registry(request.setup, spill: spill, connectors: connectors, images: images,
                                     imageReader: request.imageReader, disabledTools: request.disabledTools)
                    policy.trustedSources.formUnion(MCPToolset.trustedSources(connectors.values.compactMap(\.liveConfig)))
                }
                let loop = AgentLoop(provider: provider, tools: tools, policy: policy, approvals: request.approvals,
                                     files: request.files, spill: spill)
                let isCancelled = request.isCancelled
                for await event in loop.run(transcript: request.transcript,
                                            configuration: Self.configuration(request, capabilities: provider.capabilities)) {
                    guard !isCancelled() else { break }
                    // Images tools return mid-run become lookable too.
                    if case .committed(let messages) = event { images.add(messages) }
                    continuation.yield(event)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func configuration(_ request: RunRequest, capabilities: Capabilities) -> AgentRunConfiguration {
        AgentRunConfiguration(
            conversationID: request.conversationID, model: request.model, system: request.setup.systemPrompt,
            mode: request.mode, effort: request.effort,
            maxTokens: min(request.effort.defaultMaxTokens, request.maxOutputTokens ?? .max),
            modelMaxTokens: request.maxOutputTokens,
            serverWebSearch: request.webSearch && isWebSearchAvailable(on: capabilities),
            context: ContextPolicy(contextWindow: request.contextWindow), compaction: request.compaction,
            measurement: request.measurement, isCancelled: request.isCancelled,
            elicitationScope: request.elicitationScope)
    }

    /// Drops a deleted conversation's runtime state: spilled tool output
    /// and its JS `kv` store, in memory and on disk.
    public func forget(conversationID: String) async {
        spills.remove(conversationID: conversationID)
        await jsRunner.removeStore(conversationID: conversationID)
        scratch?.remove(conversationID: conversationID)
    }
}

/// One `OutputSpill` per conversation, shared by its runs so
/// `read_tool_output` can page through results truncated earlier. With a
/// `ScratchStore` the text is on disk and survives relaunches; without
/// one, old ids are unknown after a relaunch.
public final class OutputSpills: Sendable {
    private let spills = Mutex<[String: OutputSpill]>([:])
    public let store: ScratchStore?

    public init(store: ScratchStore? = nil) {
        self.store = store
    }

    public func spill(for conversationID: String) -> OutputSpill {
        spills.withLock { spills in
            if let spill = spills[conversationID] { return spill }
            let spill = store.map { OutputSpill(store: $0, conversationID: conversationID) } ?? OutputSpill()
            spills[conversationID] = spill
            return spill
        }
    }

    /// Drops a conversation's stored output (e.g. when it's deleted),
    /// including the scratch directory holding it.
    public func remove(conversationID: String) {
        _ = spills.withLock { $0.removeValue(forKey: conversationID) }
        store?.remove(conversationID: conversationID)
    }
}
