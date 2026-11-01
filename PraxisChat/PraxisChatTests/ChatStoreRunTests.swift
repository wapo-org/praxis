import XCTest
import Synchronization
import AgentCore
import AgentRuntime
@testable import PraxisChat

/// Runs are per conversation; edit/delete/retry stop the runs they
/// remove; approvals resolve through the store.
@MainActor
final class ChatStoreRunTests: XCTestCase {

    /// Opens one tool step, then holds the run open until it's stopped.
    private func holdingEngine() -> ScriptedChatEngine {
        ScriptedChatEngine { _ in
            let call = tool("held-\(UUID().uuidString.prefix(4))", .readFile)
            return [.event(.iterationStarted(1)), .event(.toolCallStarted(call)),
                    .event(.toolRunning(id: call.id)), .hold]
        }
    }

    private func store(_ engine: any ChatEngine, chats: Int = 2) -> ChatStore {
        let store = ChatStore(engine: engine, conversations: (0..<chats).map { Conversation(title: "Chat \($0)") })
        store.coalesceInterval = .milliseconds(5)
        return store
    }

    func testSendingInAnotherChatDoesNotStopTheFirst() async throws {
        let store = store(holdingEngine())
        let a = store.conversations[0], b = store.conversations[1]
        store.select(a.id)
        store.send(text: "first")
        store.select(b.id)
        store.send(text: "second")
        XCTAssertTrue(store.isRunning(a.id))
        XCTAssertTrue(store.isRunning(b.id))
        await waitUntil { !a.turns[0].blocks.isEmpty && !b.turns[0].blocks.isEmpty }

        // Stop reflects (and acts on) the selected chat only.
        store.stop()
        XCTAssertFalse(store.isRunning(b.id))
        XCTAssertTrue(store.isRunning(a.id))
        XCTAssertEqual(b.turns[0].outcome, .stopped)
        XCTAssertNil(a.turns[0].outcome)

        store.select(a.id)
        XCTAssertTrue(store.isRunning)
        store.stop()
        XCTAssertFalse(store.isRunning)
    }

    func testEditStopsTheRunningTurnItRemoves() async {
        let store = store(holdingEngine(), chats: 1)
        let conv = store.conversations[0]
        store.send(text: "draft me")
        let turnID = conv.turns[0].id
        XCTAssertTrue(store.isRunning)
        store.edit(turnID: turnID)
        XCTAssertFalse(store.isRunning)
        XCTAssertTrue(conv.turns.isEmpty)
        XCTAssertEqual(store.draft, "draft me")
    }

    func testDeletingAChatStopsItsRun() async {
        let store = store(holdingEngine())
        let a = store.conversations[0], b = store.conversations[1]
        store.select(a.id)
        store.send(text: "doomed")
        store.select(b.id)
        store.send(text: "survivor")
        store.deleteConversations([a.id])
        XCTAssertFalse(store.isRunning(a.id))
        XCTAssertTrue(store.isRunning(b.id))
        XCTAssertEqual(store.conversations.map(\.id), [b.id])
        store.stop()
    }

    func testDemoRunCompletesWithTranscript() async throws {
        let store = store(DemoAgentEngine(timeScale: 0), chats: 1)
        let conv = store.conversations[0]
        store.effort = .high
        store.send(text: "Add haptics to buttons")
        await waitUntil { !store.isRunning }
        let turn = try XCTUnwrap(conv.turns.first)
        XCTAssertTrue(turn.isFinished)
        XCTAssertEqual(turn.outcome, .completed)
        XCTAssertEqual(turn.activities.count, 1)
        XCTAssertEqual(turn.activities[0].steps.first?.kind, .think, "High effort plans first")
        XCTAssertTrue(turn.activities[0].steps.allSatisfy { !$0.isRunning })
        XCTAssertTrue(turn.activities[0].steps.contains { $0.command?.exitCode == 0 })
        XCTAssertTrue(turn.markdownSources.first?.hasPrefix("## Haptics are in") ?? false)
        // User message (with the mode note), tool calls/results, answer.
        XCTAssertEqual(turn.transcript.first?.role, .user)
        XCTAssertTrue(turn.transcript.first?.parts.contains(.note(SystemPrompt.modeNote(mode: .auto, effort: .high))) ?? false)
        XCTAssertEqual(turn.transcript.last?.text, Scenarios.haptics.answer)
        XCTAssertTrue(turn.transcript.contains { !$0.toolCalls.isEmpty })
    }

    func testWebSearchOffDropsWebSteps() async throws {
        let store = store(DemoAgentEngine(timeScale: 0), chats: 1)
        store.webSearch = false
        store.effort = .max
        store.send(text: "Research progressive blur")
        await waitUntil { !store.isRunning }
        let turn = try XCTUnwrap(store.conversations[0].turns.first)
        let kinds = turn.activities.flatMap(\.steps).map(\.kind)
        XCTAssertFalse(kinds.contains(.webSearch) || kinds.contains(.webFetch), "\(kinds)")
    }

    func testFollowUpReplaysPriorTranscript() async throws {
        let seen = Mutex<[[Message]]>([])
        let engine = ScriptedChatEngine { request in
            seen.withLock { $0.append(request.transcript) }
            return [.event(.textDelta(blockID: "t", text: "ok")), .event(.textFinished(blockID: "t")),
                    .event(.committed([Message(role: .assistant, parts: [.text("ok")])])), .event(.finished(.completed))]
        }
        let store = store(engine, chats: 1)
        store.send(text: "one")
        await waitUntil { !store.isRunning }
        store.send(text: "two")
        await waitUntil { !store.isRunning }
        let second = try XCTUnwrap(seen.withLock { $0.last })
        XCTAssertEqual(second.map(\.role), [.user, .assistant, .user])
        XCTAssertEqual(second.last?.text, "two")
        XCTAssertFalse(second.last?.parts.contains { if case .note = $0 { return true }; return false } ?? true,
                       "the mode note isn't repeated while mode and effort stay the same")
    }

    // MARK: Approvals

    func testShipScenarioAsksAndAllowOnceMerges() async throws {
        let store = store(DemoAgentEngine(timeScale: 0), chats: 1)
        store.effort = .high
        store.send(text: "Merge the release PR")
        await waitUntil { !store.approvals.pendingIDs.isEmpty }
        let conv = store.conversations[0]
        await waitUntil { conv.turns[0].activities.flatMap(\.steps).contains { $0.approval != nil } }
        let pending = try XCTUnwrap(store.approvals.pendingIDs.first)
        let step = try XCTUnwrap(conv.turns[0].activities.flatMap(\.steps).first { $0.approval != nil })
        XCTAssertEqual(step.status, .awaitingApproval)
        XCTAssertEqual(step.approval?.title, "Merge pull request #42")

        store.resolveApproval(pending, decision: .allowOnce)
        await waitUntil { !store.isRunning }
        let turn = conv.turns[0]
        XCTAssertTrue(turn.markdownSources.first?.hasPrefix("## Merged") ?? false)
        XCTAssertEqual(turn.activities.flatMap(\.steps).last?.status, .succeeded)
        XCTAssertTrue(store.policy.alwaysAllow.isEmpty)
    }

    func testDenyTakesTheDeclinedPath() async throws {
        let store = store(DemoAgentEngine(timeScale: 0), chats: 1)
        store.send(text: "Ship it")
        await waitUntil { !store.approvals.pendingIDs.isEmpty }
        store.resolveApproval(try XCTUnwrap(store.approvals.pendingIDs.first), decision: .deny)
        await waitUntil { !store.isRunning }
        let turn = store.conversations[0].turns[0]
        XCTAssertTrue(turn.markdownSources.first?.hasPrefix("## Ready, not merged") ?? false)
        let merge = try XCTUnwrap(turn.activities.flatMap(\.steps).last)
        XCTAssertEqual(merge.status, .denied)
        XCTAssertEqual(merge.finalSummary, "Left #42 open — merge declined")
    }

    func testAlwaysAllowIsRememberedAndSkipsTheNextCard() async throws {
        let store = store(DemoAgentEngine(timeScale: 0), chats: 1)
        store.send(text: "Ship it")
        await waitUntil { !store.approvals.pendingIDs.isEmpty }
        store.resolveApproval(try XCTUnwrap(store.approvals.pendingIDs.first), decision: .allowAlways)
        await waitUntil { !store.isRunning }
        XCTAssertEqual(store.policy.alwaysAllow.count, 1)

        store.send(text: "Ship it again")
        await waitUntil { !store.isRunning }
        let second = store.conversations[0].turns[1]
        XCTAssertTrue(second.markdownSources.first?.hasPrefix("## Merged") ?? false)
        XCTAssertTrue(second.activities.flatMap(\.steps).allSatisfy { $0.approval == nil })
    }

    func testPlanModeRefusesTheMergeWithoutAsking() async throws {
        let store = store(DemoAgentEngine(timeScale: 0), chats: 1)
        store.mode = .plan
        store.send(text: "Ship it")
        await waitUntil { !store.isRunning }
        XCTAssertTrue(store.approvals.pendingIDs.isEmpty)
        let merge = try XCTUnwrap(store.conversations[0].turns[0].activities.flatMap(\.steps).last)
        XCTAssertEqual(merge.status, .denied)
    }

    func testStopDeniesAPendingApproval() async throws {
        let store = store(DemoAgentEngine(timeScale: 0), chats: 1)
        store.send(text: "Ship it")
        await waitUntil { !store.approvals.pendingIDs.isEmpty }
        store.stop()
        await waitUntil { store.approvals.pendingIDs.isEmpty }
        let turn = store.conversations[0].turns[0]
        XCTAssertEqual(turn.outcome, .stopped)
        XCTAssertTrue(turn.activities.flatMap(\.steps).allSatisfy { $0.approval == nil && !$0.isRunning })
    }

    func testApprovalCenterDeniesOnCancellation() async {
        let center = ApprovalCenter()
        let request = ApprovalRequest(id: "x", toolName: "t", source: .builtin, arguments: [:], reason: "r", title: "T")
        let task = Task { await center.decide(request) }
        await waitUntil { center.pendingIDs.contains("x") }
        task.cancel()
        let decision = await task.value
        XCTAssertEqual(decision, .deny)
        await waitUntil { center.pendingIDs.isEmpty }
    }

    func testApprovalCenterResolvesOnce() async {
        let center = ApprovalCenter()
        let request = ApprovalRequest(id: "y", toolName: "t", source: .builtin, arguments: [:], reason: "r", title: "T")
        let task = Task { await center.decide(request) }
        await waitUntil { center.pendingIDs.contains("y") }
        center.resolve("y", with: .allowAlways)
        center.resolve("y", with: .deny) // no-op
        let decision = await task.value
        XCTAssertEqual(decision, .allowAlways)
    }

    // MARK: Team C hardening (R3-H1, R3-H3, R3-M3, R3-M7)

    func testStopEndsAScriptedEngine() async throws {
        let store = store(holdingEngine(), chats: 1)
        let conv = store.conversations[0]
        store.send(text: "hold me")
        await waitUntil { !conv.turns[0].blocks.isEmpty }
        let pump = try XCTUnwrap(store.runs[conv.id]?.task)
        let done = Mutex(false)
        Task { await pump.value; done.withLock { $0 = true } }
        store.stop()
        // The engine sees the cancel flag, ends its stream, the pump unwinds.
        // (The pump has no other exit, so its completion proves the engine ended.)
        await waitUntil { done.withLock { $0 } }
        XCTAssertEqual(conv.turns[0].outcome, .stopped)
        await store.settle()
    }

    func testStopReleasesApprovalsThatNeverReachedADrain() async throws {
        let store = store(holdingEngine(), chats: 1)
        let conv = store.conversations[0]
        store.send(text: "hold")
        await waitUntil { store.isRunning }
        let handle = try XCTUnwrap(store.runs[conv.id])
        // An approval event arrives in the inbox, but no main-actor drain
        // runs before the stop: the waiter must still be released.
        let request = ApprovalRequest(id: "late-card", toolName: "tool", source: .builtin, arguments: [:],
                                      reason: "r", title: "T")
        _ = handle.inbox.push(.toolAwaitingApproval(request))
        let decisionBox = Mutex<ApprovalDecision?>(nil)
        Task {
            let decision = await store.approvals.decide(request)
            decisionBox.withLock { $0 = decision }
        }
        await waitUntil { store.approvals.pendingIDs.contains("late-card") }
        store.stop()
        await waitUntil { decisionBox.withLock { $0 != nil } }
        XCTAssertEqual(decisionBox.withLock { $0 }, .deny)
        XCTAssertTrue(store.approvals.pendingIDs.isEmpty)
        XCTAssertEqual(conv.turns[0].outcome, .stopped)
        await store.settle()
    }

    func testResendWhileRunningSettlesTheOldTurn() async throws {
        let store = store(holdingEngine(), chats: 1)
        let conv = store.conversations[0]
        store.send(text: "first")
        await waitUntil { !conv.turns[0].blocks.isEmpty }
        store.resend(turnID: conv.turns[0].id)
        XCTAssertEqual(conv.turns.count, 2)
        XCTAssertEqual(conv.turns[0].outcome, .stopped)
        XCTAssertTrue(conv.turns[0].isFinished)
        XCTAssertTrue(store.isRunning)
        store.stop()
        await waitUntil { !store.isRunning }
        await store.settle()
    }

    func testRefreezeKeepsPerChatToggles() async throws {
        struct FreezingEngine: ChatEngine {
            let kind: EngineKind = .live
            let setup: ConversationSetup
            func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent> {
                AsyncStream { continuation in
                    let task = Task {
                        await request.onSetup(setup, [])
                        continuation.yield(.finished(.completed))
                        continuation.finish()
                    }
                    continuation.onTermination = { _ in task.cancel() }
                }
            }
        }
        // A frozen setup with servers x and y (built through the public
        // Codable shape; the memberwise init is package-internal).
        let setupJSON = """
            {"version":1,"createdAt":784783194.0,"systemPrompt":"s","skillNames":[],
             "includesSkills":false,"includesJavaScript":false,
             "mcpServers":[{"id":"x","name":"X","tools":[]},{"id":"y","name":"Y","tools":[]}],
             "gatewayThreshold":128,"toolSpecs":[]}
            """.data(using: .utf8)!
        let setup = try JSONDecoder().decode(ConversationSetup.self, from: setupJSON)
        let store = store(FreezingEngine(setup: setup), chats: 1)
        let conv = store.conversations[0]
        conv.connectorIDs = ["x", "y"]
        conv.disabledServerIDs = ["x"]
        store.send(text: "hi")
        await waitUntil { !store.isRunning }
        // x stays off-here (still in the frozen setup); it must not vanish
        // from the toggle the way a re-freeze used to drop it.
        XCTAssertEqual(conv.disabledServerIDs, ["x"])
        XCTAssertNotNil(conv.setup)
        await store.settle()
    }
}
