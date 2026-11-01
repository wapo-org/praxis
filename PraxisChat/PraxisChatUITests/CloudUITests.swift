import XCTest

/// Cloud is deliberately selected by the app's default: these launches contain
/// no PraxisEngine argument. URLProtocol replaces only the server, so HTTP,
/// SSE parsing, the cloud engine, reducer and real controls all execute.
final class CloudUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }
    override func tearDownWithError() throws { app.terminate() }

    private func launch(_ scenario: String = "text") {
        app.launchArguments = ["-PraxisResetData", "YES", "-PraxisMockGallery", "YES",
                               "-PraxisCloudStub", "YES", "-PraxisCloudScenario", scenario,
                               "-PraxisCloudServerURL", "https://cloud.praxis.test"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 20))
    }
    private func text(_ value: String) -> XCUIElement {
        app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value)).firstMatch
    }
    private func send(_ prompt: String) {
        app.buttons["New chat"].tap()
        let field = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap(); field.typeText(prompt)
        app.buttons["Send message"].tap()
    }
    private func completed(_ answer: String) {
        XCTAssertTrue(text(answer).waitForExistence(timeout: 25), "Expected cloud answer: \(answer)")
        XCTAssertTrue(app.buttons["Stop generating"].waitForNonExistence(timeout: 10))
    }
    private func account() {
        app.buttons["History"].tap()
        XCTAssertTrue(app.buttons["History options"].waitForExistence(timeout: 10))
        app.buttons["History options"].tap()
        app.buttons["Settings"].tap()
        let row = app.buttons["cloudAccountServer"]
        XCTAssertTrue(row.waitForExistence(timeout: 10), "The default engine must expose cloud settings")
        row.tap()
        XCTAssertTrue(app.staticTexts["cloudServerURL"].waitForExistence(timeout: 10))
    }
    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testDefaultCloudSettingsShowServerAndAccount() {
        launch(); account()
        XCTAssertTrue((app.staticTexts["cloudServerURL"].value as? String)?.contains("cloud.praxis.test") == true)
        let status = app.staticTexts["cloudAccountStatus"]
        XCTAssertTrue(status.waitForExistence(timeout: 10))
        XCTAssertTrue(status.label.contains("cloud@example.test") || status.label.contains("Cloud Tester"))
        shot("cloud-default-account")
    }
    func testAccountSignOutAndSignIn() {
        launch(); account()
        XCTAssertTrue(app.buttons["cloudSignOut"].waitForExistence(timeout: 10))
        app.buttons["cloudSignOut"].tap()
        let email = app.textFields["cloudEmail"]
        XCTAssertTrue(email.waitForExistence(timeout: 10))
        email.tap(); email.typeText("cloud@example.test")
        let password = app.secureTextFields["cloudPassword"]
        password.tap(); password.typeText("fixture-password")
        app.buttons["cloudSignIn"].tap()
        XCTAssertTrue(app.buttons["cloudSignOut"].waitForExistence(timeout: 15))
        shot("cloud-account-signed-in")
    }
    func testDeleteAccountShowsServerErrorThenDeletes() {
        launch(); account()
        app.buttons["cloudDeleteAccount"].tap()
        let password = app.secureTextFields["cloudDeletePassword"]
        XCTAssertTrue(password.waitForExistence(timeout: 10))
        password.tap(); password.typeText("wrong")
        app.buttons["cloudConfirmDeleteAccount"].tap()
        XCTAssertTrue(text("Confirm your current password").waitForExistence(timeout: 10), "The API's message is shown")
        password.tap(); password.typeText("-not")
        app.buttons["cloudConfirmDeleteAccount"].tap()
        XCTAssertTrue(app.staticTexts["cloudAccountDeleted"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.textFields["cloudEmail"].waitForExistence(timeout: 10))
        shot("cloud-account-deleted")
    }
    func testSendStreamsCloudAnswer() {
        launch(); send("Hello cloud")
        completed("Cloud reply: Hello cloud 🌍")
        shot("cloud-text-complete")
    }
    func testApproveResumesParkedRun() {
        launch("approval"); send("Ask for approval")
        let allow = app.buttons["Allow once"]
        XCTAssertTrue(allow.waitForExistence(timeout: 20))
        shot("cloud-approval-pending")
        allow.tap()
        completed("Cloud tool approved.")
        shot("cloud-approval-complete")
    }
    func testDenyNestedApprovalResumesParent() {
        launch("nestedApproval"); send("Ask inside code")
        XCTAssertTrue(app.buttons["Deny"].waitForExistence(timeout: 20))
        shot("cloud-nested-approval-pending")
        app.buttons["Deny"].tap()
        completed("Cloud tool denied.")
    }
    func testCancelStopsOpenCloudRun() {
        launch("cancel"); send("Wait for cancellation")
        let stop = app.buttons["Stop generating"]
        XCTAssertTrue(stop.waitForExistence(timeout: 15))
        XCTAssertTrue(text("Cloud run is waiting for Stop.").waitForExistence(timeout: 15))
        stop.tap()
        XCTAssertTrue(stop.waitForNonExistence(timeout: 15))
        // This fixture streams text without a tool activity block. Stopping
        // preserves that answer and exposes retry; no activity timer exists.
        XCTAssertTrue(text("Cloud run is waiting for Stop.").exists)
        XCTAssertTrue(app.buttons["Retry"].waitForExistence(timeout: 10))
        shot("cloud-cancelled")
    }
    func testReconnectResumesWithoutDuplicatingAnswer() {
        launch("reconnect"); send("Reconnect this run")
        let answer = "Cloud reconnect: one 🌍 answer, no duplicate text."
        completed(answer)
        // Full equality catches repeated delta text inside one markdown block;
        // the count catches a replayed assistant message as a second block.
        let matches = app.staticTexts.matching(NSPredicate(format: "label == %@", answer))
        XCTAssertEqual(matches.count, 1)
        shot("cloud-reconnected-once")
    }
    func testElicitationFormResumesRun() {
        launch("elicitation"); send("Ask for a fixture name")
        let name = app.textFields["Name"]
        XCTAssertTrue(name.waitForExistence(timeout: 20))
        name.tap(); name.typeText("Cloud Tester")
        shot("cloud-elicitation-pending")
        app.buttons["Submit"].tap()
        completed("Cloud form accepted.")
    }
    func testCompactionFinishesThroughCloudEvents() {
        launch("compaction"); send("Compact context")
        completed("Cloud context compacted.")
        shot("cloud-compaction-complete")
    }
    func testVisionFallbackFinishesThroughCloudEvents() {
        launch("vision"); send("Describe the fixture image")
        completed("Cloud vision fallback complete.")
        shot("cloud-vision-complete")
    }
}
