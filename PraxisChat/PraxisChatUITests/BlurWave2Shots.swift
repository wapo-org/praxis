import XCTest

/// Wave-2 blur verification probe (not part of the regular suite):
/// holds poses with content scrolled under every screen's top and bottom
/// edges while taking screenshots. Skipped unless `PRAXIS_BLUR2SHOTS` is
/// set (`TEST_RUNNER_PRAXIS_BLUR2SHOTS=1 xcodebuild test
/// -only-testing:…/BlurWave2Shots`). Writes PNGs to
/// /tmp/praxis-blur2-shots/. Run once per appearance (set the simulator's
/// appearance before each run).
final class BlurWave2Shots: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_BLUR2SHOTS"] != nil, "blur2 shots")
        continueAfterFailure = true
        app = XCUIApplication()
        try? FileManager.default.createDirectory(atPath: "/tmp/praxis-blur2-shots", withIntermediateDirectories: true)
    }

    private func launch(_ extra: [String] = []) {
        app.launchArguments += ["-PraxisResetData", "YES"] + extra
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.0)
    }

    private func save(_ name: String) {
        Thread.sleep(forTimeInterval: 0.6)
        let png = app.screenshot().pngRepresentation
        try? png.write(to: URL(fileURLWithPath: "/tmp/praxis-blur2-shots/\(name).png"))
    }

    private func el(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        app.descendants(matching: type).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    // MARK: Chat

    /// Transcript text behind the title (top) and the composer (bottom).
    func testChatEdges() {
        launch(["-PraxisLongThread", "YES"])
        save("chat-0-bottom")
        app.swipeDown()
        Thread.sleep(forTimeInterval: 0.8)
        save("chat-1-top-scrolled")
        app.swipeDown()
        Thread.sleep(forTimeInterval: 0.8)
        save("chat-2-top-scrolled-far")
    }

    // MARK: Tray

    /// The model page's long list scrolling inside the tray card.
    func testTrayModels() {
        launch(["-PraxisDemoModels", "500"])
        el(.button, "Add photos, files and more").tap()
        Thread.sleep(forTimeInterval: 0.8)
        let modelRow = app.descendants(matching: .button).matching(NSPredicate(format: "label BEGINSWITH %@", "Model,")).firstMatch
        XCTAssertTrue(modelRow.waitForExistence(timeout: 5))
        modelRow.tap()
        Thread.sleep(forTimeInterval: 0.8)
        save("tray-0-models-top")
        let tray = app.descendants(matching: .any).matching(identifier: "plusTray").firstMatch
        if tray.exists { tray.swipeUp(); Thread.sleep(forTimeInterval: 0.8) }
        save("tray-1-models-scrolled")
        app.buttons["Back"].firstMatch.tap()
        Thread.sleep(forTimeInterval: 0.8)
        save("tray-2-main")
    }

    // MARK: History

    func testHistory() {
        launch(["-PraxisLongThread", "YES"])
        el(.button, "History").tap()
        Thread.sleep(forTimeInterval: 0.8)
        save("history-0-top")
        app.swipeUp()
        Thread.sleep(forTimeInterval: 0.8)
        save("history-1-scrolled")
    }

    // MARK: Settings

    private func openSettings() {
        el(.button, "History").tap()
        let options = el(.button, "History options")
        XCTAssertTrue(options.waitForExistence(timeout: 10))
        options.tap()
        let settings = el(.button, "Settings")
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    }

    func testSettingsScreens() {
        launch()
        openSettings()
        save("settings-0-root")
        app.swipeUp()
        Thread.sleep(forTimeInterval: 0.8)
        save("settings-1-root-scrolled")
        el(.button, "Connectors").tap()
        XCTAssertTrue(app.navigationBars["Connectors"].waitForExistence(timeout: 10))
        save("settings-2-connectors")
        el(.button, "Add by URL").tap()
        XCTAssertTrue(app.navigationBars["Add by URL"].waitForExistence(timeout: 10))
        save("settings-3-add-url")
        app.navigationBars["Add by URL"].buttons.firstMatch.tap()
        el(.button, "Paste a config").tap()
        XCTAssertTrue(app.navigationBars["Paste a config"].waitForExistence(timeout: 10))
        save("settings-4-paste-config")
    }

    func testSkillsAndReader() {
        launch()
        openSettings()
        el(.button, "Skills").tap()
        XCTAssertTrue(app.navigationBars["Skills"].waitForExistence(timeout: 10))
        save("settings-5-skills")
        app.navigationBars["Skills"].buttons.firstMatch.tap()
        el(.button, "Image reading model").tap()
        XCTAssertTrue(app.navigationBars["Image reading model"].waitForExistence(timeout: 10))
        save("settings-6-image-reader")
    }

    // MARK: Consent

    func testConsent() {
        launch(["-PraxisTestProviderURL", "https://blur-consent.invalid/v1"])
        let field = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Hello blur")
        app.buttons["Send message"].tap()
        XCTAssertTrue(app.staticTexts["consentTitle"].waitForExistence(timeout: 10))
        save("consent-0-sheet")
    }
}
