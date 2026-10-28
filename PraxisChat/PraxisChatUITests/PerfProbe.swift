import XCTest

/// CPU measurement probe (not part of the regular suite): scripted runs a
/// host-side sampler measures. Skipped unless `PRAXIS_PERF` is set
/// (`TEST_RUNNER_PRAXIS_PERF=1 xcodebuild test -only-testing:…/PerfProbe`).
/// Each phase writes a wall-clock marker so the sampler's CPU-time deltas
/// can be cut to exactly that window. Nothing queries the app inside a
/// window: accessibility snapshots would add app CPU of their own.
final class PerfProbe: XCTestCase {
    private func mark(_ label: String) {
        let line = "\(label) \(Date().timeIntervalSince1970)\n"
        print("PERF \(line)", terminator: "")
        let url = URL(fileURLWithPath: "/tmp/praxis-perf/markers.txt")
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: url)
        }
    }

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_PERF"] != nil, "perf probe")
    }

    /// New chat → "Research progressive blur" → the whole run (activity,
    /// then the streamed answer), then the settled thread.
    func testPerfDemoRun() {
        let app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES"]
        app.launch()
        let newChat = app.buttons["New chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 15))
        newChat.tap()
        let suggestion = app.buttons["Research progressive blur"]
        XCTAssertTrue(suggestion.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 2)
        suggestion.tap()
        mark("run-start")
        Thread.sleep(forTimeInterval: 16)
        mark("run-end")
        Thread.sleep(forTimeInterval: 2)
        mark("settled-start")
        Thread.sleep(forTimeInterval: 8)
        mark("settled-end")
    }

    /// The long seeded thread, untouched: idle cost of a big transcript.
    /// Then a retry of its last turn: a run at the bottom of a long thread.
    func testPerfLongThread() {
        let app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES", "-PraxisLongThread", "YES"]
        app.launch()
        let retry = app.buttons.matching(identifier: "Retry")
        XCTAssertTrue(retry.firstMatch.waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 3)
        mark("idle-start")
        Thread.sleep(forTimeInterval: 10)
        mark("idle-end")
        retry.allElementsBoundByIndex.last?.tap()
        mark("retry-start")
        Thread.sleep(forTimeInterval: 14)
        mark("retry-end")
        Thread.sleep(forTimeInterval: 2)
        mark("after-start")
        Thread.sleep(forTimeInterval: 10)
        mark("after-end")
    }
}
