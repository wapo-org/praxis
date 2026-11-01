import Foundation

/// The frozen, name-sorted tool list for one conversation. Built once at
/// the conversation's first send and reused for every request so the
/// provider sees an identical prefix (prompt caching, append-only history).
public struct ToolRegistry: Sendable {
    public let tools: [any AgentTool]
    private let byName: [String: Int]
    /// Callable from code (`ToolContext.callTool`) but not offered to the
    /// model — e.g. MCP tools behind the gateway, reached as `tools.*` in JS.
    private let hidden: [String: any AgentTool]

    public init(_ tools: [any AgentTool], hidden hiddenTools: [any AgentTool] = []) {
        var seen = Set<String>()
        var unique: [any AgentTool] = []
        for t in tools.sorted(by: { $0.spec.name < $1.spec.name }) where seen.insert(t.spec.name).inserted {
            unique.append(t)
        }
        self.tools = unique
        self.byName = Dictionary(uniqueKeysWithValues: unique.enumerated().map { ($1.spec.name, $0) })
        var hidden: [String: any AgentTool] = [:]
        for t in hiddenTools where !seen.contains(t.spec.name) && hidden[t.spec.name] == nil { hidden[t.spec.name] = t }
        self.hidden = hidden
    }

    public static let empty = ToolRegistry([])

    public func tool(named name: String) -> (any AgentTool)? {
        byName[name].map { tools[$0] }
    }

    /// Lookup for calls made from inside a tool: offered or hidden tools.
    public func nestedTool(named name: String) -> (any AgentTool)? {
        tool(named: name) ?? hidden[name]
    }

    public var specs: [ToolSpec] { tools.map(\.spec) }
    public var isEmpty: Bool { tools.isEmpty }
}

/// Caps what goes back to the model. Oversized output keeps head + tail
/// and a note; the full text is kept in `OutputSpill` so the model can page
/// through it with `read_tool_output`.
public struct ResultLimiter: Sendable {
    public var maxCharacters: Int
    public init(maxCharacters: Int = 60_000) { self.maxCharacters = maxCharacters }

    public func limit(_ output: ToolOutput, callID: String, spill: OutputSpill?) async -> ToolOutput {
        var total = 0
        for c in output.content { total += c.text?.count ?? 0 }
        guard total > maxCharacters else { return output }
        let full = output.text
        await spill?.store(id: callID, text: full)
        let head = full.prefix(maxCharacters * 2 / 3)
        let tail = full.suffix(maxCharacters / 3)
        let omitted = full.count - head.count - tail.count
        let note = spill == nil
            ? "\n\n…[\(omitted) characters truncated]…\n\n"
            : "\n\n…[\(omitted) characters truncated — call read_tool_output with id \"\(callID)\" and an offset to read more]…\n\n"
        var limited = output
        limited.content = [.text(head + note + tail)] + output.content.filter { if case .image = $0 { return true }; return false }
        return limited
    }
}

/// Full text of truncated tool results for one conversation.
///
/// In memory by default. Backed by a `ScratchStore`, each text is a file
/// in the conversation's scratch directory, so `read_tool_output` keeps
/// working after a relaunch (until the store's size cap evicts it or the
/// conversation is deleted). If a write fails, the text stays in memory.
public actor OutputSpill {
    private var texts: [String: String] = [:]
    /// The text read most recently from disk (paging reads it repeatedly).
    private var recent: (id: String, text: String)?
    private let storage: (store: ScratchStore, conversationID: String)?

    public init() { storage = nil }

    public init(store: ScratchStore, conversationID: String) {
        storage = (store, conversationID)
    }

    public func store(id: String, text: String) {
        guard let storage else { texts[id] = text; return }
        var text = text
        if text.utf8.count > storage.store.maxFileBytes {
            text = String(decoding: text.utf8.prefix(storage.store.maxFileBytes), as: UTF8.self)
        }
        do {
            try storage.store.write(Data(text.utf8), conversationID: storage.conversationID, name: Self.fileName(id))
            texts[id] = nil
            recent = (id, text)
        } catch {
            texts[id] = text
        }
    }

    public func read(id: String, offset: Int, limit: Int) -> String? {
        guard let s = text(id) else { return nil }
        let start = s.index(s.startIndex, offsetBy: min(max(0, offset), s.count))
        let end = s.index(start, offsetBy: min(max(1, limit), s.distance(from: start, to: s.endIndex)))
        return String(s[start..<end])
    }

    public func length(id: String) -> Int? { text(id)?.count }

    private func text(_ id: String) -> String? {
        if let text = texts[id] { return text }
        if let recent, recent.id == id { return recent.text }
        guard let storage, let data = storage.store.read(conversationID: storage.conversationID, name: Self.fileName(id)) else {
            return nil
        }
        let text = String(decoding: data, as: UTF8.self)
        recent = (id, text)
        return text
    }

    /// Tool call ids are provider-made strings: hash them into file names.
    static func fileName(_ id: String) -> String {
        "spill-" + String(ToolName.stableHash(id), radix: 36) + ".txt"
    }
}

/// Lets the model page through a truncated result.
public struct ReadToolOutputTool: AgentTool {
    let spill: OutputSpill
    public init(spill: OutputSpill) { self.spill = spill }

    public var spec: ToolSpec {
        ToolSpec(
            name: "read_tool_output",
            description: "Read more of a tool result that was truncated. Pass the id from the truncation note and a character offset.",
            inputSchema: [
                "type": "object",
                "properties": [
                    "id": ["type": "string", "description": "Tool call id from the truncation note"],
                    "offset": ["type": "integer", "description": "Character offset to start at"],
                    "limit": ["type": "integer", "description": "Characters to read (default 20000)"],
                ],
                "required": ["id", "offset"],
            ])
    }
    public var traits: ToolTraits { [.readOnly, .idempotent] }
    public var source: ToolSource { .builtin }

    public func presentation(for arguments: JSONValue) -> ToolPresentation {
        ToolPresentation(category: .readFile, runningTitle: "Reading more output…", finishedTitle: "Read more output")
    }

    public func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        guard let id = invocation.arguments["id"]?.stringValue else { return .error("Missing id") }
        let offset = invocation.arguments["offset"]?.intValue ?? 0
        let limit = min(invocation.arguments["limit"]?.intValue ?? 20_000, 40_000)
        guard let total = await spill.length(id: id), let text = await spill.read(id: id, offset: offset, limit: limit) else {
            return .error("No stored output with id \(id). Stored output is kept per conversation and the oldest is cleared when space runs low.")
        }
        let end = min(total, offset + text.count)
        return .text("[characters \(offset)–\(end) of \(total)]\n" + text)
    }
}
