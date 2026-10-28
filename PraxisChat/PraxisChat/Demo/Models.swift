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
    /// The runtime's mode: same four cases, the policy table lives there.
    var agentMode: AgentMode { AgentMode(rawValue: rawValue) ?? .auto }
}

/// The effort dial is the runtime's `Effort`; the app adds presentation
/// and the demo engine's pacing.
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
    /// Streaming speed multiplier (spec §10: model scales streaming speed).
    let streamMultiplier: Double
    /// Reasoning levels the tray offers for this model. Nil = unknown (all
    /// four); empty = no reasoning (the control hides). Live models resolve
    /// this from the provider (`ChatStore.supportedEfforts`); the demo
    /// catalogue hard-codes interesting cases. (`var`: a `let` with a
    /// default is left out of the memberwise initializer.)
    var effortLevels: [Effort]? = nil
}

struct Connector: Identifiable, Equatable {
    let id: String
    let name: String
    let monogram: String
    var isOn: Bool
    /// Why the row can't be toggled here (e.g. "Off in Settings"); nil = toggleable.
    var lockedReason: String? = nil
}

// MARK: Attachments

/// A reference to an attachment. The bytes live in `AttachmentStore`
/// (memory while in the composer, on disk once sent), so turns, previews
/// and persisted conversations carry only the id.
struct Attachment: Identifiable, Equatable, Hashable, Codable, Sendable {
    var id: UUID
    var kind: Kind
    var name: String
    /// True when image bytes were stored under `id`.
    var hasImage: Bool
    /// MIME type of a picked file (nil for photos: sniffed from the bytes).
    var mediaType: String?
    /// The user hid this file from code ("Hide from code"): JS `fs`
    /// neither lists nor reads it, in any turn. The model still sees an
    /// image or document sent inline with its message. Persisted with
    /// the conversation; absent on disk = available.
    var isHiddenFromCode = false
    enum Kind: String, Equatable, Hashable, Codable, Sendable { case photo, file, screenshot, camera }

    private enum CodingKeys: String, CodingKey { case id, kind, name, hasImage, mediaType, isHiddenFromCode }

    /// `fileData`: a picked file's bytes, staged like image bytes so the
    /// live engine can send them (documents) or expose them to JS `fs`.
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

/// Micro-trace under a step. `kind` is the runtime's `TraceKind`; image
/// traces reference the turn attachment whose thumbnail they show.
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
    /// Live tail of the output, at most `maxLines` (older lines are counted
    /// in `droppedLineCount`, never kept in the transcript model).
    var lines: [String] = []
    var droppedLineCount = 0
    /// Return value / result preview reported when the tool finished.
    var result: String?
    var exitCode: Int?
    /// When execution started; the running timer reads this, so a card
    /// recreated mid-run (scroll recycling, chat switch) keeps counting.
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

/// An approval card waiting on the user (rendered inside the step).
struct PendingApproval: Equatable, Codable {
    /// Approval request id (the tool call id, or `parent/…` for a call
    /// made from inside code).
    var requestID: String
    var title: String
    var reason: String
    var toolName: String
    var sourceName: String?
    /// Pretty-printed arguments, shown in full.
    var arguments: String
    /// The model-issued call (a JS run) this call came from, when it was
    /// made from inside code. The card then renders in that run's step.
    var parentCallID: String? = nil
}

/// The connector a step needs the user to sign in to.
struct StepSignIn: Equatable, Codable, Hashable {
    var serverID: String
    var serverName: String
}

struct Step: Identifiable, Equatable, Codable {
    enum Status: String, Codable {
        /// Arguments still streaming / waiting to run.
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
    /// Live tail of the step's traces, at most `maxTraces` (older traces
    /// are counted in `droppedTraceCount`, never kept in the transcript
    /// model). Same shape as `CommandData`'s capped output lines.
    var traces: [Trace] = []
    /// Older traces dropped to stay bounded (same shape as
    /// `CommandData.droppedLineCount`).
    var droppedTraceCount: Int {
        get { storedDroppedTraceCount ?? 0 }
        set { storedDroppedTraceCount = newValue == 0 ? nil : newValue }
    }
    /// Storage for `droppedTraceCount`: optional so older conversation
    /// files still decode (internal only to keep the memberwise init internal).
    var storedDroppedTraceCount: Int? = nil
    var command: CommandData?
    var approval: PendingApproval?
    /// Approvals for calls made from inside this step's code (JS code
    /// mode); several can wait at once.
    var codeApprovals: [PendingApproval] {
        get { pendingCodeApprovals ?? [] }
        set { pendingCodeApprovals = newValue.isEmpty ? nil : newValue }
    }
    /// Storage for `codeApprovals`: optional so older conversation files
    /// still decode (internal only to keep the memberwise init internal).
    var pendingCodeApprovals: [PendingApproval]? = nil
    /// A connector refused this step for missing credentials; the
    /// activity offers "Sign in to <server>". Optional: older files decode.
    var signIn: StepSignIn? = nil

    // How the line reads (see `StepPresentation`). All optional so older
    // conversation files still decode; a step without them falls back to
    // its summaries.
    /// Who did it ("Exa", "GitHub"); nil for built-in tools.
    var source: String? = nil
    /// The tool's own title without the source ("Web search").
    var title: String? = nil
    /// The call's key argument (a query, URL, path), one line.
    var detail: String? = nil
    /// The call's input, pretty-printed.
    var arguments: String? = nil
    /// What the tool returned (a preview), or what a thought reasoned.
    var result: String? = nil
    /// The user opened this line's details (rows are recreated while
    /// scrolling, so the choice lives in the model, not in view state).
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

    /// Appends one trace, keeping only the newest `maxTraces`.
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
    /// While `isStreaming`, the text lives in the block's `LiveText`;
    /// `source` is written once the block closes.
    case markdown(id: UUID, source: String, isStreaming: Bool)
    /// Older history was condensed for the model here (a thin divider row).
    case compaction(CompactionMarker)
    var id: UUID {
        switch self {
        case .activity(let a): return a.id
        case .markdown(let id, _, _): return id
        case .compaction(let m): return m.id
        }
    }
}

/// Where a context compaction happened in the thread, with what the
/// model now remembers of everything before it. Persisted with the turn,
/// summary included, so each marker shows its own summary after relaunch
/// (the conversation keeps only the latest `ContextCompaction`).
struct CompactionMarker: Identifiable, Equatable, Codable {
    var id = UUID()
    /// The run's compaction id (`AgentEvent.compaction`).
    var key: String
    var state: State
    var summary: String = ""
    /// Estimated prompt size before and after (0 = unknown).
    var tokensBefore = 0
    var tokensAfter = 0
    var date = Date()

    enum State: Equatable, Codable {
        case running
        case done
        case failed(String)
    }
}

/// How a finished run ended, when that's worth a note under the answer.
enum TurnOutcome: Equatable, Codable {
    case completed
    case stopped
    case truncated
    case maxIterations
    case refused(String?)
    case failed(String)
    /// Live run with no provider configured: the note links to Settings.
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

    /// Quiet one-line note; nil when the run simply finished.
    var note: String? {
        switch self {
        case .completed: return nil
        case .stopped: return "Stopped"
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
    /// Model that produced this turn.
    var modelID: String?
    /// Provider-neutral messages for this turn: the user message, then
    /// everything the run committed. The next request replays these.
    var transcript: [Message] = []
    /// Engine that ran the turn. Live runs only replay live turns: demo
    /// replies are scripted text no real model should see.
    var engine: EngineKind?
    enum Feedback: String, Equatable, Codable { case none, up, down }
}

/// A reference type so the transcript observes `turns` per conversation:
/// a streamed token invalidates only the views reading this thread's
/// turns — not the toolbar, the composer, or every other conversation.
@Observable
final class Conversation: Identifiable {
    let id: UUID
    var title: String
    var updatedAt: Date
    var turns: [Turn]
    var isPinned: Bool
    /// What the live engine froze at the first send (system prompt, tool
    /// list). Every later run reuses it; nil until then.
    var setup: ConversationSetup?
    /// Connectors enabled for this conversation; nil = the installed
    /// servers that are on. Only consulted when the setup is frozen.
    var connectorIDs: [String]?
    /// Frozen connectors the user turned off in this chat only. Their
    /// tools stay in the frozen list (the prefix can't change) but the
    /// runtime refuses to run them (`RunRequest.disabledServerIDs`).
    var disabledServerIDs: Set<String>
    /// The latest context compaction: later live requests send its
    /// summary in place of the history it covers. The turns keep the
    /// full transcript; the runtime ignores the record once the history
    /// it summarizes is cut (retry, edit).
    var compaction: ContextCompaction?
    /// The prompt size the provider last reported, tied to the transcript
    /// prefix it measured: the next run budgets its first request from it
    /// (plus estimates for newer messages) instead of a byte count.
    var contextMeasurement: ContextMeasurement?

    init(id: UUID = UUID(), title: String, updatedAt: Date = Date(), turns: [Turn] = [], isPinned: Bool = false,
         setup: ConversationSetup? = nil, connectorIDs: [String]? = nil, disabledServerIDs: Set<String> = [],
         compaction: ContextCompaction? = nil, contextMeasurement: ContextMeasurement? = nil) {
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

    /// Value snapshot for persistence.
    var record: ConversationRecord {
        ConversationRecord(id: id, title: title, updatedAt: updatedAt, isPinned: isPinned, turns: turns,
                           setup: setup, connectorIDs: connectorIDs, disabledServerIDs: disabledServerIDs,
                           compaction: compaction, contextMeasurement: contextMeasurement)
    }

    convenience init(record: ConversationRecord) {
        self.init(id: record.id, title: record.title, updatedAt: record.updatedAt,
                  turns: record.turns, isPinned: record.isPinned, setup: record.setup,
                  connectorIDs: record.connectorIDs, disabledServerIDs: record.disabledServerIDs,
                  compaction: record.compaction, contextMeasurement: record.contextMeasurement)
    }
}

/// What a conversation file holds on disk.
///
/// Version 2 added `setup` and `connectorIDs`; version-1 files decode
/// with neither. `disabledServerIDs` is optional on disk (absent = none
/// off), so it needed no version bump; nor did `compaction` (absent =
/// none; one written by a newer build is dropped, not fatal), nor
/// `contextMeasurement` (same rules), nor attachments' `isHiddenFromCode`. A setup written by a newer build fails to decode (the
/// runtime refuses to rebuild a prefix with older rules), and with it
/// the record — it's skipped at load like any unreadable file.
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

    init(id: UUID, title: String, updatedAt: Date, isPinned: Bool, turns: [Turn],
         setup: ConversationSetup? = nil, connectorIDs: [String]? = nil, disabledServerIDs: Set<String> = [],
         compaction: ContextCompaction? = nil, contextMeasurement: ContextMeasurement? = nil) {
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
        case contextMeasurement
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
        // Optional and disposable: an unreadable record just means the
        // next long request compacts again.
        compaction = (try? c.decodeIfPresent(ContextCompaction.self, forKey: .compaction)) ?? nil
        // Disposable too: without it the next run just estimates.
        contextMeasurement = (try? c.decodeIfPresent(ContextMeasurement.self, forKey: .contextMeasurement)) ?? nil
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
