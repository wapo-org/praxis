import Foundation
import AgentCore
import Synchronization

/// A `ModelProvider` that replays scripted responses, one per request.
/// Records every request it receives for assertions.
public final class ScriptedProvider: ModelProvider, Sendable {
    public enum Step: Sendable {
        case events([ProviderEvent])
        case failure(ProviderError)
        /// Emits events, then fails mid-stream.
        case partialThenFailure([ProviderEvent], ProviderError)
    }

    public let flavor: ProviderFlavor
    public let capabilities: Capabilities
    private let state: Mutex<(steps: [Step], requests: [ProviderRequest])>

    public init(flavor: ProviderFlavor = .anthropicMessages, capabilities: Capabilities = Capabilities(), steps: [Step]) {
        self.flavor = flavor
        self.capabilities = capabilities
        self.state = Mutex((steps, []))
    }

    public var requests: [ProviderRequest] { state.withLock { $0.requests } }

    public func listModels() async throws -> [ModelInfo] { [ModelInfo(id: "scripted")] }

    public func stream(_ request: ProviderRequest) -> AsyncThrowingStream<ProviderEvent, Error> {
        let step: Step? = state.withLock { s in
            s.requests.append(request)
            return s.steps.isEmpty ? nil : s.steps.removeFirst()
        }
        return AsyncThrowingStream { continuation in
            switch step {
            case .none:
                continuation.finish(throwing: ProviderError.invalidConfiguration("ScriptedProvider ran out of steps"))
            case .events(let events):
                for e in events { continuation.yield(e) }
                continuation.finish()
            case .failure(let error):
                continuation.finish(throwing: error)
            case .partialThenFailure(let events, let error):
                for e in events { continuation.yield(e) }
                continuation.finish(throwing: error)
            }
        }
    }

    // MARK: Builders

    /// A plain text answer.
    public static func text(_ text: String, usage: Usage = Usage(inputTokens: 10, outputTokens: 5)) -> Step {
        .events([
            .textDelta(index: 0, text: text),
            .blockFinished(index: 0),
            .completed(ProviderResponse(message: Message(role: .assistant, parts: [.text(text)]), stopReason: .endTurn, usage: usage)),
        ])
    }

    /// An answer that calls tools. `calls` are (id, name, argumentsJSON).
    public static func toolCalls(_ calls: [(String, String, String)], preamble: String? = nil) -> Step {
        var events: [ProviderEvent] = []
        var parts: [Part] = []
        var index = 0
        if let preamble {
            events += [.textDelta(index: 0, text: preamble), .blockFinished(index: 0)]
            parts.append(.text(preamble))
            index = 1
        }
        for (id, name, args) in calls {
            events += [.toolCallStarted(index: index, id: id, name: name), .toolCallDelta(index: index, json: args), .blockFinished(index: index)]
            parts.append(.toolCall(ToolCall(id: id, name: name, arguments: args)))
            index += 1
        }
        events.append(.completed(ProviderResponse(message: Message(role: .assistant, parts: parts), stopReason: .toolUse,
                                                  usage: Usage(inputTokens: 10, outputTokens: 5))))
        return .events(events)
    }
}

/// An `AgentTool` backed by a closure.
public struct ClosureTool: AgentTool {
    public let spec: ToolSpec
    public let traits: ToolTraits
    public let source: ToolSource
    let body: @Sendable (ToolInvocation, ToolContext) async throws -> ToolOutput

    public init(name: String, description: String = "test tool", traits: ToolTraits = [.readOnly],
                source: ToolSource = .builtin,
                schema: JSONValue = ["type": "object", "properties": [:]],
                body: @escaping @Sendable (ToolInvocation, ToolContext) async throws -> ToolOutput) {
        self.spec = ToolSpec(name: name, description: description, inputSchema: schema)
        self.traits = traits
        self.source = source
        self.body = body
    }

    public func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        try await body(invocation, context)
    }
}

/// Approval handler with a fixed answer that records requests.
public final class RecordingApprover: ApprovalHandler, Sendable {
    private let answer: ApprovalDecision
    private let seen = Mutex<[ApprovalRequest]>([])
    public init(_ answer: ApprovalDecision) { self.answer = answer }
    public var requests: [ApprovalRequest] { seen.withLock { $0 } }
    public func decide(_ request: ApprovalRequest) async -> ApprovalDecision {
        seen.withLock { $0.append(request) }
        return answer
    }
}

public extension AsyncStream where Element == AgentEvent {
    func collect() async -> [AgentEvent] {
        var out: [AgentEvent] = []
        for await e in self { out.append(e) }
        return out
    }
}
