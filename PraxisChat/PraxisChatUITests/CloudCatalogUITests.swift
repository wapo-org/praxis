import XCTest

/// Cloud equivalents of the retained frozen native settings tests. These
/// controls use the injected HTTP server, not native provider/connector stores.
final class CloudCatalogUITests: XCTestCase {
    private var app: XCUIApplication!
    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-PraxisResetData", "YES", "-PraxisCloudStub", "YES", "-PraxisCloudServerURL", "https://cloud.praxis.test"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 20))
        app.buttons["History"].tap()
        XCTAssertTrue(app.buttons["History options"].waitForExistence(timeout: 10))
        app.buttons["History options"].tap(); app.buttons["Settings"].tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    }
    override func tearDownWithError() throws { app?.terminate() }
    private func open(_ title: String) {
        let button = app.buttons[title]
        XCTAssertTrue(button.waitForExistence(timeout: 10))
        for _ in 0..<5 { if button.isHittable { break }; app.swipeUp() }
        button.tap()
        XCTAssertTrue(app.navigationBars[title].waitForExistence(timeout: 10))
    }
    func testCloudModelsSearchThroughServer() {
        open("Models & favorites")
        XCTAssertTrue(app.buttons["Select Cloud Fixture"].waitForExistence(timeout: 10))
        let search = app.searchFields.firstMatch
        if !search.isHittable { app.swipeDown() }
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap(); search.typeText("does-not-exist")
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'No models match'")).firstMatch.waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Select Cloud Fixture"].exists)
    }
    func testCloudConnectorsOpenRemoteEditor() {
        open("Connectors")
        XCTAssertTrue(app.buttons["cloudBrowseMCPRegistry"].exists)
        app.buttons["cloudAddConnector"].tap()
        XCTAssertTrue(app.navigationBars["Add connector"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["Server URL"].exists)
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'stdio connectors are unsupported'")).firstMatch.exists)
    }
    func testCloudSkillsExposeCreateAndImport() {
        open("Skills")
        XCTAssertTrue(app.buttons["cloudImportSkill"].exists)
        XCTAssertTrue(app.buttons["cloudImportSkillArchive"].exists)
        XCTAssertTrue(app.buttons["cloudCheckSkillUpdates"].exists)
        app.buttons["Create skill"].tap()
        XCTAssertTrue(app.navigationBars["Create skill"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.textFields["Name"].exists)
    }
    func testCloudVoiceUsesWriteOnlyServerKey() {
        open("Voice input")
        XCTAssertTrue(app.staticTexts["cloudVoiceStatus"].exists || app.otherElements["cloudVoiceStatus"].exists)
        let key = app.secureTextFields["Cloud voice API key"]
        XCTAssertTrue(key.waitForExistence(timeout: 10)); key.tap(); key.typeText("fixture-voice-key")
        let save = app.buttons["cloudSaveVoice"]
        for _ in 0..<4 { if save.isHittable { break }; app.swipeUp() }
        save.tap()
        XCTAssertTrue(app.staticTexts["Voice settings saved."].waitForExistence(timeout: 10))
        XCTAssertFalse((key.value as? String)?.contains("fixture-voice-key") == true)
    }
}
