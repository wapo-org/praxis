import Foundation
import Testing
import Synchronization
@testable import AgentCore
import AgentTestSupport

/// Regression tests for the E-cancel loop fixes: R1-M2 (retry names
/// first-attempt blocks), R1-M3 (retry capped at the model max), R1-M4
/// (timeout abandons a hung tool), R1-M1a (cancel during a silent
/// stream) and the R3-H1 loop quarter (the stop flag ends a run).
@Suite struct ECancelLoopTests {
    // MARK: R1-M2

    @Test func maxTokensRetryNamesFirstAttemptTextBlocks() async {
        let echo = ClosureTool(name: "echo") { _, _ in .text("ok") }
        let cut: ScriptedProvider.Step = .events([
            .textDelta(index: 0, text: "partial"),
            .toolCallStarted(index: 1, id: "a", name: "echo"),
            .toolCallDelta(index: 1, json: #"{"x":"#),
            .blockFinished(index: 0),
            .blockFinished(index: 1),
            .completed(ProviderResponse(
                message: Message(role: .assistant, parts: [
                    .text("partial"),
                    .toolCall(ToolCall(id: "a", name: "echo", arguments: #"{"x":"#)),
                ]),
                stopReason: .maxTokens, usage: Usage())),
        ])
        let provider = ScriptedProvider(steps: [
            cut,
            ScriptedProvider.toolCalls([("b", "echo", "{}")]),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([echo]))
        let events = await loop.run(transcript: [.user("x")], configuration: eConfig()).collect()
        #expect(eOutcome(events) == .completed)
        #expect(events.contains {
            if case .attemptDiscarded(let blocks, let tools) = $0 {
                return blocks == ["1.0.0"] && tools == ["a"]
            }
            return false
        })
    }

    // MARK: R1-M3

    @Test func maxTokensRetryIsCappedAtModelMax() async {
        let echo = ClosureTool(name: "echo") { _, _ in .text("ok") }
        let cut = ProviderScript.response(parts: [.toolCall(ToolCall(id: "a", name: "echo", arguments: #"{"x":"#))],
                                          stop: .maxTokens)
        let provider = ScriptedProvider(steps: [
            cut,
            ScriptedProvider.toolCalls([("b", "echo", "{}")]),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([echo]))
        var cfg = eConfig()
        cfg.maxTokens = 1000
        cfg.modelMaxTokens = 1500
        let events = await loop.run(transcript: [.user("x")], configuration: cfg).collect()
        #expect(eOutcome(events) == .completed)
        #expect(provider.requests.count == 3)
        #expect(provider.requests[1].maxTokens == 1500)
    }

    @Test func noRetryWhenAlreadyAtModelMax() async {
        let echo = ClosureTool(name: "echo") { _, _ in .text("ok") }
        let cut = ProviderScript.response(parts: [.toolCall(ToolCall(id: "a", name: "echo", arguments: #"{"x":"#))],
                                          stop: .maxTokens)
        let provider = ScriptedProvider(steps: [cut, ScriptedProvider.text("unused")])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([echo]))
        var cfg = eConfig()
        cfg.maxTokens = 1000
        cfg.modelMaxTokens = 1000
        let events = await loop.run(transcript: [.user("x")], configuration: cfg).collect()
        #expect(eOutcome(events) == .truncated)
        #expect(provider.requests.count == 1)
    }

    // MARK: R1-M4

    @Test(.timeLimit(.minutes(1))) func timeoutAbandonsNonCooperativeTool() async {
        let stuck = ClosureTool(name: "stuck") { _, _ in
            for _ in 0..<100 { try? await Task.sleep(for: .seconds(60)) } // swallows cancellation
            return .text("unreachable")
        }
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("a", "stuck", "{}")]),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([stuck]))
        var cfg = eConfig()
        cfg.toolTimeout = .milliseconds(50)
        let clock = ContinuousClock()
        let elapsed = await clock.measure {
            let events = await loop.run(transcript: [.user("x")], configuration: cfg).collect()
            #expect(eOutcome(events) == .completed)
        }
        let resultText = provider.requests.dropFirst().first?.messages.last?.toolResults.first?.content.first?.text
        #expect(resultText?.contains("timed out") == true)
        #expect(elapsed < .seconds(5))
    }

    // MARK: R1-M1a + R3-H1 flag during silence

    @Test(.timeLimit(.minutes(1))) func cancelDuringSilentStreamUnblocksPromptly() async {
        // Cancelling the consumer unblocks collection at once (with the
        // events so far); ending the run itself is the flag's job (below).
        let loop = AgentLoop(provider: SilentProvider(), tools: .empty)
        let clock = ContinuousClock()
        let elapsed = await clock.measure {
            let task = Task {
                await loop.run(transcript: [.user("hi")], configuration: eConfig()).collect()
            }
            try? await Task.sleep(for: .milliseconds(100))
            task.cancel()
            let events = await task.value
            #expect(events.contains { if case .textDelta = $0 { return true }; return false })
        }
        #expect(elapsed < .seconds(5))
    }

    @Test(.timeLimit(.minutes(1))) func stopDuringSilentStreamEndsPromptly() async {
        let flag = FlagBox()
        var cfg = eConfig()
        cfg.isCancelled = { flag.value }
        let frozen = cfg
        let loop = AgentLoop(provider: SilentProvider(), tools: .empty)
        let clock = ContinuousClock()
        let elapsed = await clock.measure {
            let task = Task {
                await loop.run(transcript: [.user("hi")], configuration: frozen).collect()
            }
            try? await Task.sleep(for: .milliseconds(100))
            flag.set()
            let events = await task.value
            #expect(eOutcome(events) == .cancelled)
        }
        #expect(elapsed < .seconds(5))
    }

    // MARK: R3-H1 loop quarter

    @Test func stopBeforeRunSendsNothing() async {
        var cfg = eConfig()
        cfg.isCancelled = { true }
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("Hello")])
        let loop = AgentLoop(provider: provider, tools: .empty)
        let events = await loop.run(transcript: [.user("hi")], configuration: cfg).collect()
        #expect(eOutcome(events) == .cancelled)
        #expect(provider.requests.isEmpty)
    }

    @Test func stopDuringApprovalSkipsTheTool() async {
        let ran = FlagBox()
        let mcp = ClosureTool(name: "mcp__x__write", traits: [.destructive],
                              source: .mcp(serverID: "x", serverName: "X")) { _, _ in
            ran.set()
            return .text("ok")
        }
        let flag = FlagBox()
        var cfg = eConfig(mode: .auto)
        cfg.isCancelled = { flag.value }
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("a", mcp.spec.name, "{}")]),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([mcp]),
                             approvals: FlagFlippingApprover(flag: flag))
        let events = await loop.run(transcript: [.user("x")], configuration: cfg).collect()
        #expect(eOutcome(events) == .cancelled)
        #expect(ran.value == false)
    }

    // MARK: R3-M5 loop leg

    @Test func toolSeesRunElicitationScope() async {
        let probe = ClosureTool(name: "probe") { _, _ in
            .text("scope=\(ElicitationScope.current?.uuidString ?? "nil")")
        }
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("a", "probe", "{}")]),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([probe]))
        let scope = UUID()
        var cfg = eConfig()
        cfg.elicitationScope = scope
        let events = await loop.run(transcript: [.user("x")], configuration: cfg).collect()
        #expect(eOutcome(events) == .completed)
        let text = provider.requests[1].messages.last?.toolResults.first?.content.first?.text
        #expect(text == "scope=\(scope.uuidString)")
    }

    @Test func toolSeesNoScopeWhenRunHasNone() async {
        let probe = ClosureTool(name: "probe") { _, _ in
            .text("scope=\(ElicitationScope.current?.uuidString ?? "nil")")
        }
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("a", "probe", "{}")]),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([probe]))
        _ = await loop.run(transcript: [.user("x")], configuration: eConfig()).collect()
        let text = provider.requests[1].messages.last?.toolResults.first?.content.first?.text
        #expect(text == "scope=nil")
    }

    @Test func stopDuringToolRunEndsWithoutFurtherRequests() async {
        let flag = FlagBox()
        let slow = ClosureTool(name: "slow") { _, _ in
            flag.set() // the run is stopped while this tool runs
            return .text("done")
        }
        var cfg = eConfig()
        cfg.isCancelled = { flag.value }
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("a", "slow", "{}")]),
            ScriptedProvider.text("ok"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([slow]))
        let events = await loop.run(transcript: [.user("x")], configuration: cfg).collect()
        #expect(eOutcome(events) == .cancelled)
        #expect(provider.requests.count == 1)
    }
}

private func eConfig(mode: AgentMode = .auto) -> AgentRunConfiguration {
    AgentRunConfiguration(conversationID: "c1", model: "m", system: "sys", mode: mode, effort: .low)
}

private func eOutcome(_ events: [AgentEvent]) -> RunOutcome? {
    if case .finished(let o) = events.last { return o }
    return nil
}

/// Emits one event, then stays silent forever: a long reasoning pause.
private struct SilentProvider: ModelProvider {
    let flavor: ProviderFlavor = .anthropicMessages
    let capabilities = Capabilities()
    func listModels() async throws -> [ModelInfo] { [] }
    func stream(_ request: ProviderRequest) -> AsyncThrowingStream<ProviderEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.yield(.textDelta(index: 0, text: "thinking…"))
        }
    }
}

private final class FlagFlippingApprover: ApprovalHandler, Sendable {
    let flag: FlagBox
    init(flag: FlagBox) { self.flag = flag }
    func decide(_ request: ApprovalRequest) async -> ApprovalDecision {
        flag.set()
        return .allowOnce
    }
}

/// A shareable boolean flag for stop tests.
private final class FlagBox: Sendable {
    private let box = Mutex(false)
    var value: Bool { box.withLock { $0 } }
    func set() { box.withLock { $0 = true } }
}
