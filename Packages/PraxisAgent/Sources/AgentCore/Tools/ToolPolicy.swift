import Foundation

public enum ToolDecision: Sendable, Equatable {
    case allow
    case ask(reason: String)
    case refuse(reason: String)
}

public enum ApprovalDecision: Sendable, Equatable {
    case allowOnce
    case allowAlways
    case deny
}

public struct ApprovalRequest: Sendable, Hashable, Identifiable {
    /// The tool call id.
    public var id: String
    public var toolName: String
    public var source: ToolSource
    public var arguments: JSONValue
    public var reason: String
    public var title: String
    /// Set for calls made from inside another tool (JS code mode): the
    /// model-issued call whose step shows the approval.
    public var parentCallID: String?
    public init(id: String, toolName: String, source: ToolSource, arguments: JSONValue, reason: String, title: String,
                parentCallID: String? = nil) {
        self.id = id
        self.toolName = toolName
        self.source = source
        self.arguments = arguments
        self.reason = reason
        self.title = title
        self.parentCallID = parentCallID
    }
}

/// Asks the human. The app implements this by showing an approval card and
/// resuming when the user taps; it must return promptly on cancellation.
public protocol ApprovalHandler: Sendable {
    func decide(_ request: ApprovalRequest) async -> ApprovalDecision
}

/// Approves everything (tests, trusted automation).
public struct AutoApprove: ApprovalHandler {
    public init() {}
    public func decide(_ request: ApprovalRequest) async -> ApprovalDecision { .allowOnce }
}

/// Mode × traits × trust → allow / ask / refuse.
///
/// | Mode  | sandboxed (JS) | skills/builtin | read-only | other | destructive |
/// |-------|----------------|----------------|-----------|-------|-------------|
/// | ask   | refuse         | allow          | refuse    | refuse| refuse      |
/// | plan  | allow          | allow          | allow     | refuse| refuse      |
/// | build | allow          | allow          | allow     | ask   | ask         |
/// | auto  | allow          | allow          | allow     | allow | ask         |
///
/// Skill tools that write (`save_skill`, `delete_skill`: `.skill` without
/// `.readOnly`) follow the "other" / "destructive" columns instead.
///
/// MCP annotations are untrusted unless the user trusts the server: an
/// untrusted MCP tool is treated as destructive whatever it claims.
/// "Always allow" (keyed by tool + schema fingerprint) turns `ask` into
/// `allow`; it never overrides `refuse`.
public struct ToolPolicy: Sendable, Codable, Hashable {
    public var trustedSources: Set<String>
    public var alwaysAllow: Set<String>

    public init(trustedSources: Set<String> = [], alwaysAllow: Set<String> = []) {
        self.trustedSources = trustedSources
        self.alwaysAllow = alwaysAllow
    }

    public func effectiveTraits(of subject: ToolSubject) -> ToolTraits {
        if case .mcp = subject.source, !trustedSources.contains(subject.source.key) {
            return [.destructive, .openWorld]
        }
        return subject.traits
    }

    public func decide(_ tool: any AgentTool, arguments: JSONValue = [:], mode: AgentMode) -> ToolDecision {
        guard let subject = tool.subject(for: arguments) else {
            return .refuse(reason: tool.unavailableReason(for: arguments))
        }
        return decide(subject, mode: mode)
    }

    public func decide(_ subject: ToolSubject, mode: AgentMode) -> ToolDecision {
        let traits = effectiveTraits(of: subject)
        let alwaysAllowed = alwaysAllow.contains(Self.alwaysAllowKey(for: subject))

        switch subject.source {
        case .skill where !traits.contains(.readOnly):
            return Self.decideSkillWrite(destructive: traits.contains(.destructive), alwaysAllowed: alwaysAllowed, mode: mode)
        case .skill, .builtin, .server:
            return .allow
        default:
            break
        }

        if traits.contains(.sandboxed) {
            return mode == .ask
                ? .refuse(reason: "Running code isn't available in Ask mode. Switch to Plan, Build or Auto.")
                : .allow
        }

        switch mode {
        case .ask:
            return .refuse(reason: "Tools that reach other services aren't available in Ask mode.")
        case .plan:
            return traits.contains(.readOnly) && !traits.contains(.destructive)
                ? .allow
                : .refuse(reason: "Plan mode only runs read-only tools. Propose this step instead of running it.")
        case .build:
            if traits.contains(.readOnly) && !traits.contains(.destructive) { return .allow }
            return alwaysAllowed ? .allow : .ask(reason: traits.contains(.destructive) ? "May change or delete data" : "Makes changes")
        case .auto:
            if !traits.contains(.destructive) { return .allow }
            return alwaysAllowed ? .allow : .ask(reason: "May change or delete data")
        }
    }

    /// Saving or deleting a skill changes the device's skill library (and
    /// what later conversations are told), so it follows the side-effect
    /// columns: refused in Ask and Plan, asked in Build, allowed in Auto
    /// unless it replaces or deletes an existing skill.
    static func decideSkillWrite(destructive: Bool, alwaysAllowed: Bool, mode: AgentMode) -> ToolDecision {
        switch mode {
        case .ask:
            return .refuse(reason: "Saving or deleting skills isn't available in Ask mode. Switch to Build or Auto, or show the skill to the user instead.")
        case .plan:
            return .refuse(reason: "Plan mode doesn't change skills. Propose the skill (name, description, instructions) instead of saving it.")
        case .build:
            return alwaysAllowed ? .allow : .ask(reason: destructive ? "Replaces or deletes a skill on this device" : "Saves a new skill on this device")
        case .auto:
            if !destructive { return .allow }
            return alwaysAllowed ? .allow : .ask(reason: "Replaces or deletes a skill on this device")
        }
    }

    /// Changing a tool's description or schema revokes "always allow".
    public static func alwaysAllowKey(for subject: ToolSubject) -> String {
        "\(subject.source.key)/\(subject.name)#\(subject.fingerprint)"
    }

    public static func alwaysAllowKey(for tool: any AgentTool) -> String {
        alwaysAllowKey(for: ToolSubject(spec: tool.spec, source: tool.source, traits: tool.traits))
    }
}
