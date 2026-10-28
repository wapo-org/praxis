import XCTest

/// Hang probe: opening a call's details and then scrolling the tables into
/// view used to wedge the main thread for 30 s or more (ViewThatFits +
/// TableGrid re-measuring inside the transcript LazyVStack). Part of the
/// regular suite: after every swipe the UI must answer within 5 s.
final class TableScrollHangUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testOpenDetailThenScrollTablesDoesNotHang() {
        let app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES", "-PraxisEngine", "demo"]
        app.launch()

        XCTAssertTrue(app.buttons["New chat"].waitForExistence(timeout: 15))
        app.buttons["New chat"].tap()
        let field = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Make a table of the scrim options")
        app.buttons["Send message"].tap()

        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked for")).firstMatch.waitForExistence(timeout: 60),
            "activity should finish and read 'Worked for Ns'")
        XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 30),
                      "the run should finish before scrolling")

        // The finished run sits below the fold; scroll back to the top so
        // the activity header is in the accessibility tree.
        app.swipeDown()
        app.swipeDown()
        // Expand the folded activity, then open one call's details.
        let toggle = app.buttons["Show agent activity"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.tap()
        let steps = app.descendants(matching: .any).matching(identifier: "activityStep")
        XCTAssertTrue(steps.firstMatch.waitForExistence(timeout: 10), "step rows should list")
        let search = steps.matching(NSPredicate(format: "label CONTAINS[c] %@", "search")).firstMatch
        if search.waitForExistence(timeout: 5) { search.tap() }

        // Scroll the tables into view. If the main thread wedges, the
        // hittability check below fails instead of hanging the suite.
        for i in 0..<6 {
            app.swipeUp()
            XCTAssertTrue(
                app.textViews["Message"].waitForExistence(timeout: 5)
                    || app.textFields["Message"].waitForExistence(timeout: 1),
                "swipe \(i): UI must answer within 5 s")
        }
    }
}
