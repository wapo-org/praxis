import Foundation
import AgentCore

/// `mcp_list_resources` and `mcp_read_resource`: the resources of the
/// conversation's connectors that offered the `resources` capability when
/// it froze its tools. One pair serves every such server (a `server`
/// argument picks it), so the tool list doesn't grow with servers.
///
/// Specs depend only on the frozen server ids and names. Calls go to the
/// live client; a removed or turned-off connector refuses like its tools.
/// Policy-wise a call is a read-only call to that server: approval and
/// trust follow the server, exactly like its read-only tools.
public struct MCPResourceTools: Sendable {
    public static let listName = "mcp_list_resources"
    public static let readName = "mcp_read_resource"

    public struct Server: Sendable {
        public enum Target: Sendable {
            case live(MCPClient)
            /// Why it can't be used (removed, turned off…).
            case unavailable(String)
        }

        public var id: String
        public var name: String
        public var target: Target

        public init(id: String, name: String, target: Target) {
            self.id = id
            self.name = name
            self.target = target
        }
    }

    /// Sorted by id; each with the key the model uses to name it.
    let servers: [(key: String, server: Server)]

    public init(servers: [Server]) {
        let sorted = servers.sorted { $0.id < $1.id }
        var used = Set<String>()
        var keyed: [(String, Server)] = []
        for server in sorted {
            var key = MCPToolNaming.slug(server.name)
            if used.contains(key) {
                key += "_" + String(UInt32(truncatingIfNeeded: ToolName.stableHash(server.id)), radix: 36)
            }
            used.insert(key)
            keyed.append((key, server))
        }
        self.servers = keyed
    }

    public var tools: [any AgentTool] {
        servers.isEmpty ? [] : [ListTool(owner: self), ReadTool(owner: self)]
    }

    /// By key, name or id (case-insensitive); the only server when omitted.
    func resolve(_ raw: String?) -> (key: String, server: Server)? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces).lowercased(), !raw.isEmpty else {
            return servers.count == 1 ? servers[0] : nil
        }
        return servers.first { $0.key == raw || $0.server.name.lowercased() == raw || $0.server.id.lowercased() == raw }
    }

    var serverProperty: JSONValue {
        ["type": "string", "enum": .array(servers.map { .string($0.key) }),
         "description": .string("Which connector: " + servers.map { "\($0.key) (\($0.server.name))" }.joined(separator: ", "))]
    }

    func subject(_ spec: ToolSpec, _ arguments: JSONValue) -> ToolSubject? {
        guard let found = resolve(arguments["server"]?.stringValue), case .live = found.server.target else { return nil }
        let base = ToolSubject(spec: spec, source: .builtin, traits: [])
        return ToolSubject(name: spec.name, source: .mcp(serverID: found.server.id, serverName: found.server.name),
                           traits: [.readOnly, .idempotent], fingerprint: base.fingerprint)
    }

    func unavailableReason(_ arguments: JSONValue) -> String {
        guard let found = resolve(arguments["server"]?.stringValue) else {
            let names = servers.map(\.key).joined(separator: ", ")
            return "Name the connector with “server” (one of: \(names))."
        }
        if case .unavailable(let reason) = found.server.target { return reason }
        return "That connector isn't available."
    }

    func client(_ arguments: JSONValue) -> (Server, MCPClient)? {
        guard let found = resolve(arguments["server"]?.stringValue), case .live(let client) = found.server.target else { return nil }
        return (found.server, client)
    }

    static func failure(_ error: Error, server: Server, context: ToolContext) -> ToolOutput {
        if case MCPError.authorizationRequired(let requirement) = error {
            return MCPSignInNotice.output(requirement, serverID: server.id, serverName: server.name, context: context)
        }
        if error is CancellationError { return .error("Cancelled.") }
        return .error((error as? LocalizedError)?.errorDescription ?? "\(error)")
    }

    // MARK: Tools

    struct ListTool: AgentTool {
        let owner: MCPResourceTools

        var spec: ToolSpec {
            var properties: [String: JSONValue] = [
                "cursor": ["type": "string", "description": "nextCursor from a previous call, for the next page"],
            ]
            properties["server"] = owner.serverProperty
            let names = owner.servers.map(\.server.name).joined(separator: ", ")
            return ToolSpec(
                name: MCPResourceTools.listName,
                description: "List the resources (documents, files, records) the user's connectors share: \(names). "
                    + "Returns URIs to pass to \(MCPResourceTools.readName), and URI templates you can fill in.",
                inputSchema: [
                    "type": "object",
                    "properties": .object(properties),
                    "required": owner.servers.count > 1 ? ["server"] : [],
                ])
        }
        var traits: ToolTraits { [.readOnly, .idempotent] }
        var source: ToolSource { .mcp(serverID: "resources", serverName: "MCP connectors") }

        func subject(for arguments: JSONValue) -> ToolSubject? { owner.subject(spec, arguments) }
        func unavailableReason(for arguments: JSONValue) -> String { owner.unavailableReason(arguments) }

        func presentation(for arguments: JSONValue) -> ToolPresentation {
            let name = owner.resolve(arguments["server"]?.stringValue)?.server.name
            return ToolPresentation(category: .integration,
                                    runningTitle: name.map { "\($0): Listing resources…" } ?? "Listing connector resources…",
                                    finishedTitle: name.map { "\($0): Listed resources" } ?? "Listed connector resources")
        }

        func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
            guard let (server, client) = owner.client(invocation.arguments) else { return .error(owner.unavailableReason(invocation.arguments)) }
            let cursor = invocation.arguments["cursor"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
            let page: MCPResourcePage
            do {
                page = try await client.listResources(cursor: cursor)
            } catch {
                return MCPResourceTools.failure(error, server: server, context: context)
            }
            var lines: [String] = []
            for r in page.resources {
                var meta = [r.mimeType, r.size.map { "\($0) bytes" }].compactMap { $0 }.joined(separator: ", ")
                if !meta.isEmpty { meta = " (\(meta))" }
                lines.append("- \(r.title ?? r.name) — \(r.uri)\(meta)")
                if let d = r.description?.split(separator: "\n").first, !d.isEmpty { lines.append("  \(d.prefix(200))") }
            }
            if !page.templates.isEmpty {
                lines.append("")
                lines.append("URI templates (replace the {placeholders} to build a URI for \(MCPResourceTools.readName)):")
                for t in page.templates {
                    let about = (t.description?.split(separator: "\n").first).map { ": \($0.prefix(200))" } ?? ""
                    lines.append("- \(t.uriTemplate) — \(t.title ?? t.name)\(about)")
                }
            }
            if let next = page.nextCursor {
                lines.append("")
                lines.append("More resources: call again with cursor \"\(next)\".")
            }
            if page.resources.isEmpty && page.templates.isEmpty {
                return .text("\(server.name) lists no resources\(cursor == nil ? "" : " on this page").",
                             summary: "\(server.name): no resources")
            }
            let count = page.resources.count
            return .text(lines.joined(separator: "\n"),
                         summary: "\(server.name): \(count) resource\(count == 1 ? "" : "s")")
        }
    }

    struct ReadTool: AgentTool {
        let owner: MCPResourceTools

        var spec: ToolSpec {
            var properties: [String: JSONValue] = [
                "uri": ["type": "string", "description": .string("Resource URI from \(MCPResourceTools.listName) (or a filled-in template)")],
            ]
            properties["server"] = owner.serverProperty
            return ToolSpec(
                name: MCPResourceTools.readName,
                description: "Read a resource from one of the user's connectors by URI. Text comes back as text, images as images.",
                inputSchema: [
                    "type": "object",
                    "properties": .object(properties),
                    "required": owner.servers.count > 1 ? ["server", "uri"] : ["uri"],
                ])
        }
        var traits: ToolTraits { [.readOnly, .idempotent] }
        var source: ToolSource { .mcp(serverID: "resources", serverName: "MCP connectors") }

        func subject(for arguments: JSONValue) -> ToolSubject? { owner.subject(spec, arguments) }
        func unavailableReason(for arguments: JSONValue) -> String { owner.unavailableReason(arguments) }

        func presentation(for arguments: JSONValue) -> ToolPresentation {
            let name = owner.resolve(arguments["server"]?.stringValue)?.server.name ?? "Connector"
            let uri = arguments["uri"]?.stringValue ?? ""
            let short = uri.split(separator: "/").last.map(String.init) ?? uri
            let label = short.isEmpty ? "resource" : String(short.prefix(48))
            return ToolPresentation(category: .integration, runningTitle: "\(name): Reading \(label)…", finishedTitle: "\(name): Read \(label)")
        }

        func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
            guard let (server, client) = owner.client(invocation.arguments) else { return .error(owner.unavailableReason(invocation.arguments)) }
            guard let uri = invocation.arguments["uri"]?.stringValue?.trimmingCharacters(in: .whitespaces), !uri.isEmpty else {
                return .error("Pass the resource “uri” (see \(MCPResourceTools.listName)).")
            }
            context.emit(.trace(.api, "resources/read \(uri.prefix(160))"))
            let contents: [MCPResourceContents]
            do {
                contents = try await client.readResource(uri)
            } catch {
                return MCPResourceTools.failure(error, server: server, context: context)
            }
            var blocks = contents.flatMap { $0.toolContent() }
            if blocks.isEmpty { blocks = [.text("(empty resource)")] }
            return ToolOutput(content: blocks, summary: presentation(for: invocation.arguments).finishedTitle)
        }
    }
}
