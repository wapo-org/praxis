import Foundation
import AgentCore
import AgentMCP
import AgentRuntime

/// Snapshot captured at send time against an append-only history.
struct ChatRunRequest: Sendable {
    var conversationID: UUID
    /// Persisted turn id for cloud start idempotency.
    var turnID: UUID = UUID()
    /// Opaque server chat id; local conversations retain their UUID identity.
    var cloudChatID: String? = nil
    var cloudRunID: String? = nil
    var cloudClientTurnID: String? = nil
    var cloudMayStart = true
    var history: [Message]
    /// Nil for engines that build and commit their own user message.
    var userMessage: Message?
    var userText: String
    var mode: ChatMode
    var effort: Effort
    var modelID: String
    var webSearch: Bool
    var attachments: [Attachment]
    var conversationAttachments: [Attachment] = []
    /// Polled on every fs call so mid-run hide changes apply immediately.
    var hiddenFromCode: @Sendable () async -> Set<UUID> = { [] }
    var policy: ToolPolicy
    var approvals: any ApprovalHandler
    var setup: ConversationSetup?
    var connectorIDs: [String] = []
    /// Per-chat disabled connectors stay offered in the frozen setup but refuse calls.
    var disabledServerIDs: Set<String> = []
    /// Settings-disabled tools refuse in frozen chats and omit from new ones.
    var disabledTools: [String: Set<String>] = [:]
    /// Invoked before send when setup freezes so store persists it.
    var onSetup: @Sendable (ConversationSetup, [MCPToolset.Failure]) async -> Void = { _, _ in }
    var compaction: ContextCompaction?
    /// Persisted on compaction so later runs send summary plus recent tail.
    var onCompaction: @Sendable (ContextCompaction) async -> Void = { _ in }
    var contextMeasurement: ContextMeasurement?
    var onContextMeasured: @Sendable (ContextMeasurement) async -> Void = { _ in }
    /// Polled at suspension points because stream drop never cancels a suspended task.
    var isCancelled: @Sendable () -> Bool = { false }
    /// Scoped per run so stop cancels this run's elicitations only.
    var elicitationScope: UUID? = nil

    var transcript: [Message] { history + (userMessage.map { [$0] } ?? []) }

    var prompt: String { userText }
}

/// Emits uncoalesced runtime events; engines must poll request.isCancelled to stop.
protocol ChatEngine: Sendable {
    var kind: EngineKind { get }
    /// True when the engine commits its own user message as first event.
    var buildsUserMessage: Bool { get }
    func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent>
}

extension ChatEngine {
    var buildsUserMessage: Bool { false }
}

/// Cloud is the default; demo and scripted modes stay deterministic.
enum EngineKind: String, Codable, Sendable {
    case cloud, demo, scripted, live

    static var launchOverride: EngineKind? {
        UserDefaults.standard.string(forKey: "PraxisEngine").flatMap(EngineKind.init(rawValue:))
    }

    static var nativeLoopEnabled: Bool {
        UserDefaults.standard.bool(forKey: "PraxisNativeLoopEnabled")
    }

    static func resolve(override: EngineKind?, hasProvider: Bool,
                        nativeLoopEnabled: Bool = Self.nativeLoopEnabled) -> EngineKind {
        // Hidden opt-in; saved provider alone never constructs the native runtime.
        if override == .demo || override == .scripted { return override! }
        if override == .cloud { return .cloud }
        if nativeLoopEnabled && (override == .live || hasProvider) { return .live }
        return .cloud
    }
}
