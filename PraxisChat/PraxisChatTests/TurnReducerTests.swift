import XCTest
import AgentCore
@testable import PraxisChat

/// The reducer folds runtime events into one turn's blocks: grouping,
/// discards, commits, mapping and outcomes.
final class TurnReducerTests: XCTestCase {
    private var reducer = TurnReducer()
    private var turn = Turn(userText: "Do the thing")
    private let now = Date(timeIntervalSinceReferenceDate: 1_000)

    @discardableResult
    private func send(_ events: AgentEvent..., at time: Date? = nil) -> TurnReducer.Change {
        var change = TurnReducer.Change()
        for event in events { change.merge(reducer.reduce(event, into: &turn, at: time ?? now)) }
        return change
    }

    func testToolsGroupUntilTextThenANewActivityOpens() {
        send(.toolCallStarted(tool("a", .readFile)), .toolRunning(id: "a"),
             .toolFinished(id: "a", ToolCompletion(status: .succeeded, summary: "Read 2 files")),
             .toolCallStarted(tool("b", .webSearch)))
        XCTAssertEqual(turn.activities.count, 1)
        XCTAssertEqual(turn.activities[0].steps.map(\.toolCallID), ["a", "b"])
        XCTAssertTrue(turn.activities[0].isRunning)

        let opened = send(.textDelta(blockID: "1.0", text: "Hello "), .textDelta(blockID: "1.0", text: "world"),
                          at: now.addingTimeInterval(4))
        XCTAssertEqual(opened.openedText.count, 1)
        XCTAssertEqual(opened.appendedText.map(\.text).joined(), "Hello world")
        XCTAssertFalse(turn.activities[0].isRunning, "text closes the open activity")
        XCTAssertEqual(turn.activities[0].elapsed, 4, accuracy: 0.001)

        let closed = send(.textFinished(blockID: "1.0"))
        XCTAssertEqual(closed.closedText.first?.source, "Hello world")
        XCTAssertTrue(closed.effects.contains(.commit))

        send(.reasoningDelta(blockID: "2.r", text: "Checking the result"), .toolCallStarted(tool("c", .command)))
        XCTAssertEqual(turn.blocks.count, 3)
        XCTAssertEqual(turn.activities.count, 2)
        XCTAssertEqual(turn.activities[1].steps.map(\.kind), [.think, .command])
        XCTAssertEqual(turn.markdownSources, ["Hello world"])
    }

    func testStreamingTextDoesNotTouchTheTurnUntilItCloses() {
        send(.textDelta(blockID: "1.0", text: "Hel"))
        let snapshot = turn
        let change = send(.textDelta(blockID: "1.0", text: "lo"))
        XCTAssertFalse(change.effects.contains(.turn))
        XCTAssertEqual(turn, snapshot)
        XCTAssertEqual(reducer.streamingText(for: turn.blocks[0].id), "Hello")
    }

    func testAttemptDiscardedRemovesItsBlocksAndSteps() {
        send(.toolCallStarted(tool("keep", .readFile)),
             .textDelta(blockID: "1.0", text: "partial"),
             .toolCallStarted(tool("drop", .webFetch)))
        XCTAssertEqual(turn.blocks.count, 3)
        let change = send(.attemptDiscarded(blockIDs: ["1.0"], toolCallIDs: ["drop"]))
        XCTAssertEqual(change.discardedText.count, 1)
        XCTAssertEqual(turn.blocks.count, 1, "text gone, emptied activity gone")
        XCTAssertEqual(turn.activities[0].steps.map(\.toolCallID), ["keep"])
        // The discarded attempt's later events find nothing.
        send(.toolFinished(id: "drop", ToolCompletion(status: .succeeded, summary: "x")))
        XCTAssertEqual(turn.activities[0].steps.count, 1)
    }

    func testCommittedAppendsToTranscript() {
        turn.transcript = [.user("Do the thing")]
        let change = send(.committed([Message(role: .assistant, parts: [.text("Done")])]))
        XCTAssertTrue(change.effects.contains(.commit))
        XCTAssertEqual(turn.transcript.count, 2)
        XCTAssertEqual(turn.transcript.last?.text, "Done")
    }

    func testCategoryMapping() {
        XCTAssertEqual(TurnReducer.kind(for: tool("1", .integration)), .integration)
        XCTAssertEqual(TurnReducer.kind(for: tool("2", .command)), .command)
        XCTAssertEqual(TurnReducer.kind(for: tool("3", .webSearch)), .webSearch)
        XCTAssertEqual(TurnReducer.kind(for: tool("4", .webFetch)), .webFetch)
        XCTAssertEqual(TurnReducer.kind(for: tool("5", .readFile)), .readFile)
        XCTAssertEqual(TurnReducer.kind(for: tool("6", .skill)), .skill)
        XCTAssertEqual(TurnReducer.kind(for: tool("7", .edit, name: "edit_files")), .edits)
        XCTAssertEqual(TurnReducer.kind(for: tool("8", .other, name: "lookup")), .tool)
    }

    func testCommandOutputIsCappedAndCounted() {
        send(.toolCallReady(tool("cmd", .command, name: "run_javascript", arguments: ["code": "log()"],
                                 source: .javascript)),
             .toolRunning(id: "cmd"))
        let lines = (1...250).map { "line \($0)" }
        send(.toolProgress(id: "cmd", .output(Array(lines[..<120]))),
             .toolProgress(id: "cmd", .output(Array(lines[120...]))))
        let command = turn.activities[0].steps[0].command
        XCTAssertEqual(command?.code, "log()")
        XCTAssertEqual(command?.language, "javascript")
        XCTAssertEqual(command?.lines.count, CommandData.maxLines)
        XCTAssertEqual(command?.droppedLineCount, 50)
        XCTAssertEqual(command?.lines.first, "line 51")
        XCTAssertEqual(command?.totalLineCount, 250)
        XCTAssertEqual(command?.startedAt, now)

        let change = send(.toolFinished(id: "cmd", ToolCompletion(status: .failed, summary: "Threw", preview: "Error: x")),
                          at: now.addingTimeInterval(2))
        XCTAssertTrue(change.effects.contains(.commandFailed))
        let finished = turn.activities[0].steps[0]
        XCTAssertEqual(finished.status, .failed)
        XCTAssertEqual(finished.finalSummary, "Threw")
        XCTAssertEqual(finished.command?.exitCode, 1)
        XCTAssertEqual(finished.command?.result, "Error: x")
        XCTAssertEqual(finished.command?.duration ?? 0, 2, accuracy: 0.001)
        XCTAssertEqual(finished.command?.isRunning, false)
    }

    func testTracesAndStatus() {
        send(.toolCallStarted(tool("s", .skill)), .toolRunning(id: "s"),
             .toolProgress(id: "s", .trace(.skill, "praxis-ui · audit")),
             .toolProgress(id: "s", .trace(.api, "GET /x → 200")),
             .toolProgress(id: "s", .status("Halfway…")))
        let step = turn.activities[0].steps[0]
        XCTAssertEqual(step.traces.map(\.kind), [.skill, .api])
        XCTAssertEqual(step.runningSummary, "Halfway…")
        XCTAssertEqual(step.status, .running)
    }

    func testTracesAreCappedAndNewestSurvive() {
        send(.toolCallStarted(tool("t", .webSearch)), .toolRunning(id: "t"))
        for i in 1...10_000 { send(.toolProgress(id: "t", .trace(.api, "trace \(i)"))) }
        let step = turn.activities[0].steps[0]
        XCTAssertEqual(Step.maxTraces, 200)
        XCTAssertEqual(step.traces.count, Step.maxTraces)
        XCTAssertEqual(step.droppedTraceCount, 10_000 - Step.maxTraces)
        XCTAssertEqual(step.totalTraceCount, 10_000)
        XCTAssertEqual(step.traces.first?.text, "trace \(10_001 - Step.maxTraces)")
        XCTAssertEqual(step.traces.last?.text, "trace 10000")
        let size = (try? JSONEncoder().encode(step).count) ?? .max
        XCTAssertLessThan(size, 100_000, "a capped step stays small on disk")
    }

    func testStepWithoutDroppedCountStillDecodes() throws {
        // Conversations persisted before the trace cap have no dropped
        // key; they must still decode with a zero count.
        let old = try JSONDecoder().decode(Step.self, from: Data("""
            {"id":"00000000-0000-0000-0000-000000000000","kind":"tool",\
            "runningSummary":"r","finalSummary":"f","status":"succeeded","traces":[]}
            """.utf8))
        XCTAssertEqual(old.droppedTraceCount, 0)
        XCTAssertTrue(old.traces.isEmpty)
        // And a persisted count round-trips.
        let coded = try JSONDecoder().decode(Step.self, from: Data("""
            {"id":"00000000-0000-0000-0000-000000000000","kind":"tool",\
            "runningSummary":"r","finalSummary":"f","status":"succeeded","traces":[],\
            "storedDroppedTraceCount":9800}
            """.utf8))
        XCTAssertEqual(coded.droppedTraceCount, 9800)
        XCTAssertEqual(coded.totalTraceCount, 9800)
    }

    func testImageTracesReferenceTurnAttachments() {
        let shot = Attachment(kind: .screenshot, name: "Screenshot 3")
        turn.attachments = [Attachment(kind: .photo, name: "Other"), shot]
        send(.toolCallStarted(tool("v", .readFile)), .toolProgress(id: "v", .trace(.image, "Screenshot 3")))
        XCTAssertEqual(turn.activities[0].steps[0].traces.first?.attachment?.id, shot.id)
    }

    func testApprovalCardOpensActivityAndResolves() {
        send(.toolCallReady(tool("m", .integration, name: "merge", arguments: ["pr": 42])))
        turn.updateActivity(at: 0) { $0.isExpanded = false }
        let request = ApprovalRequest(id: "m", toolName: "merge", source: .mcp(serverID: "gh", serverName: "GitHub"),
                                      arguments: ["pr": 42], reason: "May change or delete data", title: "Merge #42")
        let asked = send(.toolAwaitingApproval(request))
        XCTAssertEqual(asked.approvalIDs, ["m"])
        XCTAssertTrue(asked.effects.contains(.approvalRequested))
        var step = turn.activities[0].steps[0]
        XCTAssertEqual(step.status, .awaitingApproval)
        XCTAssertEqual(step.approval?.sourceName, "GitHub")
        XCTAssertTrue(step.approval?.arguments.contains("\"pr\"") ?? false)
        XCTAssertTrue(turn.activities[0].isExpanded, "the card must be visible")

        let resolved = send(.toolApprovalResolved(id: "m", decision: .deny),
                            .toolFinished(id: "m", ToolCompletion(status: .denied, summary: "Left it open")),
                            .policyUpdated(alwaysAllowKey: "k"))
        XCTAssertEqual(resolved.resolvedApprovalIDs, ["m"])
        XCTAssertEqual(resolved.alwaysAllowKeys, ["k"])
        step = turn.activities[0].steps[0]
        XCTAssertNil(step.approval)
        XCTAssertEqual(step.status, .denied)
        XCTAssertEqual(step.finalSummary, "Left it open")
    }

    func testNestedApprovalLandsOnTheParentStep() {
        send(.toolCallReady(tool("js1", .command, name: "run_javascript", arguments: ["code": "x()"])))
        let request = ApprovalRequest(id: "js1/inner", toolName: "delete", source: .mcp(serverID: "a", serverName: "A"),
                                      arguments: [:], reason: "Destructive", title: "Delete it")
        send(.toolAwaitingApproval(request))
        XCTAssertEqual(turn.activities[0].steps.count, 1)
        // Found by the id prefix (no parentCallID): still the parent's card.
        XCTAssertEqual(turn.activities[0].steps[0].codeApprovals.map(\.requestID), ["js1/inner"])
        XCTAssertNil(turn.activities[0].steps[0].approval, "the run's own row isn't the one asking")
        send(.toolApprovalResolved(id: "js1/inner", decision: .allowOnce))
        XCTAssertTrue(turn.activities[0].steps[0].codeApprovals.isEmpty)
    }

    func testParallelCodeApprovalsEachGetACardInTheRunStep() {
        send(.toolCallReady(tool("js1", .command, name: "run_javascript", arguments: ["code": "Promise.all(…)"])),
             .toolRunning(id: "js1"))
        let acme = ToolSource.mcp(serverID: "acme", serverName: "Acme")
        let first = ApprovalRequest(id: "js1/aaaa", toolName: "delete_repo", source: acme, arguments: ["repo": "a"],
                                    reason: "Destructive", title: "Delete a", parentCallID: "js1")
        let second = ApprovalRequest(id: "js1/bbbb", toolName: "delete_repo", source: acme, arguments: ["repo": "b"],
                                     reason: "Destructive", title: "Delete b", parentCallID: "js1")
        let change = send(.toolAwaitingApproval(first), .toolAwaitingApproval(second))
        XCTAssertEqual(change.approvalIDs, ["js1/aaaa", "js1/bbbb"])
        var step = turn.activities[0].steps[0]
        XCTAssertEqual(turn.activities[0].steps.count, 1, "no extra rows for calls made from code")
        XCTAssertEqual(step.codeApprovals.map(\.requestID), ["js1/aaaa", "js1/bbbb"])
        XCTAssertEqual(step.codeApprovals.first?.parentCallID, "js1")
        XCTAssertEqual(step.codeApprovals.first?.sourceName, "Acme")
        XCTAssertEqual(step.status, .running, "the run keeps running while its calls wait")
        XCTAssertTrue(step.isWaitingOnUser)

        send(.toolApprovalResolved(id: "js1/aaaa", decision: .deny))
        step = turn.activities[0].steps[0]
        XCTAssertEqual(step.codeApprovals.map(\.requestID), ["js1/bbbb"])
        XCTAssertEqual(step.traces.last?.text, "Declined: Acme · delete_repo")
        XCTAssertEqual(step.status, .running)

        // Finishing the run clears anything still asking.
        send(.toolFinished(id: "js1", ToolCompletion(status: .succeeded, summary: "Ran code")))
        XCTAssertTrue(turn.activities[0].steps[0].codeApprovals.isEmpty)
        XCTAssertFalse(turn.activities[0].steps[0].isWaitingOnUser)
    }

    func testFinishedOutcomes() {
        send(.toolCallStarted(tool("a", .readFile)), .toolRunning(id: "a"), .textDelta(blockID: "1", text: "  Partial  "))
        let change = send(.finished(.cancelled), at: now.addingTimeInterval(3))
        XCTAssertTrue(change.effects.contains(.finished))
        XCTAssertEqual(turn.outcome, .stopped)
        XCTAssertEqual(turn.outcome?.note, "Stopped")
        XCTAssertTrue(turn.isFinished)
        XCTAssertFalse(turn.isRunning)
        XCTAssertEqual(turn.activities[0].steps[0].status, .cancelled)
        XCTAssertEqual(turn.markdownSources, ["Partial"], "streamed text is written into its block")

        XCTAssertEqual(TurnOutcome(.truncated).note, "Cut off — the answer hit the output limit")
        XCTAssertEqual(TurnOutcome(.refused("cyber")).note, "Declined to answer (cyber)")
        XCTAssertEqual(TurnOutcome(.failed("HTTP 500")).note, "Couldn't finish: HTTP 500")
        XCTAssertNil(TurnOutcome(.completed).note)
    }

    func testStopWhileActivityRunsMarksItStopped() {
        send(.toolCallStarted(tool("a", .readFile)))
        _ = reducer.finish(&turn, outcome: .stopped, at: now.addingTimeInterval(5))
        XCTAssertTrue(turn.activities[0].isStopped)
        XCTAssertEqual(turn.activities[0].label, "Stopped after 5s")
    }

    func testEmptyTextBlockIsDropped() {
        send(.textDelta(blockID: "1", text: "  \n "))
        let change = send(.textFinished(blockID: "1"))
        XCTAssertTrue(turn.blocks.isEmpty)
        XCTAssertEqual(change.discardedText.count, 1)
    }
}
