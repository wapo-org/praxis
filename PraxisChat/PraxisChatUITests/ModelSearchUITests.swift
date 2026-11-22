import XCTest

final class ModelSearchUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES", "-PraxisDemoModels", "400"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
    }

    private func field(_ label: String) -> XCUIElement {
        let tv = app.textViews[label]
        return tv.exists ? tv : app.textFields[label]
    }

    private func openModelPage() {
        app.buttons["Add photos, files and more"].tap()
        let model = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model, ")).firstMatch
        XCTAssertTrue(model.waitForExistence(timeout: 15), "tray should open")
        model.tap()
        XCTAssertTrue(app.buttons["Atlas Mini, Fastest answers"].waitForExistence(timeout: 15),
                      "the model page should list the catalogue")
    }

    private func closeTray() {
        app.buttons["Close add menu"].tap()
        XCTAssertTrue(app.buttons["Add photos, files and more"].waitForExistence(timeout: 15),
                      "the tray should close")
    }

    /// Removal transitions keep views in the hierarchy briefly, so always await absence instead.
    private func waitForAbsence(_ element: XCUIElement, _ message: String, timeout: TimeInterval = 5) {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: element,
                               handler: nil)
        wait(for: [gone], timeout: timeout)
        XCTAssertFalse(element.exists, message)
    }

    func testSearchFiltersListAndRestoresDraft() {
        let draft = field("Message")
        draft.tap()
        draft.typeText("hello draft")

        openModelPage()
        let search = field("Search models")
        XCTAssertTrue(search.waitForExistence(timeout: 10), "the composer becomes the search field")
        waitForAbsence(app.buttons["Send message"], "no send button while searching")
        search.tap()
        search.typeText("mini")

        XCTAssertTrue(app.buttons["Atlas Mini, Fastest answers"].waitForExistence(timeout: 10))
        waitForAbsence(app.buttons["Atlas Pro, Deepest reasoning"], "non-matches are filtered out")
        XCTAssertTrue(app.buttons["Clear search"].waitForExistence(timeout: 5))

        app.buttons["Clear search"].tap()
        XCTAssertTrue(app.buttons["Atlas Pro, Deepest reasoning"].waitForExistence(timeout: 10))

        app.buttons["Back"].tap()
        XCTAssertTrue(field("Message").waitForExistence(timeout: 10))
        XCTAssertEqual(field("Message").value as? String, "hello draft")
        closeTray()
        XCTAssertEqual(field("Message").value as? String, "hello draft")
    }

    func testReturnSelectsTopResult() {
        openModelPage()
        let search = field("Search models")
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        search.typeText("code")

        XCTAssertTrue(app.buttons["Atlas Code, Tuned for large refactors"].waitForExistence(timeout: 10))
        waitForAbsence(app.buttons["Atlas Pro, Deepest reasoning"], "non-matches are filtered out")
        search.typeText("\n")

        let picked = app.buttons["Atlas Code, Tuned for large refactors"]
        XCTAssertEqual(picked.value as? String, "Selected")
        waitForAbsence(app.buttons["Clear search"], "picking clears the query")
        XCTAssertTrue(app.buttons["Atlas Pro, Deepest reasoning"].waitForExistence(timeout: 10),
                      "the full list is back after the pick")
    }

    func testPinFavoritePersists() {
        openModelPage()
        let row = app.buttons["Atlas Mini, Fastest answers"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.press(forDuration: 1.0)
        let pin = app.buttons["Pin to Favorites"]
        XCTAssertTrue(pin.waitForExistence(timeout: 8), "long-press offers Pin to Favorites")
        pin.tap()
        XCTAssertTrue(app.staticTexts["Favorites"].waitForExistence(timeout: 8),
                      "the pin appears under Favorites")

        app.terminate()
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisDemoModels", "400"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
        openModelPage()
        XCTAssertTrue(app.staticTexts["Favorites"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["Atlas Mini, Fastest answers"].exists)

        app.buttons["Atlas Mini, Fastest answers"].press(forDuration: 1.0)
        let unpin = app.buttons["Unpin"]
        XCTAssertTrue(unpin.waitForExistence(timeout: 8))
        unpin.tap()
        waitForAbsence(app.staticTexts["Favorites"], "unpinning removes the section")
    }
}
