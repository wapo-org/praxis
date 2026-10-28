import Foundation
import AgentCore
import AgentMCP

/// What a conversation froze at its first send. The system prompt and the
/// tool list are the prefix of every request, so they must never change
/// afterwards (append-only history, prompt caching, reasoning signatures).
/// The app persists this with the conversation and passes it to every run.
///
/// It keeps the inputs needed to rebuild the tools (MCP definitions as
/// listed at freeze time, which built-in tools were included) **and** the
/// exact specs offered, so rebuilt tools present byte-identical specs even
/// when a live input drifts: a server changes its tools or is removed,
/// skills come and go, `run_javascript`'s description quotes a memory cap
/// that depends on free memory, or an app update rewords a built-in tool.
public struct ConversationSetup: Codable, Sendable, Hashable {
    public static let currentVersion = 1

    public let version: Int
    public let createdAt: Date
    public let systemPrompt: String
    /// Skills in the frozen catalog, sorted. Later imports are announced
    /// with notes (`TurnNotes`).
    public let skillNames: [String]
    /// `load_skill` / `read_skill_file` are offered.
    public let includesSkills: Bool
    /// `run_javascript` is offered.
    public let includesJavaScript: Bool
    /// Sorted by id.
    public let mcpServers: [MCPServerSnapshot]
    /// Above this many MCP tools the gateway trio replaces direct tools.
    public let gatewayThreshold: Int
    /// The tools offered to the model, in request order.
    public let toolSpecs: [ToolSpec]

    init(createdAt: Date, systemPrompt: String, skillNames: [String], includesSkills: Bool, includesJavaScript: Bool,
         mcpServers: [MCPServerSnapshot], gatewayThreshold: Int, toolSpecs: [ToolSpec]) {
        self.version = Self.currentVersion
        self.createdAt = createdAt
        self.systemPrompt = systemPrompt
        self.skillNames = skillNames
        self.includesSkills = includesSkills
        self.includesJavaScript = includesJavaScript
        self.mcpServers = mcpServers
        self.gatewayThreshold = gatewayThreshold
        self.toolSpecs = toolSpecs
    }

    /// The conversation froze `look_at_image`: its images reach a chat
    /// model without image input as placeholders it can ask about.
    public var offersImageReader: Bool { toolSpecs.contains { $0.name == ImageReference.lookToolName } }

    func withToolSpecs(_ specs: [ToolSpec]) -> ConversationSetup {
        ConversationSetup(createdAt: createdAt, systemPrompt: systemPrompt, skillNames: skillNames, includesSkills: includesSkills,
                          includesJavaScript: includesJavaScript, mcpServers: mcpServers, gatewayThreshold: gatewayThreshold,
                          toolSpecs: specs)
    }

    /// Refuses setups written by a newer build: rebuilding them with older
    /// rules could silently change the frozen prefix.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        guard version <= Self.currentVersion else {
            throw DecodingError.dataCorruptedError(forKey: .version, in: c,
                                                   debugDescription: "Conversation setup version \(version) is newer than this build supports.")
        }
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        systemPrompt = try c.decode(String.self, forKey: .systemPrompt)
        skillNames = try c.decode([String].self, forKey: .skillNames)
        includesSkills = try c.decode(Bool.self, forKey: .includesSkills)
        includesJavaScript = try c.decode(Bool.self, forKey: .includesJavaScript)
        mcpServers = try c.decode([MCPServerSnapshot].self, forKey: .mcpServers)
        gatewayThreshold = try c.decode(Int.self, forKey: .gatewayThreshold)
        toolSpecs = try c.decode([ToolSpec].self, forKey: .toolSpecs)
    }
}

/// One MCP server as it was when the conversation froze. The name is kept
/// because tool names and descriptions are derived from it; renaming the
/// server later doesn't touch this conversation.
public struct MCPServerSnapshot: Codable, Sendable, Hashable {
    public let id: String
    public let name: String
    public let tools: [MCPToolDefinition]
    /// The server offered `resources` at freeze time, so the conversation
    /// has `mcp_list_resources` / `mcp_read_resource` for it. Nil (absent
    /// in older setups) = no.
    public let offersResources: Bool?

    init(id: String, name: String, tools: [MCPToolDefinition], offersResources: Bool? = nil) {
        self.id = id
        self.name = name
        self.tools = tools
        self.offersResources = offersResources
    }
}
