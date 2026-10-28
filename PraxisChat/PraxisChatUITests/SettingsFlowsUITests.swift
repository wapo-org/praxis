import XCTest

/// Settings flows added with the live runtime: connectors (add-by-URL
/// validation, pasted configs that would run a local process), the
/// skills screen, and the AI-data consent sheet on a first live send.
/// All hermetic: nothing here reaches the network.
final class SettingsFlowsUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES"]
    }

    private func launch(_ extra: [String] = []) {
        app.launchArguments += extra
        app.launch()
        XCTAssertTrue(el(.button, "History").waitForExistence(timeout: 15))
    }

    private func el(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        app.descendants(matching: type).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func elContains(_ type: XCUIElement.ElementType, _ text: String) -> XCUIElement {
        app.descendants(matching: type).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// History → ⋯ → Settings.
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

    // MARK: Connectors

    func testAddByURLValidates() {
        launch()
        openSettings()
        el(.button, "Connectors").tap()
        XCTAssertTrue(app.navigationBars["Connectors"].waitForExistence(timeout: 10))
        XCTAssertTrue(elContains(.staticText, "No connectors yet").exists)
        el(.button, "Add by URL").tap()
        XCTAssertTrue(app.navigationBars["Add by URL"].waitForExistence(timeout: 10))

        // Nothing typed.
        el(.button, "Continue").tap()
        let error = app.staticTexts["addConnectorError"]
        XCTAssertTrue(error.waitForExistence(timeout: 5))
        XCTAssertEqual(error.label, "Enter the server's URL.")

        // Plain http to a public host is refused (https only).
        let field = app.textFields["Server URL"]
        field.tap()
        field.typeText("http://mcp.example.com/mcp")
        el(.button, "Continue").tap()
        XCTAssertTrue(app.staticTexts["addConnectorError"].label.contains("https"), app.staticTexts["addConnectorError"].label)
        shot("partb-01-add-url-https-only")

        // A credential choice needs a value before it can go on.
        el(.button, "Bearer token").tap()
        XCTAssertTrue(app.secureTextFields["Token"].waitForExistence(timeout: 5))
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 40) + "https://mcp.example.com/mcp")
        el(.button, "Continue").tap()
        XCTAssertEqual(app.staticTexts["addConnectorError"].label, "Enter the token, or choose None.")
    }

    func testPastedStdioConfigIsRejectedWithTheReason() {
        launch()
        openSettings()
        el(.button, "Connectors").tap()
        el(.button, "Paste a config").tap()
        XCTAssertTrue(app.navigationBars["Paste a config"].waitForExistence(timeout: 10))
        let editor = app.textViews["Config JSON"]
        XCTAssertTrue(editor.waitForExistence(timeout: 5))
        editor.tap()
        editor.typeText(#"{"mcpServers":{"files":{"command":"npx","args":["-y","server-files"]},"#
                        + #""docs":{"url":"https://docs.mcp.test/mcp"}}}"#)
        el(.button, "Read config").tap()

        XCTAssertTrue(elContains(.any, "not supported on iPhone").waitForExistence(timeout: 5),
                      "the stdio entry is listed with why it can't be added")
        XCTAssertTrue(elContains(.any, "runs a local process").exists || elContains(.any, "Runs a local process").exists)
        XCTAssertTrue(elContains(.any, "files").exists)
        XCTAssertTrue(elContains(.any, "https://docs.mcp.test/mcp").exists, "the remote entry can be added")
        shot("partb-02-paste-config-rejected")
    }

    // MARK: Skills

    func testSkillsScreenShowsTheEmptyState() {
        launch()
        openSettings()
        el(.button, "Skills").tap()
        XCTAssertTrue(app.navigationBars["Skills"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["skillsEmpty"].waitForExistence(timeout: 5))
        XCTAssertTrue(el(.button, "Import skill").exists)
        shot("partb-03-skills-empty")
    }

    // MARK: Consent

    /// A keyless profile at an unresolvable host (`.invalid` never
    /// resolves): consent must stop the send before any request.
    func testConsentSheetOnFirstLiveSendAndDeclineRestoresTheDraft() {
        launch(["-PraxisTestProviderURL", "https://praxis-consent.invalid/v1"])
        el(.button, "New chat").tap()
        let field = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        field.tap()
        field.typeText("Hello consent")
        el(.button, "Send message").tap()

        let title = app.staticTexts["consentTitle"]
        XCTAssertTrue(title.waitForExistence(timeout: 10), "consent is asked before the first live send")
        XCTAssertTrue(title.label.contains("praxis-consent.invalid"), title.label)
        XCTAssertTrue(elContains(.any, "Tool results").exists)
        XCTAssertTrue(elContains(.any, "Connector data").exists)
        XCTAssertFalse(elContains(.any, "You said: Hello consent").exists, "nothing was added to the thread")
        shot("partb-04-consent")

        el(.button, "Don't allow").tap()
        XCTAssertTrue(title.waitForNonExistence(timeout: 5))
        let restored = app.textViews["Message"].exists ? app.textViews["Message"] : app.textFields["Message"]
        XCTAssertEqual(restored.value as? String, "Hello consent", "the draft is still there")
        XCTAssertFalse(elContains(.any, "You said: Hello consent").exists)

        // Not remembered as allowed: sending again asks again.
        el(.button, "Send message").tap()
        XCTAssertTrue(app.staticTexts["consentTitle"].waitForExistence(timeout: 10))
        el(.button, "Don't allow").tap()
    }
}
