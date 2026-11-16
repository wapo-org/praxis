import XCTest

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
