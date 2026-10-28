import Foundation
import AgentCore

/// One MCP server tool exposed to the model as `mcp__<server>__<tool>`.
///
/// Traits come from the server's annotations; `ToolPolicy` ignores them
/// (treats the tool as destructive) unless the user trusts the server.
public struct MCPTool: AgentTool {
    public let spec: ToolSpec
    public let traits: ToolTraits
    public let source: ToolSource
    public let definition: MCPToolDefinition
    public let serverName: String
    let client: MCPClient
    let serverSlug: String

    init(client: MCPClient, definition: MCPToolDefinition, name: String, serverSlug: String) {
        let config = client.config
        self.client = client
        self.definition = definition
        self.serverName = config.name
        self.serverSlug = serverSlug
        self.source = config.source
        self.traits = definition.annotations.traits
        let about = definition.description.isEmpty ? definition.displayTitle : definition.description
        self.spec = ToolSpec(name: name, description: "\(config.name): \(about)",
                             inputSchema: Self.modelSchema(definition.inputSchema))
    }

    public var subject: ToolSubject { ToolSubject(spec: spec, source: source, traits: traits) }

    public func presentation(for arguments: JSONValue) -> ToolPresentation {
        let title = definition.displayTitle
        return ToolPresentation(category: .integration, runningTitle: "\(serverName): \(title)…", finishedTitle: "\(serverName): \(title)")
    }

    public func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        context.emit(.trace(.api, "\(serverSlug).\(definition.name)(\(invocation.arguments.encodedString().prefix(160)))"))
        let emit = context.emit
        do {
            let result = try await client.callTool(definition.name, arguments: invocation.arguments) { progress in
                emit(.status(progress.label))
            }
            return result.toolOutput()
        } catch MCPError.authorizationRequired(let requirement) {
            return MCPSignInNotice.output(requirement, serverID: client.config.id, serverName: serverName, context: context)
        } catch let error as MCPError {
            // Reported to the model as a failed call it can reason about.
            return .error(error.errorDescription ?? "The MCP call failed.")
        }
    }

    /// Providers reject or ignore `$schema`/`title` at the root; tools must
    /// still be objects with `properties`.
    static func modelSchema(_ schema: JSONValue) -> JSONValue {
        guard var o = schema.objectValue else { return ["type": "object", "properties": [:]] }
        o.removeValue(forKey: "$schema")
        o.removeValue(forKey: "title")
        if o["type"] == nil { o["type"] = "object" }
        if o["type"] == "object", o["properties"] == nil { o["properties"] = .object([:]) }
        return .object(o)
    }
}

// MARK: - Sign-in notice

/// A call refused for missing credentials: a tool error the model can
/// act on (ask the user to tap the button — never to paste secrets), plus
/// a marker trace the app turns into a "Sign in to <server>" action on
/// the step that failed (also for gateway and code-mode calls, whose
/// steps don't name the server).
public enum MCPSignInNotice {
    static let prefix = "mcp-sign-in-needed|"

    /// Trace text for the step. The app parses it with `parse(_:)`.
    public static func trace(serverID: String, serverName: String) -> String {
        prefix + serverID + "|" + serverName
    }

    public static func parse(_ text: String) -> (serverID: String, serverName: String)? {
        guard text.hasPrefix(prefix) else { return nil }
        let rest = text.dropFirst(prefix.count)
        guard let bar = rest.firstIndex(of: "|") else { return nil }
        let id = String(rest[..<bar])
        let name = String(rest[rest.index(after: bar)...])
        return id.isEmpty ? nil : (id, name.isEmpty ? id : name)
    }

    static func output(_ requirement: MCPAuthRequirement, serverID: String, serverName: String, context: ToolContext) -> ToolOutput {
        context.emit(.trace(.note, trace(serverID: serverID, serverName: serverName)))
        return ToolOutput(content: [.text(message(requirement, serverName: serverName))], isError: true,
                          summary: "\(serverName) needs sign-in")
    }

    static func message(_ requirement: MCPAuthRequirement, serverName: String) -> String {
        let button = "The app shows a “Sign in to \(serverName)” button on this step; ask the user to tap it, then try again."
        let never = "Don't ask the user to paste passwords, tokens or client secrets into the chat."
        switch requirement {
        case .oauthAutomatic:
            return "\(serverName) needs the user to sign in before this tool can run. \(button) \(never)"
        case .oauthNeedsClientCredentials(let issuer):
            return "\(serverName) needs the user to sign in before this tool can run. Signing in needs a one-time setup "
                + "(an OAuth client ID the user creates with \(MCPAuthRequirement.host(issuer))); the app walks them through it. "
                + "\(button) \(never)"
        case .tokenHeader:
            return "\(serverName) needs an access token or API key before this tool can run. \(button) It opens the connector "
                + "settings where the user adds it. \(never)"
        case .unsupported, .none:
            return requirement.message
        }
    }
}

// MARK: - Naming

enum MCPToolNaming {
    /// Short identifier for the server in tool names: "Linear (work)" → "linear_work".
    static func slug(_ serverName: String) -> String {
        let lowered = serverName.lowercased().unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII ? Character(scalar) : "_"
        }
        var s = String(lowered)
        while s.contains("__") { s = s.replacingOccurrences(of: "__", with: "_") }
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: "_"))
        if s.isEmpty { s = "server" }
        return String(s.prefix(20))
    }

    /// Assigns unique provider-safe names. Input order decides who keeps the
    /// plain name on a collision; the others get a stable hash suffix of
    /// their (server id, tool) identity.
    static func assign(_ items: [(serverID: String, slug: String, tool: String)]) -> [String] {
        var used = Set<String>()
        var out: [String] = []
        for item in items {
            var name = ToolName.sanitize("mcp__\(item.slug)__\(item.tool)")
            if used.contains(name) {
                let hash = String(UInt32(truncatingIfNeeded: ToolName.stableHash("\(item.serverID)/\(item.tool)")), radix: 36)
                name = String(name.prefix(64 - hash.count - 1)) + "_" + hash
                var n = 2
                while used.contains(name) { name = String(name.prefix(60)) + "_\(n)"; n += 1 }
            }
            used.insert(name)
            out.append(name)
        }
        return out
    }
}

// MARK: - Toolset

/// The MCP tools for one conversation: direct tools, or — above
/// `threshold` tools — the gateway trio. Build once at the conversation's
/// first send and freeze (the tool list must not change mid-conversation).
public struct MCPToolset: Sendable {
    public struct Failure: Sendable, Hashable {
        public var serverID: String
        public var serverName: String
        public var message: String
        /// Set when the server needs credentials (show "Sign in" / "Add token").
        public var authRequirement: MCPAuthRequirement?

        public init(serverID: String, serverName: String, message: String, authRequirement: MCPAuthRequirement? = nil) {
            self.serverID = serverID
            self.serverName = serverName
            self.message = message
            self.authRequirement = authRequirement
        }
    }

    /// What goes into the `ToolRegistry`.
    public let tools: [any AgentTool]
    /// Every MCP tool, also in gateway mode (JS code-mode stubs; in gateway
    /// mode code calls them through `mcp_call_tool`).
    public let catalog: [MCPTool]
    public let isGateway: Bool
    /// Servers whose tools couldn't be listed.
    public let failures: [Failure]
    /// What each listed server supports (from `build`), keyed by server id.
    public let features: [String: MCPServerFeatures]

    /// Specs of every MCP tool, for JS code mode.
    public var specs: [ToolSpec] { catalog.map(\.spec) }

    /// `ToolRegistry(_:hidden:)` entries: in gateway mode the direct tools
    /// aren't offered to the model, but JS code mode still calls them by name.
    public var hiddenTools: [any AgentTool] { isGateway ? catalog : [] }

    /// From already-listed tools (e.g. a frozen conversation snapshot).
    public init(listings: [(client: MCPClient, tools: [MCPToolDefinition])], threshold: Int = 30, failures: [Failure] = [],
                features: [String: MCPServerFeatures] = [:]) {
        let ordered = listings.sorted { $0.client.config.id < $1.client.config.id }
        var items: [(serverID: String, slug: String, tool: String)] = []
        var pending: [(MCPClient, MCPToolDefinition, String)] = []
        for (client, tools) in ordered {
            let slug = MCPToolNaming.slug(client.config.name)
            for tool in tools.sorted(by: { $0.name < $1.name }) {
                items.append((client.config.id, slug, tool.name))
                pending.append((client, tool, slug))
            }
        }
        let names = MCPToolNaming.assign(items)
        let catalog = zip(pending, names).map { p, name in MCPTool(client: p.0, definition: p.1, name: name, serverSlug: p.2) }
        self.catalog = catalog
        self.failures = failures
        self.features = features
        self.isGateway = catalog.count > threshold
        self.tools = isGateway ? MCPGateway(catalog: catalog).tools : catalog
    }

    /// Lists every enabled server's tools concurrently. A failing server
    /// is reported in `failures`; the others still contribute.
    public static func build(servers: [MCPClient], threshold: Int = 30) async -> MCPToolset {
        let enabled = servers.filter { $0.config.enabled }
        let results = await withTaskGroup(of: (Int, Result<[MCPToolDefinition], Error>).self) { group in
            for (i, client) in enabled.enumerated() {
                group.addTask {
                    do { return (i, .success(try await client.listTools())) } catch { return (i, .failure(error)) }
                }
            }
            var out: [(Int, Result<[MCPToolDefinition], Error>)] = []
            for await r in group { out.append(r) }
            return out.sorted { $0.0 < $1.0 }
        }
        var listings: [(client: MCPClient, tools: [MCPToolDefinition])] = []
        var failures: [Failure] = []
        var features: [String: MCPServerFeatures] = [:]
        for (i, result) in results {
            let client = enabled[i]
            switch result {
            case .success(let tools):
                listings.append((client, tools))
                features[client.config.id] = await client.features
            case .failure(let error):
                var requirement: MCPAuthRequirement?
                if case MCPError.authorizationRequired(let r) = error { requirement = r }
                failures.append(Failure(serverID: client.config.id, serverName: client.config.name,
                                        message: (error as? LocalizedError)?.errorDescription ?? "\(error)",
                                        authRequirement: requirement))
            }
        }
        return MCPToolset(listings: listings, threshold: threshold, failures: failures, features: features)
    }

    /// `ToolPolicy.trustedSources` entries for the servers the user trusts.
    public static func trustedSources(_ servers: [MCPServerConfig]) -> Set<String> {
        Set(servers.filter(\.trusted).map(\.trustKey))
    }
}
