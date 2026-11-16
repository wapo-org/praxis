import XCTest

/// Guards against ViewThatFits+TableGrid re-measure hangs in LazyVStack; UI must stay responsive.
final class TableScrollHangUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testOpenDetailThenScrollTablesDoesNotHang() {
        let app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES"]
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

        app.swipeDown()
        app.swipeDown()
        let toggle = app.buttons["Show agent activity"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.tap()
        let steps = app.descendants(matching: .any).matching(identifier: "activityStep")
        XCTAssertTrue(steps.firstMatch.waitForExistence(timeout: 10), "step rows should list")
        let search = steps.matching(NSPredicate(format: "label CONTAINS[c] %@", "search")).firstMatch
        if search.waitForExistence(timeout: 5) { search.tap() }

        for i in 0..<6 {
            app.swipeUp()
            XCTAssertTrue(
                app.textViews["Message"].waitForExistence(timeout: 5)
                    || app.textFields["Message"].waitForExistence(timeout: 1),
                "swipe \(i): UI must answer within 5 s")
        }
    }
}
