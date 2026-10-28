import XCTest

/// Screenshot probe for the activity levels and markdown tables (not part of
/// the regular suite). Skipped unless `PRAXIS_SHOTS` is set
/// (`TEST_RUNNER_PRAXIS_SHOTS=1 xcodebuild test -only-testing:…/ActivityShots`).
/// Writes PNGs to /tmp/praxis-activity-shots/.
final class ActivityShots: XCTestCase {
    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_SHOTS"] != nil, "activity shots")
        continueAfterFailure = true
    }

    func testShots() throws {
        let app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES", "-PraxisEngine", "demo"]
        app.launch()
        try? FileManager.default.createDirectory(atPath: "/tmp/praxis-activity-shots", withIntermediateDirectories: true)
        func save(_ name: String) {
            let png = app.screenshot().pngRepresentation
            try? png.write(to: URL(fileURLWithPath: "/tmp/praxis-activity-shots/\(name).png"))
        }
        XCTAssertTrue(app.buttons["New chat"].waitForExistence(timeout: 15))
        app.buttons["New chat"].tap()
        let field = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Make a table of the scrim options")
        app.buttons["Send message"].tap()
        for i in 0..<10 { Thread.sleep(forTimeInterval: 0.25); save("0-running-\(i)") }
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.30))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75))
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.1)
        for i in 0..<8 {
            Thread.sleep(forTimeInterval: 0.5)
            save("1-running-collapsed-\(i)")
        }
        // Open while running too.
        let show = app.buttons["Show agent activity"].firstMatch
        if show.exists { show.tap(); Thread.sleep(forTimeInterval: 0.8); save("2-running-list") }
        XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 60))
        Thread.sleep(forTimeInterval: 1.0)
        // Collapse first: 3-finished-top is the finished FOLDED header.
        let hide = app.buttons["Hide agent activity"].firstMatch
        if hide.exists && hide.isHittable { hide.tap(); Thread.sleep(forTimeInterval: 0.8) }
        app.swipeDown(); app.swipeDown()
        Thread.sleep(forTimeInterval: 0.8)
        save("3-finished-top")
        let toggle = app.buttons["Show agent activity"].firstMatch
        if toggle.exists && toggle.isHittable { toggle.tap(); Thread.sleep(forTimeInterval: 0.8) }
        save("4-list")
        let steps = app.descendants(matching: .any).matching(identifier: "activityStep")
        print("SHOTS steps:", (0..<steps.count).map { steps.element(boundBy: $0).label })
        let search = steps.matching(NSPredicate(format: "label CONTAINS[c] %@", "search")).firstMatch
        if search.exists { search.tap(); Thread.sleep(forTimeInterval: 0.8) }
        save("5-detail")
        app.swipeUp()
        Thread.sleep(forTimeInterval: 0.8)
        save("6-table")
        app.swipeUp()
        Thread.sleep(forTimeInterval: 0.8)
        save("7-table-wide")
        let cell = app.staticTexts["Regular glass"].firstMatch
        print("SHOTS cell exists:", cell.exists)
        if cell.exists { cell.swipeLeft(); Thread.sleep(forTimeInterval: 1.0); save("8-table-wide-scrolled") }
        app.swipeUp()
        Thread.sleep(forTimeInterval: 0.8)
        save("9-tasks-quote")
    }
}
