import Foundation
import AgentCore
import AgentMCP

/// A rebuilt tool whose live spec drifted from the frozen one: offers the
/// frozen spec, behaves like the live tool.
struct PinnedTool: AgentTool {
    let spec: ToolSpec
    let base: any AgentTool

    var traits: ToolTraits { base.traits }
    var source: ToolSource { base.source }
    func presentation(for arguments: JSONValue) -> ToolPresentation { base.presentation(for: arguments) }
    func subject(for arguments: JSONValue) -> ToolSubject? { base.subject(for: arguments) }
    func unavailableReason(for arguments: JSONValue) -> String { base.unavailableReason(for: arguments) }

    func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        try await base.execute(invocation, context: context)
    }
}

/// A frozen tool this build can no longer provide (e.g. the app stopped
/// passing a skill store). It stays in the list so the prefix doesn't
/// change; calls are refused before reaching approval.
struct RetiredTool: AgentTool {
    let spec: ToolSpec

    var traits: ToolTraits { [.readOnly] }
    var source: ToolSource { .builtin }
    func subject(for arguments: JSONValue) -> ToolSubject? { nil }

    func unavailableReason(for arguments: JSONValue) -> String {
        "\(spec.name) is no longer available in this conversation."
    }

    func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        .error(unavailableReason(for: invocation.arguments))
    }
}

/// One frozen MCP tool. Spec, traits and source come from the snapshot, so
/// names and approval keys stay stable; calls go to the server's current
/// client. When the connector is gone or off, `subject(for:)` is nil and
/// the loop answers with the reason without asking for approval.
struct ConnectorTool: AgentTool {
    enum Target: Sendable {
        case live(MCPTool)
        case unavailable(String)
    }

    let frozen: MCPTool
    let target: Target

    var spec: ToolSpec { frozen.spec }
    var traits: ToolTraits { frozen.traits }
    var source: ToolSource { frozen.source }
    func presentation(for arguments: JSONValue) -> ToolPresentation { frozen.presentation(for: arguments) }

    func subject(for arguments: JSONValue) -> ToolSubject? {
        if case .live = target { return frozen.subject }
        return nil
    }

    func unavailableReason(for arguments: JSONValue) -> String {
        if case .unavailable(let reason) = target { return reason }
        return "That tool isn't available for these arguments."
    }

    func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        switch target {
        case .live(let tool): return try await tool.execute(invocation, context: context)
        case .unavailable(let reason): return .error(reason)
        }
    }
}

/// `mcp_call_tool` routed to `ConnectorTool`s, so gateway calls reach the
/// live client (or report a removed connector) exactly like direct calls.
/// Spec, presentation and target resolution stay the gateway's own.
struct GatewayCallTool: AgentTool {
    let base: any AgentTool
    let targets: [String: ConnectorTool]

    var spec: ToolSpec { base.spec }
    var traits: ToolTraits { base.traits }
    var source: ToolSource { base.source }
    func presentation(for arguments: JSONValue) -> ToolPresentation { base.presentation(for: arguments) }

    private func target(_ arguments: JSONValue) -> ConnectorTool? {
        base.subject(for: arguments).flatMap { targets[$0.name] }
    }

    func subject(for arguments: JSONValue) -> ToolSubject? {
        target(arguments)?.subject(for: Self.innerArguments(arguments))
    }

    func unavailableReason(for arguments: JSONValue) -> String {
        target(arguments)?.unavailableReason(for: Self.innerArguments(arguments)) ?? base.unavailableReason(for: arguments)
    }

    func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        guard let tool = target(invocation.arguments) else { return .error(base.unavailableReason(for: invocation.arguments)) }
        let arguments = Self.innerArguments(invocation.arguments)
        guard case .object = arguments else { return .error("“arguments” must be a JSON object.") }
        return try await tool.execute(ToolInvocation(id: invocation.id, name: tool.spec.name, arguments: arguments), context: context)
    }

    /// As the gateway reads them: some models send `arguments` as a JSON string.
    static func innerArguments(_ outer: JSONValue) -> JSONValue {
        switch outer["arguments"] {
        case .string(let s)?: return (try? JSONValue(parsing: s)) ?? .string(s)
        case nil, .null?: return .object([:])
        case let value?: return value
        }
    }
}

/// Transport for the stand-in clients that give frozen MCP tools their
/// specs. Those clients never send anything: calls go to `ConnectorTool`.
struct DetachedTransport: HTTPTransport {
    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        throw ProviderError.network("This connector isn't connected.")
    }
}
