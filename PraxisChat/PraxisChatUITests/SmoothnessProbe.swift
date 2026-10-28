import XCTest

/// Temporary measurement probe: replays the recorded scenario (new chat →
/// "Why is my build failing?" → full run) while simctl records the screen.
final class SmoothnessProbe: XCTestCase {
    func testProbeBuildFailingRun() {
        let app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES"]
        app.launch()
        let newChat = app.buttons["New chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 15))
        newChat.tap()
        let suggestion = app.buttons["Why is my build failing?"]
        XCTAssertTrue(suggestion.waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 1.0)
        suggestion.tap()
        Thread.sleep(forTimeInterval: 14)
    }

    func testProbeTrayConnectors() {
        let app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES"]
        app.launch()
        let plus = app.buttons["Add photos, files and more"]
        XCTAssertTrue(plus.waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.0)
        plus.tap()
        let tray = app.scrollViews["plusTray"]
        XCTAssertTrue(tray.waitForExistence(timeout: 5))
        Thread.sleep(forTimeInterval: 1.0)
        let connectors = app.buttons["Connectors"]
        if !connectors.isHittable { tray.swipeUp(); Thread.sleep(forTimeInterval: 0.8) }
        connectors.tap()
        Thread.sleep(forTimeInterval: 1.5)
        app.buttons["Back"].tap()
        Thread.sleep(forTimeInterval: 1.5)
    }

    // TEMP (send flight / command clip check)
    func testProbeSendFlightAndCommandToggle() {
        let app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES"]
        app.launch()
        let newChat = app.buttons["New chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 15))
        newChat.tap()
        let field = app.textFields["Message"].exists ? app.textFields["Message"] : app.textViews["Message"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Why is my build failing?")
        Thread.sleep(forTimeInterval: 1.0)
        print("PROBE send \(Date().timeIntervalSince1970)")
        app.buttons["Send message"].tap()
        Thread.sleep(forTimeInterval: 16)
        let show = app.buttons["Show agent activity"]
        XCTAssertTrue(show.waitForExistence(timeout: 10))
        show.tap()
        Thread.sleep(forTimeInterval: 1.5)
        let showCmd = app.buttons["Show command details: Ran the test suite — 1 failure"]
        XCTAssertTrue(showCmd.waitForExistence(timeout: 5))
        showCmd.tap()
        Thread.sleep(forTimeInterval: 1.5)
        print("PROBE collapse \(Date().timeIntervalSince1970)")
        let hide = app.buttons["Hide command details: Ran the test suite — 1 failure"]
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        hide.tap()
        Thread.sleep(forTimeInterval: 1.5)
        print("PROBE expand \(Date().timeIntervalSince1970)")
        app.buttons["Show command details: Ran the test suite — 1 failure"].tap()
        Thread.sleep(forTimeInterval: 1.5)
    }
}
