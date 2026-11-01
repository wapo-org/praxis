import XCTest

/// Blur verification probe (not part of the regular suite): holds poses
/// with transcript text behind the title/model (top scrim) and behind the
/// composer (bottom scrim) while the host takes `simctl io screenshot`s.
/// Skipped unless `PRAXIS_BLURSHOTS` is set
/// (`TEST_RUNNER_PRAXIS_BLURSHOTS=1 xcodebuild test -only-testing:…/BlurShots`).
/// Each pose prints a wall-clock marker: `BLURSHOTS <label> <epoch>`.
final class BlurShots: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_BLURSHOTS"] != nil, "Optional blur capture requires PRAXIS_BLURSHOTS; not a functional feature skip")
        continueAfterFailure = true
    }

    private func mark(_ label: String) {
        print("BLURSHOTS \(label) \(Date().timeIntervalSince1970)", terminator: "\n")
    }

    private func launch() {
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES", "-PraxisLongThread", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.0)
    }

    /// Text behind the title and model name: as launched, then scrolled
    /// up one and two pages.
    func testTopScrim() {
        launch()
        mark("top-as-launched")
        Thread.sleep(forTimeInterval: 5.0)
        app.swipeDown()
        Thread.sleep(forTimeInterval: 1.0)
        mark("top-scrolled-1")
        Thread.sleep(forTimeInterval: 5.0)
        app.swipeDown()
        Thread.sleep(forTimeInterval: 1.0)
        mark("top-scrolled-2")
        Thread.sleep(forTimeInterval: 5.0)
    }

    /// Text behind the composer: near the bottom, then a page up.
    func testBottomScrim() {
        launch()
        app.swipeUp()
        Thread.sleep(forTimeInterval: 1.0)
        mark("bottom-near-bottom")
        Thread.sleep(forTimeInterval: 5.0)
        app.swipeDown()
        Thread.sleep(forTimeInterval: 1.0)
        app.swipeDown()
        Thread.sleep(forTimeInterval: 1.0)
        mark("bottom-page-up")
        Thread.sleep(forTimeInterval: 5.0)
    }
}
