import Foundation

/// Chat modes. The tool list never changes with the mode (that would break
/// prompt caches and append-only history); the mode decides what may run.
public enum AgentMode: String, Sendable, Codable, Hashable, CaseIterable {
    case auto, ask, plan, build
}

public struct ToolTraits: OptionSet, Sendable, Codable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    /// No side effects outside the app.
    public static let readOnly = ToolTraits(rawValue: 1 << 0)
    /// May delete or overwrite remote state.
    public static let destructive = ToolTraits(rawValue: 1 << 1)
    /// Safe to repeat with the same input.
    public static let idempotent = ToolTraits(rawValue: 1 << 2)
    /// Talks to arbitrary external systems.
    public static let openWorld = ToolTraits(rawValue: 1 << 3)
    /// Runs in an app-owned sandbox (JS runner): auto-allowed in every
    /// mode that permits execution.
    public static let sandboxed = ToolTraits(rawValue: 1 << 4)
}

public enum ToolSource: Sendable, Codable, Hashable {
    /// App-provided helper (e.g. `read_tool_output`).
    case builtin
    case skill
    case javascript
    case mcp(serverID: String, serverName: String)
    /// Provider-hosted tool (web search) — never executed locally.
    case server

    /// Stable key for trust / always-allow bookkeeping.
    public var key: String {
        switch self {
        case .builtin: return "builtin"
        case .skill: return "skill"
        case .javascript: return "js"
        case .mcp(let id, _): return "mcp:\(id)"
        case .server: return "server"
        }
    }
}

/// UI hint so the app can pick an icon/row style without knowing tools.
public enum ToolCategory: String, Sendable, Codable, Hashable {
    case integration, command, webSearch, webFetch, readFile, edit, skill, other
}

public struct ToolPresentation: Sendable, Codable, Hashable {
    public var category: ToolCategory
    /// Present-tense label while running, e.g. "Searching issues…".
    public var runningTitle: String
    /// Past-tense label once done, e.g. "Searched issues".
    public var finishedTitle: String
    public init(category: ToolCategory, runningTitle: String, finishedTitle: String) {
        self.category = category
        self.runningTitle = runningTitle
        self.finishedTitle = finishedTitle
    }
}

public struct ToolInvocation: Sendable {
    public var id: String
    public var name: String
    public var arguments: JSONValue
    public init(id: String, name: String, arguments: JSONValue) {
        self.id = id
        self.name = name
        self.arguments = arguments
    }
}

public enum TraceKind: String, Sendable, Codable, Hashable { case skill, api, image, network, note }

/// Live progress a tool reports while it runs.
public enum ToolProgress: Sendable, Hashable {
    /// Console / command output lines.
    case output([String])
    case trace(TraceKind, String)
    case status(String)
}

/// Read-only files the user attached to the conversation, exposed to tools
/// (JS `fs`, skills).
public protocol VirtualFileSystem: Sendable {
    func list() async -> [String]
    func read(_ path: String, maxBytes: Int) async throws -> Data
}

public struct ToolContext: Sendable {
    public var conversationID: String
    public var mode: AgentMode
    public var emit: @Sendable (ToolProgress) -> Void
    public var files: (any VirtualFileSystem)?
    /// Calls another tool through the same policy/approval path as a
    /// model-issued call (used by JS code mode). Nil when unavailable.
    public var callTool: (@Sendable (_ name: String, _ arguments: JSONValue) async throws -> ToolOutput)?

    public init(conversationID: String, mode: AgentMode, emit: @escaping @Sendable (ToolProgress) -> Void = { _ in },
                files: (any VirtualFileSystem)? = nil,
                callTool: (@Sendable (String, JSONValue) async throws -> ToolOutput)? = nil) {
        self.conversationID = conversationID
        self.mode = mode
        self.emit = emit
        self.files = files
        self.callTool = callTool
    }
}

public struct ToolOutput: Sendable, Hashable {
    public var content: [ToolResultContent]
    public var isError: Bool
    /// Final one-line summary for the UI (overrides `finishedTitle`).
    public var summary: String?

    public init(content: [ToolResultContent], isError: Bool = false, summary: String? = nil) {
        self.content = content
        self.isError = isError
        self.summary = summary
    }

    public static func text(_ s: String, summary: String? = nil) -> ToolOutput {
        ToolOutput(content: [.text(s)], summary: summary)
    }

    public static func error(_ s: String) -> ToolOutput {
        ToolOutput(content: [.text(s)], isError: true)
    }

    public var text: String { content.compactMap(\.text).joined(separator: "\n") }
}

/// What the policy authorizes for one call. Usually the tool itself; a
/// dispatching tool (MCP gateway `mcp_call_tool`) reports the tool it will
/// actually invoke, so approval and "always allow" follow the real target.
public struct ToolSubject: Sendable, Hashable {
    public var name: String
    public var source: ToolSource
    public var traits: ToolTraits
    /// Changes when the tool's contract changes (revokes "always allow").
    public var fingerprint: String

    public init(name: String, source: ToolSource, traits: ToolTraits, fingerprint: String) {
        self.name = name
        self.source = source
        self.traits = traits
        self.fingerprint = fingerprint
    }

    public init(spec: ToolSpec, source: ToolSource, traits: ToolTraits) {
        let hash = ToolName.stableHash(spec.description + spec.inputSchema.encodedString())
        self.init(name: spec.name, source: source, traits: traits, fingerprint: String(hash, radix: 36))
    }
}

/// A tool the model can call. Implementations must be safe to call
/// concurrently.
public protocol AgentTool: Sendable {
    var spec: ToolSpec { get }
    var traits: ToolTraits { get }
    var source: ToolSource { get }
    func presentation(for arguments: JSONValue) -> ToolPresentation
    /// Defaults to the tool itself. Return nil when the arguments don't
    /// name a valid target — the call is then refused.
    func subject(for arguments: JSONValue) -> ToolSubject?
    /// Told to the model when `subject(for:)` returns nil.
    func unavailableReason(for arguments: JSONValue) -> String
    func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput
}

public extension AgentTool {
    var name: String { spec.name }

    func subject(for arguments: JSONValue) -> ToolSubject? {
        ToolSubject(spec: spec, source: source, traits: traits)
    }

    func unavailableReason(for arguments: JSONValue) -> String {
        "That tool isn't available for these arguments."
    }

    func presentation(for arguments: JSONValue) -> ToolPresentation {
        let readable = spec.name.replacingOccurrences(of: "_", with: " ")
        let category: ToolCategory
        switch source {
        case .mcp: category = .integration
        case .javascript: category = .command
        case .skill: category = .skill
        case .server: category = .webSearch
        case .builtin: category = .other
        }
        return ToolPresentation(category: category, runningTitle: "Running \(readable)…", finishedTitle: "Ran \(readable)")
    }
}

public enum ToolName {
    /// Common subset accepted by every supported provider:
    /// `^[a-zA-Z0-9_-]{1,64}$`.
    public static func sanitize(_ raw: String, maxLength: Int = 64) -> String {
        var s = String(raw.unicodeScalars.map { scalar -> Character in
            let v = scalar.value
            let ok = (48...57).contains(v) || (65...90).contains(v) || (97...122).contains(v) || v == 95 || v == 45
            return ok ? Character(scalar) : "_"
        })
        if s.isEmpty { s = "tool" }
        if s.count > maxLength {
            // Keep it unique-ish: prefix + short stable hash of the full name.
            let hash = String(UInt32(truncatingIfNeeded: stableHash(raw)), radix: 36)
            s = String(s.prefix(maxLength - hash.count - 1)) + "_" + hash
        }
        return s
    }

    /// FNV-1a — stable across launches (unlike `Hasher`).
    public static func stableHash(_ s: String) -> UInt64 {
        var h: UInt64 = 0xcbf29ce484222325
        for b in s.utf8 { h ^= UInt64(b); h = h &* 0x100000001b3 }
        return h
    }
}
