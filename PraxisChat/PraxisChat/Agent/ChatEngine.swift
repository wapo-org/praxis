import Foundation
import AgentCore
import AgentMCP
import AgentRuntime

/// Everything one run needs, captured at send time. The history is the
/// conversation before this turn (append-only: a run only ever adds to
/// it, retry/edit only cut the tail).
struct ChatRunRequest: Sendable {
    var conversationID: UUID
    /// Stable persisted turn id used for cloud start idempotency.
    var turnID: UUID = UUID()
    /// Opaque server chat id; local conversations retain their UUID identity.
    var cloudChatID: String? = nil
    /// Messages of the turns before this one.
    var history: [Message]
    /// The new turn's user message, built by the store — nil for engines
    /// that build (and commit) their own (`ChatEngine.buildsUserMessage`).
    var userMessage: Message?
    var userText: String
    var mode: ChatMode
    var effort: Effort
    var modelID: String
    var webSearch: Bool
    /// The new turn's attachments (bytes in `AttachmentStore`).
    var attachments: [Attachment]
    /// Every attachment in the conversation so far, this turn's included.
    /// JS `fs` lists only this turn's; earlier ones are readable by exact
    /// name (`AttachmentFiles`); ones the user hid from code are neither.
    var conversationAttachments: [Attachment] = []
    /// The attachments hidden from code right now — read at every `fs`
    /// call, so hiding (or allowing) a file mid-run applies at once.
    var hiddenFromCode: @Sendable () async -> Set<UUID> = { [] }
    /// Trust + "always allow" grants, decided against the mode table.
    var policy: ToolPolicy
    /// Asks the user when the policy says `ask`.
    var approvals: any ApprovalHandler
    /// What the conversation froze at its first send; nil until then.
    var setup: ConversationSetup?
    /// Connectors enabled for this conversation (used when freezing).
    var connectorIDs: [String] = []
    /// Frozen connectors turned off in this conversation only: their
    /// tools stay offered but refuse to run.
    var disabledServerIDs: Set<String> = []
    /// Tools the user turned off in connector settings, by server id
    /// (read live from the library at send time): frozen ones stay
    /// offered but refuse to run; new conversations leave them out.
    var disabledTools: [String: Set<String>] = [:]
    /// Called once a live engine freezes a setup, before anything is sent:
    /// the store persists it with the conversation.
    var onSetup: @Sendable (ConversationSetup, [MCPToolset.Failure]) async -> Void = { _, _ in }
    /// The conversation's last context compaction (live engine); the
    /// runtime uses it while it still matches the history.
    var compaction: ContextCompaction?
    /// Called when a run condenses older history: the store persists the
    /// record so later runs send [summary + recent tail].
    var onCompaction: @Sendable (ContextCompaction) async -> Void = { _ in }
    /// The conversation's last measured prompt size (live engine).
    var contextMeasurement: ContextMeasurement?
    /// Called with each new measurement, for the store to persist.
    var onContextMeasured: @Sendable (ContextMeasurement) async -> Void = { _ in }
    /// True once the run was stopped, replaced or deleted. Engines observe
    /// it at every suspension point and finish their stream promptly:
    /// dropping the consumer's stream alone can't reach them (a task
    /// suspended in `for await` never notices cancellation).
    var isCancelled: @Sendable () -> Bool = { false }
    /// The run's elicitation scope, fresh per run. The engine tags its
    /// elicitations with it; stopping the run cancels the scope. Nil
    /// leaves elicitations unscoped (engines that don't elicit).
    var elicitationScope: UUID? = nil

    /// History plus the new user message, when the store built it.
    var transcript: [Message] { history + (userMessage.map { [$0] } ?? []) }

    /// Text of the new user message.
    var prompt: String { userText }
}

/// The app's seam to an agent runtime. Engines emit the runtime's
/// `AgentEvent` vocabulary, uncoalesced; `ChatStore` coalesces and folds
/// events into the transcript through `TurnReducer`. Stopping flips the
/// request's `isCancelled`: engines watch it and end their stream, which
/// unwinds the pump. (Dropping the consumer side alone can't cancel: a
/// task suspended in `for await` never notices.)
protocol ChatEngine: Sendable {
    var kind: EngineKind { get }
    /// True when the engine builds the turn's user message itself and
    /// reports it as its first `.committed` event (the live engine: the
    /// runtime decides which notes ride along). The store then leaves the
    /// turn's transcript empty instead of building one.
    var buildsUserMessage: Bool { get }
    func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent>
}

extension ChatEngine {
    var buildsUserMessage: Bool { false }
}

/// Cloud is the default. Explicit demo/scripted modes remain deterministic.
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
        // SUNSET(native-loop): a saved provider or live override alone cannot
        // construct the native runtime. This hidden opt-in defaults to false.
        if override == .demo || override == .scripted { return override! }
        if override == .cloud { return .cloud }
        if nativeLoopEnabled && (override == .live || hasProvider) { return .live }
        return .cloud
    }
}
