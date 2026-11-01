import Foundation
import AgentCore

/// Result of "Test connection", shaped for the Settings UI: one row per
/// check plus capabilities adjusted by what was observed.
public struct ProbeReport: Sendable, Hashable {
    public enum Status: String, Sendable, Hashable { case passed, warning, failed, skipped }

    public struct Check: Sendable, Hashable, Identifiable {
        public var id: String
        public var title: String
        public var status: Status
        public var detail: String
        public init(id: String, title: String, status: Status, detail: String) {
            self.id = id
            self.title = title
            self.status = status
            self.detail = detail
        }
    }

    public var checks: [Check]
    public var models: [ModelInfo]
    public var testedModel: String?
    /// The endpoint's capabilities with observed facts applied (tool
    /// support, streamed usage). Offer these to the user; don't apply silently.
    public var suggestedCapabilities: Capabilities

    /// Reachable and authenticated: worth saving.
    public var isUsable: Bool { !checks.contains { $0.status == .failed && ($0.id == Self.connection || $0.id == Self.chat) } }

    public static let connection = "connection"
    public static let chat = "chat"
    public static let tools = "tools"
    public static let usage = "usage"
}

/// Checks an endpoint before it's saved: lists models, then (optionally)
/// sends one tiny request with a single tool to see whether the model
/// actually calls it. Costs at most two short completions.
public struct ProviderProbe: Sendable {
    let transport: (any HTTPTransport)?

    public init(transport: (any HTTPTransport)? = nil) {
        self.transport = transport
    }

    static let probeTool = ToolSpec(
        name: "probe_echo",
        description: "Echoes a value back. Used to check that tool calling works.",
        inputSchema: ["type": "object", "properties": ["value": ["type": "string"]], "required": ["value"]])

    public func test(_ endpoint: ProviderEndpoint, model: String? = nil, checkTools: Bool = true) async -> ProbeReport {
        var checks: [ProbeReport.Check] = []
        var suggested = endpoint.capabilities
        var models: [ModelInfo] = []

        // 1. Reachability + auth via the model list.
        do {
            models = try await ProviderFactory.make(endpoint, transport: transport).listModels()
            checks.append(.init(id: ProbeReport.connection, title: "Connection", status: models.isEmpty ? .warning : .passed,
                                detail: models.isEmpty ? "Connected, but the server listed no models. Enter a model ID manually."
                                                       : "Connected. \(models.count) model\(models.count == 1 ? "" : "s") available."))
        } catch let e as ProviderError {
            switch e {
            case .http(let status, let message, _) where status == 404 || status == 405:
                // Some servers have no model list but serve completions fine.
                checks.append(.init(id: ProbeReport.connection, title: "Connection", status: .warning,
                                    detail: "The server has no model list (\(message)). Enter a model ID manually."))
            default:
                checks.append(.init(id: ProbeReport.connection, title: "Connection", status: .failed, detail: Self.explain(e)))
                return ProbeReport(checks: checks, models: [], testedModel: nil, suggestedCapabilities: suggested)
            }
        } catch {
            checks.append(.init(id: ProbeReport.connection, title: "Connection", status: .failed, detail: error.localizedDescription))
            return ProbeReport(checks: checks, models: [], testedModel: nil, suggestedCapabilities: suggested)
        }

        guard checkTools else {
            return ProbeReport(checks: checks, models: models, testedModel: nil, suggestedCapabilities: suggested)
        }
        guard let modelID = model ?? models.first?.id else {
            checks.append(.init(id: ProbeReport.tools, title: "Tool calling", status: .skipped, detail: "No model to test."))
            return ProbeReport(checks: checks, models: models, testedModel: nil, suggestedCapabilities: suggested)
        }

        // 2. One request with one tool.
        var probeEndpoint = endpoint
        probeEndpoint.capabilities.tools = true
        let provider = ProviderFactory.make(probeEndpoint, transport: transport)
        let request = ProviderRequest(
            model: modelID, system: "You are running a connection test.",
            messages: [.user("Call the probe_echo tool with value \"ping\". Do not reply with text.")],
            tools: [Self.probeTool], maxTokens: 1024, effort: .low)
        do {
            let response = try await Self.complete(provider.stream(request))
            checks.append(.init(id: ProbeReport.chat, title: "Chat", status: .passed, detail: "\(modelID) responded."))
            if response.message.toolCalls.contains(where: { $0.name == Self.probeTool.name }) {
                suggested.tools = true
                checks.append(.init(id: ProbeReport.tools, title: "Tool calling", status: .passed, detail: "The model called the test tool."))
            } else {
                checks.append(.init(id: ProbeReport.tools, title: "Tool calling", status: .warning,
                                    detail: "The model answered without calling the test tool; tool support is uncertain."))
            }
            appendUsageCheck(response.usage, to: &checks)
        } catch let e as ProviderError {
            // 404 usually means a wrong base URL or model ID — but OpenRouter
            // reports "No endpoints found that support tool use" as a 404 too,
            // so that message takes the tools-rejection path below instead.
            guard case .http(let status, let message, _) = e, (400...422).contains(status), ![401, 403].contains(status),
                  status != 404 || ToolSupport.isToolUseRejection(message) else {
                checks.append(.init(id: ProbeReport.chat, title: "Chat", status: .failed, detail: Self.explain(e)))
                return ProbeReport(checks: checks, models: models, testedModel: modelID, suggestedCapabilities: suggested)
            }
            // Rejected: is it the tools, or the request in general?
            var plain = request
            plain.tools = []
            plain.messages = [.user("Reply with the single word: ok")]
            do {
                let response = try await Self.complete(provider.stream(plain))
                suggested.tools = false
                checks.append(.init(id: ProbeReport.chat, title: "Chat", status: .passed, detail: "\(modelID) responded."))
                checks.append(.init(id: ProbeReport.tools, title: "Tool calling", status: .failed,
                                    detail: "The server rejected a request with tools: \(message)"))
                appendUsageCheck(response.usage, to: &checks)
            } catch {
                checks.append(.init(id: ProbeReport.chat, title: "Chat", status: .failed,
                                    detail: (error as? ProviderError).map(Self.explain) ?? error.localizedDescription))
            }
        } catch {
            checks.append(.init(id: ProbeReport.chat, title: "Chat", status: .failed, detail: error.localizedDescription))
        }
        return ProbeReport(checks: checks, models: models, testedModel: modelID, suggestedCapabilities: suggested)
    }

    private func appendUsageCheck(_ usage: Usage, to checks: inout [ProbeReport.Check]) {
        if usage.isEmpty {
            checks.append(.init(id: ProbeReport.usage, title: "Token usage", status: .warning,
                                detail: "The server didn't report token usage; context size will be estimated."))
        } else {
            checks.append(.init(id: ProbeReport.usage, title: "Token usage", status: .passed,
                                detail: "\(usage.contextTokens) prompt / \(usage.outputTokens) output tokens reported."))
        }
    }

    static func complete(_ stream: AsyncThrowingStream<ProviderEvent, Error>) async throws -> ProviderResponse {
        for try await event in stream {
            if case .completed(let r) = event { return r }
        }
        throw ProviderError.network("The response ended before it was complete.")
    }

    static func explain(_ error: ProviderError) -> String {
        switch error {
        case .http(401, let m, _), .http(403, let m, _): return "The API key was rejected: \(m)"
        case .http(404, let m, _): return "Not found — check the base URL and model ID: \(m)"
        default: return error.description
        }
    }
}
