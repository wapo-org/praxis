import XCTest

/// Tool-support screenshot probe (not part of the regular suite): holds the
/// chat screen (composer hint row) and the provider profile editor with the
/// model "Choose" menu open, while the host takes `simctl io screenshot`s.
/// Skipped unless `PRAXIS_TOOLSHOTS` is set. Each pose prints
/// `TOOLSHOTS <label>`. Needs a seeded Providers.json (a live profile with
/// a cached no-tools model); never passes `-PraxisResetData`.
final class ToolSupportShots: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_TOOLSHOTS"] != nil, "Optional tool capture requires PRAXIS_TOOLSHOTS; cloud tool behavior runs in CloudUITests")
        continueAfterFailure = true
    }

    private func mark(_ label: String) {
        print("TOOLSHOTS \(label) \(Date().timeIntervalSince1970)", terminator: "\n")
    }

    private func hold(_ label: String, _ seconds: TimeInterval = 8.0) {
        mark(label)
        Thread.sleep(forTimeInterval: seconds)
    }

    func testToolShots() {
        app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
        hold("composer")

        app.buttons["History"].tap()
        XCTAssertTrue(app.buttons["History options"].waitForExistence(timeout: 5))
        app.buttons["History options"].tap()
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts["Tools"].waitForExistence(timeout: 5))

        let profile = app.buttons["Test provider, in use"]
        XCTAssertTrue(profile.waitForExistence(timeout: 5))
        profile.tap()
        let choose = app.buttons["Choose model"]
        for _ in 0..<6 where !choose.isHittable {
            app.swipeUp()
            Thread.sleep(forTimeInterval: 0.4)
        }
        XCTAssertTrue(choose.waitForExistence(timeout: 5))
        hold("profile-editor")
        choose.tap()
        Thread.sleep(forTimeInterval: 1.0)
        hold("model-menu")
    }
}
