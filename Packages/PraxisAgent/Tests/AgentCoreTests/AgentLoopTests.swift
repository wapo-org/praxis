import Foundation
import Testing
import Synchronization
@testable import AgentCore
import AgentTestSupport

private func config(_ mode: AgentMode = .auto, retries: Int = 4) -> AgentRunConfiguration {
    AgentRunConfiguration(conversationID: "c1", model: "m", system: "sys", mode: mode, effort: .low, maxRetries: retries)
}

private func outcome(_ events: [AgentEvent]) -> RunOutcome? {
    if case .finished(let o) = events.last { return o }
    return nil
}

private func committed(_ events: [AgentEvent]) -> [Message] {
    events.flatMap { if case .committed(let m) = $0 { return m }; return [] }
}

private let noSleep: @Sendable (Duration) async throws -> Void = { _ in }

@Suite struct AgentLoopTests {
    @Test func textOnlyRunCommitsAnswer() async {
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("Hello")])
        let loop = AgentLoop(provider: provider, tools: .empty)
        let events = await loop.run(transcript: [.user("hi")], configuration: config()).collect()
        #expect(outcome(events) == .completed)
        #expect(committed(events).map(\.text) == ["Hello"])
        #expect(provider.requests.count == 1)
        #expect(provider.requests[0].system == "sys")
    }

    @Test func toolRoundTripSendsResultsInCallOrder() async {
        let slow = ClosureTool(name: "slow") { _, _ in
            try await Task.sleep(for: .milliseconds(50))
            return .text("slow-done")
        }
        let fast = ClosureTool(name: "fast") { inv, _ in .text("fast:\(inv.arguments["x"]?.intValue ?? -1)") }
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("a", "slow", "{}"), ("b", "fast", #"{"x": 7}"#)], preamble: "Let me check."),
            ScriptedProvider.text("Done"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([slow, fast]))
        let events = await loop.run(transcript: [.user("go")], configuration: config()).collect()

        #expect(outcome(events) == .completed)
        let second = provider.requests[1].messages
        #expect(second.count == 3)
        let results = second[2].toolResults
        #expect(results.map(\.callID) == ["a", "b"])
        #expect(results.map { $0.content.first?.text } == ["slow-done", "fast:7"])
        // Tools are sent sorted by name.
        #expect(provider.requests[0].tools.map(\.name) == ["fast", "slow"])
    }

    @Test func unknownToolAndBadArgumentsBecomeErrorResults() async {
        let echo = ClosureTool(name: "echo") { _, _ in .text("ok") }
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("a", "nope", "{}"), ("b", "echo", "{not json")]),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([echo]))
        _ = await loop.run(transcript: [.user("go")], configuration: config()).collect()
        let results = provider.requests[1].messages.last!.toolResults
        #expect(results.allSatisfy { $0.isError })
        #expect(results[0].content.first?.text?.contains("Unknown tool") == true)
        #expect(results[1].content.first?.text?.contains("Invalid JSON") == true)
    }

    @Test func askModeRefusesSandboxedCode() async {
        let js = ClosureTool(name: "run_javascript", traits: [.sandboxed, .openWorld], source: .javascript) { _, _ in
            Issue.record("must not run")
            return .text("ran")
        }
        let provider = ScriptedProvider(steps: [ScriptedProvider.toolCalls([("a", "run_javascript", "{}")]), ScriptedProvider.text("ok")])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([js]))
        let events = await loop.run(transcript: [.user("go")], configuration: config(.ask)).collect()
        #expect(outcome(events) == .completed)
        #expect(provider.requests[1].messages.last!.toolResults.first?.isError == true)
    }

    @Test func untrustedMCPToolAsksAndDenialIsReported() async {
        let mcp = ClosureTool(name: "mcp__linear__create_issue", traits: [.readOnly],
                              source: .mcp(serverID: "linear", serverName: "Linear")) { _, _ in
            Issue.record("must not run")
            return .text("created")
        }
        let approver = RecordingApprover(.deny)
        let provider = ScriptedProvider(steps: [ScriptedProvider.toolCalls([("a", mcp.spec.name, "{}")]), ScriptedProvider.text("ok")])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([mcp]), approvals: approver)
        let events = await loop.run(transcript: [.user("go")], configuration: config(.auto)).collect()
        #expect(approver.requests.count == 1)
        #expect(events.contains { if case .toolFinished(_, let c) = $0 { return c.status == .denied }; return false })
        #expect(provider.requests[1].messages.last!.toolResults.first?.content.first?.text == "The user declined this tool call.")
    }

    @Test func trustedReadOnlyMCPToolRunsWithoutAsking() async {
        let mcp = ClosureTool(name: "mcp__linear__list", traits: [.readOnly],
                              source: .mcp(serverID: "linear", serverName: "Linear")) { _, _ in .text("[]") }
        let approver = RecordingApprover(.deny)
        let provider = ScriptedProvider(steps: [ScriptedProvider.toolCalls([("a", mcp.spec.name, "{}")]), ScriptedProvider.text("ok")])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([mcp]),
                             policy: ToolPolicy(trustedSources: ["mcp:linear"]), approvals: approver)
        _ = await loop.run(transcript: [.user("go")], configuration: config(.plan)).collect()
        #expect(approver.requests.isEmpty)
        #expect(provider.requests[1].messages.last!.toolResults.first?.isError == false)
    }

    @Test func allowAlwaysIsRememberedWithinTheRun() async {
        let mcp = ClosureTool(name: "mcp__x__write", traits: [.destructive],
                              source: .mcp(serverID: "x", serverName: "X")) { _, _ in .text("ok") }
        let approver = RecordingApprover(.allowAlways)
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("a", mcp.spec.name, "{}")]),
            ScriptedProvider.toolCalls([("b", mcp.spec.name, "{}")]),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([mcp]), approvals: approver)
        let events = await loop.run(transcript: [.user("go")], configuration: config(.build)).collect()
        #expect(approver.requests.count == 1)
        #expect(events.contains { if case .policyUpdated = $0 { return true }; return false })
    }

    @Test func retryableFailureDiscardsPartialOutputAndRetries() async {
        let provider = ScriptedProvider(steps: [
            .partialThenFailure([.textDelta(index: 0, text: "Hel")], .stream(type: "overloaded_error", message: "busy")),
            ScriptedProvider.text("Hello"),
        ])
        let loop = AgentLoop(provider: provider, tools: .empty, sleep: noSleep)
        let events = await loop.run(transcript: [.user("hi")], configuration: config()).collect()
        #expect(outcome(events) == .completed)
        #expect(events.contains { if case .attemptDiscarded(let b, _) = $0 { return b == ["1.0.0"] }; return false })
        #expect(events.contains { if case .retrying(1, _, _) = $0 { return true }; return false })
        #expect(committed(events).map(\.text) == ["Hello"])
    }

    @Test func retryHonoursRetryAfter() async {
        let delays = Mutex<[Duration]>([])
        let provider = ScriptedProvider(steps: [
            .failure(.http(status: 429, message: "slow down", retryAfter: .seconds(3))),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: .empty, sleep: { d in delays.withLock { $0.append(d) } })
        _ = await loop.run(transcript: [.user("hi")], configuration: config()).collect()
        #expect(delays.withLock { $0 } == [.seconds(3)])
    }

    @Test func nonRetryableFailureFails() async {
        let provider = ScriptedProvider(steps: [.failure(.http(status: 401, message: "bad key", retryAfter: nil))])
        let loop = AgentLoop(provider: provider, tools: .empty, sleep: noSleep)
        let events = await loop.run(transcript: [.user("hi")], configuration: config()).collect()
        #expect(outcome(events) == .failed("HTTP 401: bad key"))
    }

    @Test func danglingToolCallsAreClosedOnNextRun() async {
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("ok")])
        let loop = AgentLoop(provider: provider, tools: .empty)
        let history: [Message] = [
            .user("first"),
            Message(role: .assistant, parts: [.toolCall(ToolCall(id: "t1", name: "x", arguments: "{}"))]),
            .user("second"),
        ]
        _ = await loop.run(transcript: history, configuration: config()).collect()
        let sent = provider.requests[0].messages
        #expect(sent.count == 4)
        #expect(sent[2].toolResults.first?.callID == "t1")
        #expect(sent[3].text == "second")
    }

    @Test func refusalIsNotCommitted() async {
        let provider = ScriptedProvider(steps: [.events([
            .textDelta(index: 0, text: "I can't"),
            .completed(ProviderResponse(message: Message(role: .assistant, parts: [.text("I can't")]),
                                        stopReason: .refusal("cyber"), usage: Usage())),
        ])])
        let loop = AgentLoop(provider: provider, tools: .empty)
        let events = await loop.run(transcript: [.user("x")], configuration: config()).collect()
        #expect(outcome(events) == .refused("cyber"))
        #expect(committed(events).isEmpty)
    }

    @Test func truncatedToolCallRetriesWithLargerBudget() async {
        let echo = ClosureTool(name: "echo") { _, _ in .text("ok") }
        let cut = ProviderScript.response(parts: [.toolCall(ToolCall(id: "a", name: "echo", arguments: "{\"x\":"))], stop: .maxTokens)
        let provider = ScriptedProvider(steps: [cut, ScriptedProvider.toolCalls([("b", "echo", "{}")]), ScriptedProvider.text("ok")])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([echo]))
        let events = await loop.run(transcript: [.user("x")], configuration: config()).collect()
        #expect(outcome(events) == .completed)
        #expect(provider.requests[1].maxTokens == provider.requests[0].maxTokens * 2)
    }

    @Test func pauseTurnResendsWithoutNewUserMessage() async {
        let paused = ProviderScript.response(parts: [.text("Searching…")], stop: .pauseTurn)
        let provider = ScriptedProvider(steps: [paused, ScriptedProvider.text("Found it")])
        let loop = AgentLoop(provider: provider, tools: .empty)
        _ = await loop.run(transcript: [.user("x")], configuration: config()).collect()
        let second = provider.requests[1].messages
        #expect(second.map(\.role) == [.user, .assistant])
    }

    @Test func iterationCapStopsRunawayLoops() async {
        let echo = ClosureTool(name: "echo") { _, _ in .text("ok") }
        let steps = (0..<20).map { ScriptedProvider.toolCalls([("c\($0)", "echo", "{}")]) }
        let provider = ScriptedProvider(steps: steps)
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([echo]))
        let events = await loop.run(transcript: [.user("x")], configuration: config()).collect()
        #expect(outcome(events) == .maxIterations)
        #expect(provider.requests.count == Effort.low.defaultMaxIterations)
    }

    @Test func toolTimeoutReturnsError() async {
        let hang = ClosureTool(name: "hang") { _, _ in
            try await Task.sleep(for: .seconds(30))
            return .text("never")
        }
        let provider = ScriptedProvider(steps: [ScriptedProvider.toolCalls([("a", "hang", "{}")]), ScriptedProvider.text("ok")])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([hang]))
        var cfg = config()
        cfg.toolTimeout = .milliseconds(50)
        _ = await loop.run(transcript: [.user("x")], configuration: cfg).collect()
        #expect(provider.requests[1].messages.last!.toolResults.first?.content.first?.text?.contains("timed out") == true)
    }

    @Test func nestedCallsGoThroughPolicy() async {
        let write = ClosureTool(name: "mcp__x__delete", traits: [.destructive],
                                source: .mcp(serverID: "x", serverName: "X")) { _, _ in .text("deleted") }
        let js = ClosureTool(name: "run_javascript", traits: [.sandboxed], source: .javascript) { _, ctx in
            let r = try await ctx.callTool?("mcp__x__delete", [:])
            return .text(r?.text ?? "nil")
        }
        let approver = RecordingApprover(.deny)
        let provider = ScriptedProvider(steps: [ScriptedProvider.toolCalls([("a", "run_javascript", "{}")]), ScriptedProvider.text("ok")])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([write, js]), approvals: approver)
        _ = await loop.run(transcript: [.user("x")], configuration: config(.auto)).collect()
        #expect(approver.requests.map(\.toolName) == ["mcp__x__delete"])
        #expect(approver.requests.map(\.parentCallID) == ["a"])
        #expect(provider.requests[1].messages.last!.toolResults.first?.content.first?.text == "The user declined this tool call.")
    }

    @Test func hiddenToolsAreReachableOnlyFromCode() async {
        let hidden = ClosureTool(name: "mcp__x__read", traits: [.readOnly],
                                 source: .mcp(serverID: "x", serverName: "X")) { _, _ in .text("secret-data") }
        let js = ClosureTool(name: "run_javascript", traits: [.sandboxed], source: .javascript) { _, ctx in
            let r = try await ctx.callTool?("mcp__x__read", [:])
            return .text(r?.text ?? "nil")
        }
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("a", "mcp__x__read", "{}"), ("b", "run_javascript", "{}")]),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([js], hidden: [hidden]),
                             policy: ToolPolicy(trustedSources: ["mcp:x"]))
        _ = await loop.run(transcript: [.user("x")], configuration: config(.auto)).collect()
        #expect(provider.requests[0].tools.map(\.name) == ["run_javascript"])
        let results = provider.requests[1].messages.last!.toolResults
        #expect(results[0].isError)
        #expect(results[1].content.first?.text == "secret-data")
    }

    @Test func unresolvableSubjectReportsToolsReason() async {
        let provider = ScriptedProvider(steps: [ScriptedProvider.toolCalls([("a", "gateway", #"{"tool": "nope"}"#)]),
                                                ScriptedProvider.text("ok")])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([NoTargetTool()]))
        _ = await loop.run(transcript: [.user("x")], configuration: config(.auto)).collect()
        #expect(provider.requests[1].messages.last!.toolResults.first?.content.first?.text == "No target nope; search first.")
    }

    @Test func largeResultsAreTruncatedAndPageable() async throws {
        let big = String(repeating: "abcdefghij", count: 10_000)
        let tool = ClosureTool(name: "big") { _, _ in .text(big) }
        let spill = OutputSpill()
        let provider = ScriptedProvider(steps: [ScriptedProvider.toolCalls([("a", "big", "{}")]), ScriptedProvider.text("ok")])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([tool, ReadToolOutputTool(spill: spill)]),
                             limiter: ResultLimiter(maxCharacters: 1000), spill: spill)
        _ = await loop.run(transcript: [.user("x")], configuration: config()).collect()
        let sent = try #require(provider.requests[1].messages.last!.toolResults.first?.content.first?.text)
        #expect(sent.count < 1300)
        #expect(sent.contains("read_tool_output"))
        #expect(await spill.read(id: "a", offset: 0, limit: 10) == "abcdefghij")
    }
}

/// Small helpers for hand-built responses.
enum ProviderScript {
    static func response(parts: [Part], stop: StopReason) -> ScriptedProvider.Step {
        .events([.completed(ProviderResponse(message: Message(role: .assistant, parts: parts), stopReason: stop, usage: Usage()))])
    }
}

/// A gateway-like tool whose arguments never name a valid target.
private struct NoTargetTool: AgentTool {
    var spec: ToolSpec { ToolSpec(name: "gateway", description: "", inputSchema: ["type": "object"]) }
    var traits: ToolTraits { [] }
    var source: ToolSource { .builtin }
    func subject(for arguments: JSONValue) -> ToolSubject? { nil }
    func unavailableReason(for arguments: JSONValue) -> String {
        "No target \(arguments["tool"]?.stringValue ?? ""); search first."
    }
    func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput { .text("ran") }
}
