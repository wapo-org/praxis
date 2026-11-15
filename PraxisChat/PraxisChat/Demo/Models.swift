import Foundation
import SwiftUI
import AgentCore
import AgentRuntime

// MARK: Settings

enum ChatMode: String, CaseIterable, Identifiable, Codable {
    case auto, ask, plan, build
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var placeholder: String {
        switch self {
        case .auto: return "Plan, ask, build..."
        case .ask: return "Ask anything..."
        case .plan: return "Plan it out..."
        case .build: return "Build something..."
        }
    }
    var agentMode: AgentMode { AgentMode(rawValue: rawValue) ?? .auto }
}

extension Effort: @retroactive Identifiable {
    public var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var detail: String {
        switch self {
        case .low: return "Quick answers, minimal tool use"
        case .medium: return "Balanced: a few tools, checked once"
        case .high: return "Thorough: plans first, verifies after"
        case .max: return "Exhaustive: plans, verifies, retries"
        }
    }
    /// Target wall-clock for a demo run (spec §10: ~3s Low → ~15s Max).
    var runSeconds: Double {
        switch self {
        case .low: return 3; case .medium: return 6; case .high: return 10; case .max: return 15
        }
    }
    var stepScale: Double {
        switch self {
        case .low: return 0.45; case .medium: return 0.7; case .high: return 1.0; case .max: return 1.35
        }
    }
}

struct AIModel: Identifiable, Equatable {
    let id: String
    let name: String
    let tagline: String
    let speed: Int        // 1...5 dots
    let intelligence: Int // 1...5 dots
    let streamMultiplier: Double
    /// Nil means all four levels, empty means none (hides control); var stays in memberwise init.
    var effortLevels: [Effort]? = nil
}

struct Connector: Identifiable, Equatable {
    let id: String
    let name: String
    let monogram: String
    var isOn: Bool
    /// Why the row can't be toggled here (e.g. "Off in Settings"); nil = toggleable.
    var lockedReason: String? = nil
    var statusLabel: String? = nil
}

// MARK: Attachments

/// Reference to bytes in AttachmentStore (memory in composer, disk once sent); models hold ID.
struct Attachment: Identifiable, Equatable, Hashable, Codable, Sendable {
    var id: UUID
    var kind: Kind
    var name: String
    var hasImage: Bool
    /// MIME type of a picked file (nil for photos: sniffed from the bytes).
    var mediaType: String?
    /// Hides file from JS fs across turns while model still sees inline attachment; persisted.
    var isHiddenFromCode = false
    enum Kind: String, Equatable, Hashable, Codable, Sendable { case photo, file, screenshot, camera }

    private enum CodingKeys: String, CodingKey { case id, kind, name, hasImage, mediaType, isHiddenFromCode }

    init(id: UUID = UUID(), kind: Kind, name: String, imageData: Data? = nil, fileData: Data? = nil,
         mediaType: String? = nil, store: AttachmentStore = .shared) {
        self.id = id
        self.kind = kind
        self.name = name
        self.hasImage = imageData != nil
        self.mediaType = mediaType
        if let data = imageData ?? fileData { store.stage(data, id: id) }
    }

    var imageData: Data? { hasImage ? AttachmentStore.shared.data(for: id) : nil }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        kind = try c.decode(Kind.self, forKey: .kind)
        name = try c.decode(String.self, forKey: .name)
        hasImage = try c.decode(Bool.self, forKey: .hasImage)
        mediaType = try c.decodeIfPresent(String.self, forKey: .mediaType)
        isHiddenFromCode = try c.decodeIfPresent(Bool.self, forKey: .isHiddenFromCode) ?? false
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(kind, forKey: .kind)
        try c.encode(name, forKey: .name)
        try c.encode(hasImage, forKey: .hasImage)
        try c.encodeIfPresent(mediaType, forKey: .mediaType)
        if isHiddenFromCode { try c.encode(true, forKey: .isHiddenFromCode) }
    }
}

// MARK: Transcript

enum StepKind: String, Equatable, Codable {
    case integration, command, edits, webSearch, webFetch, readFile, think, skill, tool
    var lucide: String {
        switch self {
        case .integration: return "link-2"
        case .command: return "terminal"
        case .edits: return "pencil"
        case .webSearch: return "search"
        case .webFetch: return "globe"
        case .readFile: return "file-text"
        case .think: return "lightbulb"
        case .skill: return "wrench"
        case .tool: return "waypoints"
        }
    }
}

/// Image traces reference the turn attachment whose thumbnail they show.
struct Trace: Identifiable, Equatable, Codable {
    var id = UUID()
    var kind: TraceKind
    var text: String
    var attachment: Attachment?
}

struct CommandData: Identifiable, Equatable, Codable {
    var id = UUID()
    var code: String
    var language: String?
    /// Tail capped at maxLines; older lines are counted in droppedLineCount, never stored.
    var lines: [String] = []
    var droppedLineCount = 0
    var result: String?
    var exitCode: Int?
    /// Running timer reads this so cards recreated on scroll or chat switch keep counting.
    var startedAt: Date?
    var duration: TimeInterval = 0
    var isRunning: Bool = false
    var isExpanded: Bool = false

    static let maxLines = 200

    var totalLineCount: Int { droppedLineCount + lines.count }

    mutating func append(_ newLines: [String]) {
        lines.append(contentsOf: newLines)
        let overflow = lines.count - Self.maxLines
        if overflow > 0 {
            lines.removeFirst(overflow)
            droppedLineCount += overflow
        }
    }
}

struct PendingApproval: Equatable, Codable {
    /// Tool call id, or parent/... for a call made from inside code.
    var requestID: String
    var title: String
    var reason: String
    var toolName: String
    var sourceName: String?
    var arguments: String
    /// Enclosing JS run call ID when invoked from code; card renders in that step.
    var parentCallID: String? = nil
}

struct StepSignIn: Equatable, Codable, Hashable {
    var serverID: String
    var serverName: String
}

struct Step: Identifiable, Equatable, Codable {
    enum Status: String, Codable {
        case pending
        case awaitingApproval
        case running
        case succeeded, failed, denied, cancelled
    }

    var id = UUID()
    /// Tool call id (or reasoning block key) this row follows.
    var toolCallID: String?
    var kind: StepKind
    var runningSummary: String
    var finalSummary: String
    var status: Status = .succeeded
    var startedAt: Date?
    /// Capped at maxTraces; older traces are counted in droppedTraceCount, never stored.
    var traces: [Trace] = []
    var droppedTraceCount: Int {
        get { storedDroppedTraceCount ?? 0 }
        set { storedDroppedTraceCount = newValue == 0 ? nil : newValue }
    }
    /// Optional so older conversation files decode; internal to keep memberwise init internal.
    var storedDroppedTraceCount: Int? = nil
    var command: CommandData?
    var approval: PendingApproval?
    /// Approvals for calls made from inside this step's JS code; several can wait at once.
    var codeApprovals: [PendingApproval] {
        get { pendingCodeApprovals ?? [] }
        set { pendingCodeApprovals = newValue.isEmpty ? nil : newValue }
    }
    /// Optional so older conversation files decode; internal to keep memberwise init internal.
    var pendingCodeApprovals: [PendingApproval]? = nil
    /// Optional so older files decode; set when a connector refuses for missing credentials.
    var signIn: StepSignIn? = nil

    // Presentation fields below are optional so older files decode, falling back to summaries.
    /// Who did it ("Exa", "GitHub"); nil for built-in tools.
    var source: String? = nil
    var title: String? = nil
    var detail: String? = nil
    var arguments: String? = nil
    var result: String? = nil
    /// Stored in the model rather than view state because lazy rows are recreated on scroll.
    var detailsOpen: Bool? = nil

    var isWaitingOnUser: Bool { approval != nil || pendingCodeApprovals != nil }

    var isRunning: Bool {
        switch status {
        case .pending, .awaitingApproval, .running: return true
        case .succeeded, .failed, .denied, .cancelled: return false
        }
    }

    static let maxTraces = 200

    var totalTraceCount: Int { droppedTraceCount + traces.count }

    mutating func appendTrace(_ trace: Trace) {
        traces.append(trace)
        let overflow = traces.count - Self.maxTraces
        if overflow > 0 {
            traces.removeFirst(overflow)
            droppedTraceCount += overflow
        }
    }
}

struct ActivityData: Identifiable, Equatable, Codable {
    var id = UUID()
    var steps: [Step] = []
    var isRunning: Bool = false
    var isStopped: Bool = false
    var startedAt: Date?
    var elapsed: TimeInterval = 0
    /// nil = untouched (auto-collapse wins); non-nil = user's choice wins (§10).
    var userExpanded: Bool?
    var isExpanded: Bool = false
    var label: String {
        if isStopped { return "Stopped after \(DurationFormatter.format(elapsed))" }
        if isRunning { return "Currently working…" }
        return "Worked for \(DurationFormatter.format(elapsed))"
    }
}

enum Block: Identifiable, Equatable, Codable {
    case activity(ActivityData)
    /// While isStreaming, text lives in LiveText; source is written only once the block closes.
    case markdown(id: UUID, source: String, isStreaming: Bool)
    case compaction(CompactionMarker)
    var id: UUID {
        switch self {
        case .activity(let a): return a.id
        case .markdown(let id, _, _): return id
        case .compaction(let m): return m.id
        }
    }
}

/// Persisted per turn with its summary so older markers keep theirs after relaunch.
struct CompactionMarker: Identifiable, Equatable, Codable {
    var id = UUID()
    var key: String
    var state: State
    var summary: String = ""
    /// Estimated prompt size before compaction (0 = unknown).
    var tokensBefore = 0
    var tokensAfter = 0
    var date = Date()

    enum State: Equatable, Codable {
        case running
        case done
        case failed(String)
    }
}

enum TurnOutcome: Equatable, Codable {
    case completed
    case stopped
    /// System expired background time; turn keeps partial answer and offers Continue to resume.
    case pausedBackground
    case truncated
    case maxIterations
    case refused(String?)
    case failed(String)
    case needsProvider

    init(_ outcome: RunOutcome) {
        switch outcome {
        case .completed: self = .completed
        case .truncated: self = .truncated
        case .maxIterations: self = .maxIterations
        case .refused(let category): self = .refused(category)
        case .cancelled: self = .stopped
        case .failed(let message):
            self = message == LiveChatEngine.noProviderReason ? .needsProvider : .failed(message)
        }
    }

    var note: String? {
        switch self {
        case .completed: return nil
        case .stopped: return "Stopped"
        case .pausedBackground: return "Paused in background"
        case .truncated: return "Cut off — the answer hit the output limit"
        case .maxIterations: return "Paused — reached the step limit for this effort"
        case .refused(let category): return category.map { "Declined to answer (\($0))" } ?? "Declined to answer"
        case .failed(let message): return "Couldn't finish: \(message)"
        case .needsProvider: return "Add a model provider in Settings to get a real answer"
        }
    }
}

struct Turn: Identifiable, Equatable, Codable {
    /// Settable so a draft can carry its turn's id before it is sent.
    var id = UUID()
    var userText: String
    var attachments: [Attachment] = []
    var blocks: [Block] = []
    var isRunning: Bool = false
    var isFinished: Bool = false
    var outcome: TurnOutcome?
    var feedback: Feedback = .none
    var modelID: String?
    /// Provider-neutral committed messages for this turn; replayed on the next request.
    var transcript: [Message] = []
    /// Live runs only replay live turns; demo replies are scripted text no real model sees.
    var engine: EngineKind?
    /// Durable server run identity; cloud recovery replays its wire journal.
    var cloudRunID: String?
    /// Opaque server turn key; UUIDs below remain presentation identities only.
    var cloudClientTurnID: String?
    /// Synced turns may only attach to existing server work, never start it.
    var cloudRemoteOrigin: Bool?
    enum Feedback: String, Equatable, Codable { case none, up, down }
}

/// Reference type so token streaming only invalidates views observing this thread's turns.
@Observable
final class Conversation: Identifiable {
    let id: UUID
    var title: String
    var updatedAt: Date
    var turns: [Turn]
    var isPinned: Bool
    /// System prompt and tool list frozen on first send and reused on later runs; nil until sent.
    var setup: ConversationSetup?
    /// Nil means all enabled installed servers; only consulted once when setup freezes.
    var connectorIDs: [String]?
    /// Per-chat disabled frozen connectors; tools stay in frozen prefix, runtime refuses calls.
    var disabledServerIDs: Set<String>
    /// Latest compaction summary sent instead of covered history; ignored if history is cut.
    var compaction: ContextCompaction?
    /// Last provider-reported prompt size for its prefix; next run budgets from it + new deltas.
    var contextMeasurement: ContextMeasurement?
    var cloudChatID: String?

    init(id: UUID = UUID(), title: String, updatedAt: Date = Date(), turns: [Turn] = [], isPinned: Bool = false,
         setup: ConversationSetup? = nil, connectorIDs: [String]? = nil, disabledServerIDs: Set<String> = [],
         compaction: ContextCompaction? = nil, contextMeasurement: ContextMeasurement? = nil,
         cloudChatID: String? = nil) {
        self.cloudChatID = cloudChatID
        self.contextMeasurement = contextMeasurement
        self.id = id
        self.title = title
        self.updatedAt = updatedAt
        self.turns = turns
        self.isPinned = isPinned
        self.setup = setup
        self.connectorIDs = connectorIDs
        self.disabledServerIDs = disabledServerIDs
        self.compaction = compaction
    }

    var record: ConversationRecord {
        ConversationRecord(id: id, title: title, updatedAt: updatedAt, isPinned: isPinned, turns: turns,
                           setup: setup, connectorIDs: connectorIDs, disabledServerIDs: disabledServerIDs,
                           compaction: compaction, contextMeasurement: contextMeasurement, cloudChatID: cloudChatID)
    }

    convenience init(record: ConversationRecord) {
        self.init(id: record.id, title: record.title, updatedAt: record.updatedAt,
                  turns: record.turns, isPinned: record.isPinned, setup: record.setup,
                  connectorIDs: record.connectorIDs, disabledServerIDs: record.disabledServerIDs,
                  compaction: record.compaction, contextMeasurement: record.contextMeasurement, cloudChatID: record.cloudChatID)
    }
}

/// Optional fields default on decode (newer compaction dropped); newer setup fails and skips.
struct ConversationRecord: Codable, Sendable, Equatable {
    static let currentVersion = 2

    var version = ConversationRecord.currentVersion
    var id: UUID
    var title: String
    var updatedAt: Date
    var isPinned: Bool
    var turns: [Turn]
    var setup: ConversationSetup?
    var connectorIDs: [String]?
    var disabledServerIDs: Set<String>
    var compaction: ContextCompaction?
    var contextMeasurement: ContextMeasurement?
    var cloudChatID: String?

    init(id: UUID, title: String, updatedAt: Date, isPinned: Bool, turns: [Turn],
         setup: ConversationSetup? = nil, connectorIDs: [String]? = nil, disabledServerIDs: Set<String> = [],
         compaction: ContextCompaction? = nil, contextMeasurement: ContextMeasurement? = nil,
         cloudChatID: String? = nil) {
        self.cloudChatID = cloudChatID
        self.contextMeasurement = contextMeasurement
        self.id = id
        self.title = title
        self.updatedAt = updatedAt
        self.isPinned = isPinned
        self.turns = turns
        self.setup = setup
        self.connectorIDs = connectorIDs
        self.disabledServerIDs = disabledServerIDs
        self.compaction = compaction
    }

    private enum CodingKeys: String, CodingKey {
        case version, id, title, updatedAt, isPinned, turns, setup, connectorIDs, disabledServerIDs, compaction
        case contextMeasurement, cloudChatID
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        id = try c.decode(UUID.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        updatedAt = try c.decode(Date.self, forKey: .updatedAt)
        isPinned = try c.decode(Bool.self, forKey: .isPinned)
        turns = try c.decode([Turn].self, forKey: .turns)
        setup = try c.decodeIfPresent(ConversationSetup.self, forKey: .setup)
        connectorIDs = try c.decodeIfPresent([String].self, forKey: .connectorIDs)
        disabledServerIDs = Set(try c.decodeIfPresent([String].self, forKey: .disabledServerIDs) ?? [])
        // Disposable: decode failure just triggers fresh compaction on the next long request.
        compaction = (try? c.decodeIfPresent(ContextCompaction.self, forKey: .compaction)) ?? nil
        // Disposable too: without it the next run just estimates.
        contextMeasurement = (try? c.decodeIfPresent(ContextMeasurement.self, forKey: .contextMeasurement)) ?? nil
        cloudChatID = try c.decodeIfPresent(String.self, forKey: .cloudChatID)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(Self.currentVersion, forKey: .version)
        try c.encode(id, forKey: .id)
        try c.encode(title, forKey: .title)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(isPinned, forKey: .isPinned)
        try c.encode(turns, forKey: .turns)
        try c.encodeIfPresent(setup, forKey: .setup)
        try c.encodeIfPresent(connectorIDs, forKey: .connectorIDs)
        // Sorted: the file stays byte-stable across saves.
        if !disabledServerIDs.isEmpty { try c.encode(disabledServerIDs.sorted(), forKey: .disabledServerIDs) }
        try c.encodeIfPresent(compaction, forKey: .compaction)
        try c.encodeIfPresent(contextMeasurement, forKey: .contextMeasurement)
        try c.encodeIfPresent(cloudChatID, forKey: .cloudChatID)
    }
}

enum DurationFormatter {
    static func format(_ t: TimeInterval) -> String {
        let s = Int(t.rounded())
        if s < 60 { return "\(s)s" }
        return "\(s / 60)m \(s % 60)s"
    }
    static func live(_ t: TimeInterval) -> String {
        String(format: "%.1fs", t)
    }
}
