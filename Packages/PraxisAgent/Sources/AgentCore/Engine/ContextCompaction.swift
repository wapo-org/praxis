import Foundation

/// Client-side context compaction: the first `coveredMessages` messages of
/// a conversation's transcript, condensed into `summary` by the
/// conversation's own model.
///
/// The transcript itself is never edited — it stays append-only and is
/// kept whole for the UI. A compaction is a separate, persisted record:
/// requests send `[summary + transcript[coveredMessages...]]` in place of
/// the full history (`requestMessages(for:)`). The system prompt and the
/// tool list are untouched, so the cached prefix ahead of the messages
/// survives a compaction.
///
/// The record is tied to the exact prefix it summarizes (`fingerprint`):
/// when retry or edit cut into that prefix it no longer `applies(to:)`,
/// and requests fall back to the full transcript (compacting again if it
/// is still too long).
public struct ContextCompaction: Codable, Sendable, Hashable {
    public static let currentVersion = 1

    public var version: Int
    public var summary: String
    /// How many leading transcript messages `summary` stands in for.
    public var coveredMessages: Int
    /// `ContextCompaction.fingerprint` of those messages.
    public var fingerprint: String
    /// The model that wrote the summary.
    public var model: String
    public var createdAt: Date
    /// Estimated prompt size before and after, for display.
    public var tokensBefore: Int
    public var tokensAfter: Int

    public init(summary: String, coveredMessages: Int, fingerprint: String, model: String, createdAt: Date = Date(),
                tokensBefore: Int = 0, tokensAfter: Int = 0) {
        self.version = Self.currentVersion
        self.summary = summary
        self.coveredMessages = coveredMessages
        self.fingerprint = fingerprint
        self.model = model
        self.createdAt = createdAt
        self.tokensBefore = tokensBefore
        self.tokensAfter = tokensAfter
    }

    /// Refuses records written by a newer build (they may mean something
    /// else); callers treat that as "no compaction".
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        guard version <= Self.currentVersion else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: c,
                                                   debugDescription: "Compaction version \(version) is newer than this build supports.")
        }
        summary = try c.decode(String.self, forKey: .summary)
        coveredMessages = try c.decode(Int.self, forKey: .coveredMessages)
        fingerprint = try c.decode(String.self, forKey: .fingerprint)
        model = try c.decode(String.self, forKey: .model)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        tokensBefore = try c.decodeIfPresent(Int.self, forKey: .tokensBefore) ?? 0
        tokensAfter = try c.decodeIfPresent(Int.self, forKey: .tokensAfter) ?? 0
    }

    /// The record still describes this transcript's prefix and leaves a
    /// non-empty tail.
    public func applies(to transcript: [Message]) -> Bool {
        coveredMessages > 0 && coveredMessages < transcript.count
            && Self.fingerprint(transcript[..<coveredMessages]) == fingerprint
    }

    /// What a request sends instead of `transcript` (which must satisfy
    /// `applies(to:)`).
    public func requestMessages(for transcript: [Message]) -> [Message] {
        Self.view(summary: summary, tail: transcript[min(coveredMessages, transcript.count)...])
    }

    /// The summary as the first user message. When the tail already
    /// starts with a user message the summary joins it, so roles keep
    /// alternating on servers that insist on that.
    static func view(summary: String, tail: ArraySlice<Message>) -> [Message] {
        let preface = Part.text(Self.preface + summary)
        guard let first = tail.first else { return [Message(role: .user, parts: [preface])] }
        if first.role == .user {
            var merged = first
            merged.parts.insert(preface, at: 0)
            return [merged] + tail.dropFirst()
        }
        return [Message(role: .user, parts: [preface])] + tail
    }

    static let preface = """
        [Summary of the earlier conversation. The messages before this point were condensed to save context; \
        everything after it is verbatim.]


        """

    // MARK: Fingerprint

    /// Stable across launches and independent of attachment bytes and
    /// provider payloads (the app stores media by reference and replays
    /// raw payloads), so the same history always gives the same value.
    public static func fingerprint<C: Collection>(_ messages: C) -> String where C.Element == Message {
        var h = StableHasher()
        for message in messages {
            h.combine(message.role.rawValue)
            for part in message.parts {
                switch part {
                case .text(let t): h.combine("t"); h.combine(t)
                case .note(let n): h.combine("n"); h.combine(n)
                case .image(let m): h.combine("i"); h.combine(m.mediaType); h.combine(m.name ?? "")
                case .document(let m): h.combine("d"); h.combine(m.mediaType); h.combine(m.name ?? "")
                case .reasoning(let r): h.combine("r"); h.combine(r.text)
                case .toolCall(let c): h.combine("c"); h.combine(c.id); h.combine(c.name); h.combine(c.arguments)
                case .toolResult(let r):
                    h.combine(r.isError ? "E" : "R"); h.combine(r.callID)
                    for content in r.content {
                        switch content {
                        case .text(let t): h.combine(t)
                        case .image(let m): h.combine(m.mediaType)
                        }
                    }
                }
            }
            h.combine("|")
        }
        return "\(messages.count)-" + String(h.value, radix: 36)
    }

    // MARK: Split point

    /// Where to cut so that `messages[k...]` is kept verbatim. A valid cut
    /// never separates tool calls from their results: `messages[k]` must
    /// not carry tool results (its calls would be in the summary). The
    /// tail always keeps the last message.
    ///
    /// Picks the earliest valid cut after `start` whose tail fits in
    /// `keepTokens`; when even the shortest tail is larger, the latest
    /// valid cut. Nil when no cut lies after `start` (nothing new to
    /// summarize).
    public static func splitPoint(in messages: [Message], after start: Int, keepTokens: Int) -> Int? {
        guard messages.count >= 2 else { return nil }
        var tail = 0
        var best: Int?
        var latest: Int?
        for k in stride(from: messages.count - 1, to: max(start, 0), by: -1) {
            tail += TokenEstimator.tokens(messages[k])
            guard isValidSplit(messages, at: k) else { continue }
            if latest == nil { latest = k }
            if tail <= keepTokens { best = k } else { break }
        }
        return best ?? latest
    }

    static func isValidSplit(_ messages: [Message], at k: Int) -> Bool {
        // Results always directly follow their calls, so a tail that
        // doesn't open with results holds every call its results answer.
        k > 0 && k < messages.count && messages[k].toolResults.isEmpty
    }
}

/// The prompt size a provider last reported for a conversation, tied to
/// the exact transcript prefix it measured.
///
/// Runs start from it instead of a byte-count estimate: the next request's
/// size is `promptTokens` plus estimates for messages appended after
/// `messageCount`. Persist the latest one with the conversation (from
/// `AgentEvent.contextMeasured`) and pass it to later runs
/// (`AgentRunConfiguration.measurement`). It is ignored once it no longer
/// describes the transcript — retry/edit cut into the measured prefix, a
/// different model (another tokenizer), or a different compaction.
public struct ContextMeasurement: Codable, Sendable, Hashable {
    public static let currentVersion = 1

    public var version: Int
    /// The model that counted the tokens.
    public var model: String
    /// Leading transcript messages the measured request carried.
    public var messageCount: Int
    /// `ContextCompaction.fingerprint` of those messages.
    public var fingerprint: String
    /// `coveredMessages` of the compaction the request was sent through
    /// (0: none).
    public var compactedMessages: Int
    /// Reported prompt size: input plus cache-read and cache-write tokens
    /// (system prompt and tools included).
    public var promptTokens: Int
    public var measuredAt: Date

    public init(model: String, messageCount: Int, fingerprint: String, compactedMessages: Int, promptTokens: Int,
                measuredAt: Date = Date()) {
        self.version = Self.currentVersion
        self.model = model
        self.messageCount = messageCount
        self.fingerprint = fingerprint
        self.compactedMessages = compactedMessages
        self.promptTokens = promptTokens
        self.measuredAt = measuredAt
    }

    /// The measurement of a request carrying `messages`.
    public init(model: String, messages: [Message], compactedMessages: Int, usage: Usage, measuredAt: Date = Date()) {
        self.init(model: model, messageCount: messages.count, fingerprint: ContextCompaction.fingerprint(messages),
                  compactedMessages: compactedMessages, promptTokens: usage.contextTokens, measuredAt: measuredAt)
    }

    /// Refuses records written by a newer build; callers treat that as
    /// "no measurement".
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        guard version <= Self.currentVersion else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: c,
                                                   debugDescription: "Measurement version \(version) is newer than this build supports.")
        }
        model = try c.decode(String.self, forKey: .model)
        messageCount = try c.decode(Int.self, forKey: .messageCount)
        fingerprint = try c.decode(String.self, forKey: .fingerprint)
        compactedMessages = try c.decode(Int.self, forKey: .compactedMessages)
        promptTokens = try c.decode(Int.self, forKey: .promptTokens)
        measuredAt = try c.decode(Date.self, forKey: .measuredAt)
    }

    /// Still a measurement of `transcript`'s prefix, for this model and
    /// compaction.
    public func applies(to transcript: [Message], model: String, compactedMessages: Int) -> Bool {
        promptTokens > 0 && messageCount > 0 && messageCount <= transcript.count
            && self.model == model && self.compactedMessages == compactedMessages
            && ContextCompaction.fingerprint(transcript[..<messageCount]) == fingerprint
    }
}

/// Context-window budget for one run.
public struct ContextPolicy: Sendable, Hashable {
    /// The model's window (`ModelInfo.contextWindow`) when known.
    public var contextWindow: Int?
    /// Used when the window is unknown. Smaller servers report overflow,
    /// which compacts and retries.
    public var fallbackContextWindow: Int
    /// Compact once the next request would exceed this share of the
    /// window, less the room reserved for output.
    public var compactAt: Double
    /// Share of the compaction threshold kept verbatim as the recent tail.
    public var keepRecent: Double
    /// Output budget of the summary request.
    public var summaryMaxTokens: Int
    public var isEnabled: Bool

    public init(contextWindow: Int? = nil, fallbackContextWindow: Int = 128_000, compactAt: Double = 0.8,
                keepRecent: Double = 0.3, summaryMaxTokens: Int = 8_192, isEnabled: Bool = true) {
        self.contextWindow = contextWindow
        self.fallbackContextWindow = fallbackContextWindow
        self.compactAt = compactAt
        self.keepRecent = keepRecent
        self.summaryMaxTokens = summaryMaxTokens
        self.isEnabled = isEnabled
    }

    public var window: Int { max(4_096, contextWindow.flatMap { $0 > 0 ? $0 : nil } ?? fallbackContextWindow) }

    /// Prompt tokens above which a request is compacted first:
    /// `compactAt × window − output reserve`, the reserve being the
    /// request's `max_tokens` (at most a quarter of the window).
    public func threshold(window: Int, maxTokens: Int) -> Int {
        let reserve = min(max(0, maxTokens), window / 4)
        return max(1_024, Int(Double(window) * compactAt) - reserve)
    }
}

/// Rough token counts for budgeting, used where the provider hasn't
/// reported usage yet. Deliberately simple: ~4 UTF-8 bytes per token for
/// text, fixed costs for images, a per-page-ish guess for PDFs.
public enum TokenEstimator {
    public static let bytesPerToken = 4
    public static let imageTokens = 1_600
    static let messageOverhead = 4

    public static func tokens(_ text: String) -> Int { (text.utf8.count + bytesPerToken - 1) / bytesPerToken }

    public static func tokens(_ message: Message) -> Int {
        var n = messageOverhead
        for part in message.parts {
            switch part {
            case .text(let t), .note(let t): n += tokens(t)
            case .reasoning(let r): n += tokens(r.text)
            case .image: n += imageTokens
            case .document(let m): n += documentTokens(m)
            case .toolCall(let c): n += tokens(c.name) + tokens(c.arguments) + 8
            case .toolResult(let r):
                n += 8
                for content in r.content {
                    switch content {
                    case .text(let t): n += tokens(t)
                    case .image: n += imageTokens
                    }
                }
            }
        }
        return n
    }

    public static func tokens<C: Collection>(_ messages: C) -> Int where C.Element == Message {
        messages.reduce(0) { $0 + tokens($1) }
    }

    public static func tokens(system: String, tools: [ToolSpec]) -> Int {
        tools.reduce(tokens(system)) { $0 + tokens($1.name) + tokens($1.description) + tokens($1.inputSchema.encodedString()) + 8 }
    }

    static func documentTokens(_ media: MediaData) -> Int {
        if media.mediaType == "application/pdf" { return max(1_500, media.data.count / 30) }
        // References (app-side dehydrated bytes) are tiny; count them as a page.
        return max(media.data.count / bytesPerToken, 100)
    }
}

/// Why a compaction ran.
public enum CompactionReason: String, Sendable, Codable, Hashable {
    /// The next request would have crossed `ContextPolicy.threshold`.
    case threshold
    /// The provider rejected a request as too long for its window.
    case overflow
}

/// Progress of one compaction, reported as `AgentEvent.compaction`.
public enum CompactionUpdate: Sendable, Hashable {
    case started(CompactionReason)
    /// Persist the record with the conversation and pass it to later
    /// runs (`AgentRunConfiguration.compaction`).
    case finished(ContextCompaction)
    /// The run carries on with the full history (or, on overflow, fails).
    case failed(String)
}

public extension ProviderError {
    /// The provider said the request doesn't fit the model's context
    /// window. Matched on wording, since every server phrases it
    /// differently (Anthropic "prompt is too long", OpenAI
    /// `context_length_exceeded`, vLLM / llama.cpp / OpenRouter / Groq …).
    var isContextOverflow: Bool {
        let text: String
        switch self {
        case .http(let status, let message, _):
            if status == 413 { return true }
            guard status == 400 || status == 422 else { return false }
            text = message
        case .stream(let type, let message):
            text = type + " " + message
        default:
            return false
        }
        let lower = text.lowercased()
        return Self.overflowPhrases.contains { lower.contains($0) }
    }

    private static let overflowPhrases = [
        "prompt is too long", "prompt too long", "context length", "context_length", "context window",
        "context_window", "context size", "maximum context", "too many tokens", "too many input tokens",
        "input is too long", "input too long", "reduce the length", "input token count", "exceeds the maximum number of tokens",
        "request_too_large", "max_new_tokens",
    ]

    /// The window size the error quotes, when it does
    /// ("maximum context length is 8192 tokens", "… > 200000 maximum").
    var reportedContextLimit: Int? {
        let message: String
        switch self {
        case .http(_, let m, _), .stream(_, let m): message = m
        default: return nil
        }
        let patterns = [
            /maximum context length is (\d[\d,]*)/,
            /> ?(\d[\d,]*) maximum/,
            /context size \((\d[\d,]*)/,
            /context window of (\d[\d,]*)/,
            /maximum number of tokens allowed \((\d[\d,]*)\)/,
        ]
        for pattern in patterns {
            if let match = message.firstMatch(of: pattern.ignoresCase()),
               let n = Int(match.1.replacingOccurrences(of: ",", with: "")), n > 0 {
                return n
            }
        }
        return nil
    }
}

/// FNV-1a with length-prefixed fields; stable across launches.
struct StableHasher {
    private(set) var value: UInt64 = 0xcbf29ce484222325

    mutating func combine(_ s: String) {
        mix(UInt64(s.utf8.count))
        for b in s.utf8 { value ^= UInt64(b); value = value &* 0x100000001b3 }
    }

    private mutating func mix(_ n: UInt64) {
        var n = n
        for _ in 0..<8 {
            value ^= n & 0xff
            value = value &* 0x100000001b3
            n >>= 8
        }
    }
}

/// One run's view of its context budget: the active compaction, the last
/// measured prompt size and what overflow errors taught about the window.
/// Owned by the run's task.
final class ContextState {
    let policy: ContextPolicy
    var compaction: ContextCompaction?
    /// System prompt + tool specs, estimated once.
    let fixedTokens: Int
    /// Prompt size the provider reported, as of `messageCount` transcript
    /// messages (including the response it produced) under `covered`.
    var calibration: (messageCount: Int, covered: Int, tokens: Int)?
    /// A smaller window learned from an overflow error.
    var learnedWindow: Int?
    var overflowRetried = false
    var summaryUsage = Usage()
    var sequence = 0

    /// - Parameter measurement: the conversation's last measured prompt
    ///   (from an earlier run), used as the starting calibration when it
    ///   still applies to `transcript`.
    init(policy: ContextPolicy, compaction: ContextCompaction?, fixedTokens: Int,
         measurement: ContextMeasurement? = nil, transcript: [Message] = [], model: String = "") {
        self.policy = policy
        self.compaction = compaction
        self.fixedTokens = fixedTokens
        let covered = compaction?.coveredMessages ?? 0
        if let m = measurement, m.applies(to: transcript, model: model, compactedMessages: covered) {
            calibration = (m.messageCount, covered, m.promptTokens)
        }
    }

    var window: Int { min(policy.window, learnedWindow ?? .max) }
    var canRetryOverflow: Bool { policy.isEnabled && !overflowRetried }

    func requestMessages(_ messages: [Message]) -> [Message] {
        guard let compaction, compaction.coveredMessages < messages.count else { return messages }
        return compaction.requestMessages(for: messages)
    }

    /// Prompt tokens of the request for `messages`: the last reported
    /// size plus estimates for what was appended since, else an estimate
    /// of the whole request.
    func estimate(_ messages: [Message]) -> Int {
        let covered = compaction?.coveredMessages ?? 0
        if let c = calibration, c.covered == covered, c.messageCount <= messages.count {
            return c.tokens + TokenEstimator.tokens(messages[c.messageCount...])
        }
        return fixedTokens + TokenEstimator.tokens(requestMessages(messages))
    }

    /// Records a response's reported prompt size; the response itself
    /// becomes the next transcript message.
    func calibrate(messages: [Message], usage: Usage) {
        guard usage.contextTokens > 0 else { return }
        calibration = (messages.count + 1, compaction?.coveredMessages ?? 0, usage.contextTokens + usage.outputTokens)
    }

    /// The window is at most what the error quoted, or else a bit under
    /// the size of the request that failed.
    func learnWindow(limit: Int?, failedEstimate: Int) {
        let learned = limit ?? max(4_096, Int(Double(failedEstimate) * 0.9))
        learnedWindow = min(learnedWindow ?? .max, learned)
        calibration = nil
    }

    func takeSummaryUsage() -> Usage {
        defer { summaryUsage = Usage() }
        return summaryUsage
    }
}
