import Foundation
import AgentCore

/// Gateway mode: three fixed tools stand in for many MCP tools so the
/// provider sees a small, stable tool list. Search and describe are local
/// lookups in the frozen catalog; `mcp_call_tool` reports the real target
/// to the policy via `subject(for:)`, so approval and "always allow"
/// behave exactly as if the target had been called directly.
public struct MCPGateway: Sendable {
    public static let searchName = "mcp_search_tools"
    public static let describeName = "mcp_describe_tool"
    public static let callName = "mcp_call_tool"

    let catalog: [MCPTool]
    private let byName: [String: Int]

    public init(catalog: [MCPTool]) {
        self.catalog = catalog
        self.byName = Dictionary(catalog.enumerated().map { ($1.spec.name, $0) }, uniquingKeysWith: { a, _ in a })
    }

    public var tools: [any AgentTool] {
        [SearchTool(gateway: self), DescribeTool(gateway: self), CallTool(gateway: self)]
    }

    /// Exact qualified name, else an unambiguous original MCP tool name.
    func resolve(_ raw: String?) -> MCPTool? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        if let i = byName[raw] { return catalog[i] }
        let matches = catalog.filter { $0.definition.name == raw }
        return matches.count == 1 ? matches[0] : nil
    }

    func search(_ query: String, server: String?, limit: Int = 12) -> [MCPTool] {
        let terms = query.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
        let pool = catalog.filter { tool in
            guard let server = server?.lowercased(), !server.isEmpty else { return true }
            return tool.serverName.lowercased() == server || tool.source.key == "mcp:\(server)" || tool.serverSlug == server
                || tool.client.config.id.lowercased() == server
        }
        guard !terms.isEmpty else { return Array(pool.prefix(limit)) }
        let scored: [(MCPTool, Int)] = pool.compactMap { tool in
            let name = (tool.definition.name + " " + tool.definition.displayTitle).lowercased()
            let text = (tool.definition.description + " " + tool.serverName).lowercased()
            var score = 0
            for term in terms {
                if name.contains(term) { score += 3 } else if text.contains(term) { score += 1 }
            }
            return score > 0 ? (tool, score) : nil
        }
        return scored.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0.spec.name < $1.0.spec.name }.prefix(limit).map(\.0)
    }

    // MARK: Tools

    struct SearchTool: AgentTool {
        let gateway: MCPGateway
        var spec: ToolSpec {
            let servers = Array(Set(gateway.catalog.map(\.serverName))).sorted()
            return ToolSpec(
                name: MCPGateway.searchName,
                description: "Find tools on the user's connected MCP servers (\(servers.joined(separator: ", "))). "
                    + "Returns tool names to pass to \(MCPGateway.describeName) and \(MCPGateway.callName).",
                inputSchema: [
                    "type": "object",
                    "properties": [
                        "query": ["type": "string", "description": "Keywords describing what you want to do"],
                        "server": ["type": "string", "description": "Optional server name to search in"],
                    ],
                    "required": ["query"],
                ])
        }
        var traits: ToolTraits { [.readOnly, .idempotent] }
        // Local lookup in the frozen catalog — no network, nothing to approve.
        var source: ToolSource { .builtin }

        func presentation(for arguments: JSONValue) -> ToolPresentation {
            ToolPresentation(category: .integration, runningTitle: "Searching connector tools…", finishedTitle: "Searched connector tools")
        }

        func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
            let query = invocation.arguments["query"]?.stringValue ?? ""
            let hits = gateway.search(query, server: invocation.arguments["server"]?.stringValue)
            guard !hits.isEmpty else { return .text("No matching tools. Try other keywords or omit the server filter.") }
            let lines = hits.map { tool -> String in
                var flags: [String] = []
                if tool.traits.contains(.readOnly) { flags.append("read-only") }
                if tool.traits.contains(.destructive) { flags.append("may modify data") }
                let about = tool.definition.description.split(separator: "\n").first.map { String($0.prefix(160)) } ?? ""
                return "- \(tool.spec.name) — \(tool.serverName): \(tool.definition.displayTitle)"
                    + (flags.isEmpty ? "" : " [\(flags.joined(separator: ", "))]")
                    + (about.isEmpty ? "" : "\n  \(about)")
            }
            return .text(lines.joined(separator: "\n"), summary: "Found \(hits.count) tool\(hits.count == 1 ? "" : "s")")
        }
    }

    struct DescribeTool: AgentTool {
        let gateway: MCPGateway
        var spec: ToolSpec {
            ToolSpec(
                name: MCPGateway.describeName,
                description: "Show the full description and JSON input schema of an MCP tool found with \(MCPGateway.searchName).",
                inputSchema: [
                    "type": "object",
                    "properties": ["tool": ["type": "string", "description": .string("Tool name from \(MCPGateway.searchName)")]],
                    "required": ["tool"],
                ])
        }
        var traits: ToolTraits { [.readOnly, .idempotent] }
        var source: ToolSource { .builtin }

        func presentation(for arguments: JSONValue) -> ToolPresentation {
            let target = gateway.resolve(arguments["tool"]?.stringValue)?.definition.displayTitle ?? "tool"
            return ToolPresentation(category: .integration, runningTitle: "Reading \(target)…", finishedTitle: "Read \(target)")
        }

        func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
            let raw = invocation.arguments["tool"]?.stringValue ?? ""
            guard let tool = gateway.resolve(raw) else {
                return .error("Unknown tool “\(raw)”. Use \(MCPGateway.searchName) to find tool names.")
            }
            return .text("""
            \(tool.spec.name) (\(tool.serverName): \(tool.definition.displayTitle))
            \(tool.spec.description)

            Input schema:
            \(tool.spec.inputSchema.encodedString(pretty: true))
            """)
        }
    }

    struct CallTool: AgentTool {
        let gateway: MCPGateway
        var spec: ToolSpec {
            ToolSpec(
                name: MCPGateway.callName,
                description: "Call an MCP tool by name with arguments matching its input schema (see \(MCPGateway.describeName)).",
                inputSchema: [
                    "type": "object",
                    "properties": [
                        "tool": ["type": "string", "description": .string("Tool name from \(MCPGateway.searchName)")],
                        "arguments": ["type": "object", "description": "Arguments for the tool"],
                    ],
                    "required": ["tool", "arguments"],
                ])
        }
        // Only used if something asks about the gateway itself; the policy
        // decides on `subject(for:)`.
        var traits: ToolTraits { [.destructive, .openWorld] }
        var source: ToolSource { .mcp(serverID: "gateway", serverName: "MCP connectors") }

        func subject(for arguments: JSONValue) -> ToolSubject? {
            gateway.resolve(arguments["tool"]?.stringValue)?.subject
        }

        func unavailableReason(for arguments: JSONValue) -> String {
            "Unknown tool “\(arguments["tool"]?.stringValue ?? "")”. Use \(MCPGateway.searchName) to find tool names."
        }

        func presentation(for arguments: JSONValue) -> ToolPresentation {
            guard let tool = gateway.resolve(arguments["tool"]?.stringValue) else {
                return ToolPresentation(category: .integration, runningTitle: "Calling connector tool…", finishedTitle: "Called connector tool")
            }
            return tool.presentation(for: Self.arguments(arguments))
        }

        func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
            let raw = invocation.arguments["tool"]?.stringValue ?? ""
            guard let tool = gateway.resolve(raw) else {
                return .error("Unknown tool “\(raw)”. Use \(MCPGateway.searchName) to find tool names.")
            }
            let args = Self.arguments(invocation.arguments)
            guard case .object = args else { return .error("“arguments” must be a JSON object.") }
            return try await tool.execute(ToolInvocation(id: invocation.id, name: tool.spec.name, arguments: args), context: context)
        }

        /// Some models send `arguments` as a JSON string.
        static func arguments(_ outer: JSONValue) -> JSONValue {
            switch outer["arguments"] {
            case .string(let s)?: return (try? JSONValue(parsing: s)) ?? .string(s)
            case nil, .null?: return .object([:])
            case let value?: return value
            }
        }
    }
}
