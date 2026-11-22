import XCTest

/// Perf probe gated on PRAXIS_PERF; avoid querying the app mid-window as AX snapshots add app CPU.
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
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_PERF"] != nil, "Optional performance measurement requires PRAXIS_PERF")
    }

    func testPerfDemoRun() {
        let app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES"]
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

    func testPerfLongThread() {
        let app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES", "-PraxisLongThread", "YES"]
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
