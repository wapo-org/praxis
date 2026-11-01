import XCTest
import AgentCore
@testable import PraxisChat

/// The activity's row model (`StepPresentation`'s `Step` extension): every
/// call reads as one line, only lines with something behind them open,
/// and the folded header follows the call running now.
final class ActivityLineTests: XCTestCase {

    private func step(_ status: Step.Status = .succeeded, source: String? = nil, title: String? = "Web search",
                      detail: String? = nil, running: String = "Searching the web…",
                      final: String = "Web search") -> Step {
        Step(kind: .webSearch, runningSummary: running, finalSummary: final, status: status,
             source: source, title: title, detail: detail)
    }

    func testLineIsOneLineWhateverTheToolSent() {
        var s = step(source: "Exa", detail: "recent AI\n\nbreakthroughs")
        s.title = "Web\nsearch"
        XCTAssertFalse(s.lineBody.contains("\n"), s.lineBody)
        XCTAssertEqual(s.lineBody, "Web search: recent AI breakthroughs")
        // The source isn't repeated in the body; the view sets it in medium weight.
        XCTAssertFalse(s.lineBody.contains("Exa"))
    }

    func testRunningLineDropsTheTrailingEllipsisBeforeItsDetail() {
        let s = step(.running, detail: "swift 6 concurrency")
        XCTAssertEqual(s.lineBody, "Searching the web: swift 6 concurrency")
    }

    func testRunningCommandShowsItsNewestOutputLine() {
        var s = Step(kind: .command, runningSummary: "Running tests…", finalSummary: "Ran tests", status: .running)
        s.command = CommandData(code: "swift test", lines: ["Building…", "Test Suite 'All tests' started\n  at 12:00"],
                                isRunning: true)
        XCTAssertEqual(s.lineBody, "Running tests: Test Suite 'All tests' started at 12:00")
    }

    func testLineWithNothingBehindItDoesNotOpen() {
        let bare = step()
        XCTAssertFalse(bare.hasDetails)
        XCTAssertFalse(bare.isOpen)
    }

    func testParametersResultsErrorsAndCommandsOpen() {
        var withArgs = step()
        withArgs.arguments = "{\n  \"query\": \"x\"\n}"
        XCTAssertTrue(withArgs.hasDetails)

        var failed = step(.failed)
        failed.result = "HTTP 500"
        XCTAssertTrue(failed.hasDetails)
        XCTAssertEqual(failed.statusTag, "Failed")

        var command = Step(kind: .command, runningSummary: "Running…", finalSummary: "Ran it")
        command.command = CommandData(code: "ls")
        XCTAssertTrue(command.hasDetails)

        // An empty result is not a detail.
        var empty = step()
        empty.result = ""
        XCTAssertFalse(empty.hasDetails)
    }

    func testCallShapedTraceRepeatsTheInputSoItIsNotADetail() {
        var s = step()
        s.traces = [Trace(kind: .api, text: "exa.web_search_exa({\"query\":\"x\"})")]
        XCTAssertTrue(s.visibleTraces.isEmpty)
        XCTAssertFalse(s.hasDetails)
        // Under code, each call trace is a call the script made.
        s.command = CommandData(code: "await exa.search()")
        XCTAssertEqual(s.visibleTraces.count, 1)
    }

    func testOpenStateLivesInTheModel() {
        var s = step()
        s.arguments = "{}"
        s.detailsOpen = true
        XCTAssertTrue(s.isOpen)
        var command = Step(kind: .command, runningSummary: "Running…", finalSummary: "Ran it")
        command.command = CommandData(code: "ls", isExpanded: true)
        XCTAssertTrue(command.isOpen, "a command's card keeps its own flag")
    }

    func testFoldedHeaderFollowsTheCallRunningNow() {
        var activity = ActivityData(steps: [step(), step(.running, title: "Read file"), step(.pending, title: "Fetch")],
                                    isRunning: true)
        XCTAssertEqual(activity.liveStep?.title, "Fetch", "the newest running call")
        activity.steps[2].status = .succeeded
        XCTAssertEqual(activity.liveStep?.title, "Read file")
        activity.steps[1].status = .succeeded
        XCTAssertEqual(activity.liveStep?.title, "Fetch", "nothing running: the newest call")
        activity.isRunning = false
        XCTAssertNil(activity.liveStep, "a finished activity reads only 'Worked for…'")
    }

    func testRunsStartFolded() {
        var reducer = TurnReducer()
        var turn = Turn(userText: "Search")
        _ = reducer.reduce(.toolCallStarted(tool("a", .webSearch)), into: &turn, at: Date())
        XCTAssertEqual(turn.activities.count, 1)
        XCTAssertFalse(turn.activities[0].isExpanded, "the header line carries progress; the list is a tap away")
    }
}
