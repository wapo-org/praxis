import XCTest

/// The tray's model page with a provider-sized list (500 models): it
/// opens, scrolls, selects and closes, and each cycle's app CPU time is
/// measured (open → scroll → close).
final class ModelPickerUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES", "-PraxisDemoModels", "500"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
    }

    private func button(_ label: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func buttonBeginning(_ prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    private func openModelPage() {
        button("Add photos, files and more").tap()
        let model = buttonBeginning("Model, ")
        XCTAssertTrue(model.waitForExistence(timeout: 15), "tray should open")
        model.tap()
        XCTAssertTrue(button("Atlas Mini, Fastest answers").waitForExistence(timeout: 15),
                      "the model page should list the catalogue")
    }

    private func closeTray() {
        button("Close add menu").tap()
        XCTAssertTrue(button("Add photos, files and more").waitForExistence(timeout: 15),
                      "the tray should close")
    }

    func testSelectFromLongModelList() {
        openModelPage()
        let tray = app.scrollViews["plusTray"]
        for _ in 0..<3 { tray.swipeUp() }
        XCTAssertTrue(buttonBeginning("Vendor Model ").waitForExistence(timeout: 10), "provider models should be listed")
        // The lazy list keeps a few rows above the fold: pick one on screen.
        let rows = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Vendor Model ")).allElementsBoundByIndex
        guard let far = rows.first(where: { $0.isHittable }) else { return XCTFail("no provider model on screen") }
        let name = far.label.components(separatedBy: ",").first ?? ""
        far.tap()
        let picked = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", name + ",")).firstMatch
        XCTAssertEqual(picked.value as? String, "Selected")
        closeTray()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", name)).firstMatch
                        .waitForExistence(timeout: 10), "toolbar caption should show the chosen model")
    }

    func testModelPageOpenScrollCloseCost() {
        let options = XCTMeasureOptions()
        options.iterationCount = 5
        measure(metrics: [XCTCPUMetric(application: app), XCTClockMetric()], options: options) {
            openModelPage()
            app.scrollViews["plusTray"].swipeUp()
            closeTray()
        }
    }
}
