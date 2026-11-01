import Foundation
import Testing
import Synchronization
import AgentCore
import AgentTestSupport
@testable import AgentMCP

/// R3-M5: each tool call's elicitations carry the run's scope — passed
/// per call, or read ambiently when the caller can't pass one — so
/// stopping one run resolves only its own waiters.
@Suite struct ECancelElicitationScopeTests {
    @Test func ambientScopeReachesHandler() async throws {
        let handler = ScopedStub(.accept(["name": "octocat"]))
        let transport = ScriptedTransport(handler: eliciting(["hello"]))
        let client = makeClient(transport, elicitation: handler)
        let scope = UUID()
        let result = try await ElicitationScope.$current.withValue(scope) {
            try await client.callTool("search", arguments: [:])
        }
        #expect(result.content == [.text("hello")])
        #expect(handler.scoped.all == [scope])
    }

    @Test func explicitScopeBeatsAmbientScope() async throws {
        let handler = ScopedStub(.accept(["name": "octocat"]))
        let transport = ScriptedTransport(handler: eliciting(["hello"]))
        let client = makeClient(transport, elicitation: handler)
        let explicit = UUID()
        let result = try await ElicitationScope.$current.withValue(UUID()) {
            try await client.callTool("search", arguments: [:], elicitationScope: explicit)
        }
        #expect(result.content == [.text("hello")])
        #expect(handler.scoped.all == [explicit])
    }

    @Test func legacyHandlerStillAnswers() async throws {
        let handler = StubElicitation(.accept(["name": "octocat"]))
        let transport = ScriptedTransport(handler: eliciting(["hello"]))
        let client = makeClient(transport, elicitation: handler)
        let result = try await ElicitationScope.$current.withValue(UUID()) {
            try await client.callTool("search", arguments: [:])
        }
        #expect(result.content == [.text("hello")])
        #expect(handler.seen.all.count == 1)
    }

    @Test func gatewayRoutedCallCarriesAmbientScope() async throws {
        let handler = ScopedStub(.accept(["ok": true]))
        let transport = ScriptedTransport(handler: eliciting(["done"]))
        let client = makeClient(transport, elicitation: handler)
        let tool = MCPTool(client: client, definition: MCPToolDefinition(name: "search"),
                           name: "mcp__acme__search", serverSlug: "acme")
        let gateway = MCPGateway(catalog: [tool])
        let call = try #require(gateway.tools.first { $0.spec.name == MCPGateway.callName })
        let scope = UUID()
        let output = try await ElicitationScope.$current.withValue(scope) {
            try await call.execute(
                ToolInvocation(id: "call-1", name: MCPGateway.callName,
                               arguments: ["tool": "mcp__acme__search", "arguments": [:]]),
                context: ToolContext(conversationID: "c1", mode: .auto))
        }
        #expect(output.isError == false)
        #expect(handler.scoped.all == [scope])
    }
}

/// A modern server that asks one elicitation per call, then answers
/// each retry with the next text in `answers`.
private func eliciting(_ answers: [String]) -> @Sendable (URLRequest, Int) throws -> Reply {
    let remaining = Mutex(answers)
    let modern = Fake.modern()
    return { request, n in
        guard request.rpcMethod == "tools/call" else { return try modern(request, n) }
        guard request.params["inputResponses"] == nil else {
            let answer = remaining.withLock { $0.isEmpty ? "?" : $0.removeFirst() }
            return Fake.result(request, Fake.text(answer))
        }
        return Fake.result(request, [
            "resultType": "input_required",
            "inputRequests": ["login": ["method": "elicitation/create", "params": [
                "mode": "form", "message": "Your GitHub username?",
                "requestedSchema": ["type": "object", "properties": ["name": ["type": "string"]], "required": ["name"]],
            ]]],
            "requestState": "opaque-1",
        ])
    }
}

private final class ScopedStub: RunScopedElicitationHandler {
    let answer: MCPElicitationResult
    let scoped = Box<UUID?>()
    init(_ answer: MCPElicitationResult) { self.answer = answer }
    func elicit(_ request: MCPElicitation) async -> MCPElicitationResult { answer }
    func elicit(_ request: MCPElicitation, scope: UUID?) async -> MCPElicitationResult {
        scoped.append(scope)
        return answer
    }
}
