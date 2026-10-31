import XCTest

/// Opt-in real-server walkthrough. No URLProtocol, fabricated account or
/// connector OAuth completion is used by these screenshots.
final class CloudWalkthroughUITests: XCTestCase {
    private var app: XCUIApplication!
    private var style = "light"
    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_LIVE_API"] == "http://127.0.0.1:8807",
                          "Live walkthrough requires the worker's dev:local server on port 8807")
        style = ProcessInfo.processInfo.environment["PRAXIS_WALKTHROUGH_STYLE"] ?? "light"
        app = XCUIApplication()
    }
    override func tearDownWithError() throws { app?.terminate() }
    private func launch(_ script: String = "text") {
        app.terminate()
        app.launchArguments = ["-PraxisResetData", "YES", "-PraxisCloudServerURL", "http://127.0.0.1:8807", "-PraxisCloudScenario", script]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 20))
    }
    private func tap(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 15))
        for _ in 0..<5 { if element.isHittable { break }; app.swipeUp() }
        XCTAssertTrue(element.isHittable)
        element.tap()
    }
    private func settings() {
        tap(app.buttons["History"]); tap(app.buttons["History options"]); tap(app.buttons["Settings"])
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    }
    private func shot(_ screen: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "\(screen)-\(style)"; attachment.lifetime = .keepAlways; add(attachment)
    }
    private func send(_ script: String) {
        launch(script)
        tap(app.buttons["New chat"])
        let field = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        tap(field); field.typeText("Walkthrough \(script)")
        tap(app.buttons["Send message"])
    }
    func testLiveWalkthrough() {
        launch(); settings(); tap(app.buttons["cloudAccountServer"])
        if app.buttons["cloudSignOut"].waitForExistence(timeout: 3) { tap(app.buttons["cloudSignOut"]) }
        XCTAssertTrue(app.textFields["cloudEmail"].waitForExistence(timeout: 10))
        shot("sign-in")
        tap(app.buttons["cloudLocalSignIn"])
        XCTAssertTrue(app.buttons["cloudSignOut"].waitForExistence(timeout: 15))
        app.swipeDown()
        shot("account-signed-in")
        // Relaunch uses the real origin-scoped Keychain session.
        launch(); tap(app.buttons["New chat"]); shot("empty-chat")
        tap(app.buttons["Add photos, files and more"])
        tap(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Model, '")).firstMatch)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Select '")).firstMatch.waitForExistence(timeout: 15))
        shot("model-picker")
        launch(); tap(app.buttons["History"]); shot("history")
        launch(); settings(); shot("settings")
        tap(app.buttons["Connectors"]); XCTAssertTrue(app.navigationBars["Connectors"].waitForExistence(timeout: 10)); shot("connectors")
        tap(app.navigationBars.buttons["Settings"])
        tap(app.buttons["Skills"]); XCTAssertTrue(app.navigationBars["Skills"].waitForExistence(timeout: 10)); shot("skills")
        send("approval")
        XCTAssertTrue(app.buttons["Allow once"].waitForExistence(timeout: 20))
        shot("streaming-with-tool-rows"); shot("approval")
        tap(app.buttons["Allow once"])
        XCTAssertTrue(app.buttons["Stop generating"].waitForNonExistence(timeout: 15))
        send("elicitation")
        XCTAssertTrue(app.navigationBars["Connector request"].waitForExistence(timeout: 20)); shot("elicitation-form")
        tap(app.buttons["Cancel request"])
        send("elicitationURL")
        XCTAssertTrue(app.staticTexts["Sign in to Local Connector to continue."].waitForExistence(timeout: 20))
        shot("elicitation-url"); tap(app.buttons["Cancel request"])
        launch(); settings(); tap(app.buttons["cloudAccountServer"]); tap(app.buttons["cloudSignOut"])
        XCTAssertTrue(app.textFields["cloudEmail"].waitForExistence(timeout: 10))
    }
}
