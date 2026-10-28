import XCTest

/// The tray's effort control follows the selected model: only its levels
/// are offered, the dial snaps to the nearest one on a model change, and a
/// model without reasoning hides the control. Demo catalogue doubles as the
/// fixture (Atlas Mini: three levels; Atlas Chat: none).
final class EffortControlUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
    }

    private func button(_ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func openTray() {
        button("Add photos, files and more").tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model, ")).firstMatch
            .waitForExistence(timeout: 15), "tray should open")
    }

    private func openModelPage() {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Model, ")).firstMatch.tap()
        XCTAssertTrue(button("Atlas Mini, Fastest answers").waitForExistence(timeout: 15),
                      "the model page should list the catalogue")
    }

    func testEffortControlShowsOnlySupportedLevelsAndSnaps() {
        openTray()
        // Unknown model (Atlas): all four levels.
        for level in ["Low", "Medium", "High", "Max"] {
            XCTAssertTrue(button(level).waitForExistence(timeout: 10), "\(level) should show for an unknown model")
        }
        button("Max").tap()
        XCTAssertEqual(button("Max").value as? String, "Selected")

        // A three-level model: Max disappears, the dial snaps to High.
        openModelPage()
        button("Atlas Mini, Fastest answers").tap()
        button("Back").tap()
        XCTAssertTrue(button("High").waitForExistence(timeout: 10))
        XCTAssertEqual(button("High").value as? String, "Selected", "max snaps to the nearest supported level")
        XCTAssertFalse(button("Max").exists, "unsupported levels are not shown")
        XCTAssertTrue(button("Low").exists && button("Medium").exists)

        // A model without reasoning hides the control entirely.
        openModelPage()
        button("Atlas Chat, Quick chat, no reasoning").tap()
        button("Back").tap()
        // The main page is back when the model row shows the new pick…
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == %@", "Model, Atlas Chat")).firstMatch
            .waitForExistence(timeout: 10))
        for level in ["Low", "Medium", "High", "Max"] {
            XCTAssertFalse(button(level).exists, "\(level) should hide for a model without reasoning")
        }

        // …and back to an unknown model restores all four, keeping the dial.
        openModelPage()
        button("Atlas, Balanced for everyday work").tap()
        button("Back").tap()
        for level in ["Low", "Medium", "High", "Max"] {
            XCTAssertTrue(button(level).waitForExistence(timeout: 10), "\(level) should return")
        }
        XCTAssertEqual(button("High").value as? String, "Selected")
    }
}
