import XCTest

/// Voice input settings (voice-groq): the Settings → Voice input screen
/// loads the (fake) Groq model list, key + model persist across relaunch,
/// and the first-transcribe consent sheet shows voice copy. All hermetic:
/// `-PraxisFakeGroqModels` answers the model list, `-PraxisVoiceConsentDemo`
/// presents the held transcription (DEBUG seams, no network).
final class VoiceSettingsUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES"]
    }

    private func launch(_ extra: [String] = []) {
        app.launchArguments += extra
        app.launch()
        XCTAssertTrue(el(.button, "History").waitForExistence(timeout: 15))
    }

    private func el(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        app.descendants(matching: type).matching(NSPredicate(format: "label == %@", label)).firstMatch
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

    private func openVoiceSettings() {
        openSettings()
        let row = el(.button, "Voice input")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        if !row.isHittable { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.navigationBars["Voice input"].waitForExistence(timeout: 10))
    }

    // MARK: Screen + model list

    func testVoiceSettingsLoadsAndFiltersModelList() {
        launch(["-PraxisFakeGroqModels", "YES"])
        openVoiceSettings()
        // The fake list answers on open; non-speech ids are filtered out.
        XCTAssertTrue(el(.button, "Use model whisper-large-v3-turbo").waitForExistence(timeout: 10))
        XCTAssertTrue(el(.button, "Use model whisper-large-v3").exists)
        XCTAssertFalse(app.descendants(matching: .button).matching(NSPredicate(format: "label CONTAINS 'llama'")).firstMatch.exists)
        XCTAssertTrue(el(.button, "Use model id").exists)
        XCTAssertTrue(el(.secureTextField, "Groq API key").exists)
        shot("voice-settings")
    }

    func testVoiceKeyAndModelPersistAcrossRelaunch() {
        launch(["-PraxisFakeGroqModels", "YES"])
        openVoiceSettings()
        let keyField = el(.secureTextField, "Groq API key")
        XCTAssertTrue(keyField.waitForExistence(timeout: 10))
        keyField.tap()
        keyField.typeText("gsk-ui-test")
        el(.button, "Save API key").tap()
        let model = el(.button, "Use model whisper-large-v3")
        XCTAssertTrue(model.waitForExistence(timeout: 10))
        model.tap()

        app.terminate()
        app.launchArguments = ["-PraxisEngine", "demo", "-PraxisFakeGroqModels", "YES"]
        app.launch()
        XCTAssertTrue(el(.button, "History").waitForExistence(timeout: 15))
        openVoiceSettings()
        // Still selected after relaunch (key in Keychain, model in JSON).
        let reselected = el(.button, "Use model whisper-large-v3")
        XCTAssertTrue(reselected.waitForExistence(timeout: 10))
        XCTAssertEqual(reselected.value as? String, "selected")
        XCTAssertTrue(el(.secureTextField, "Groq API key").exists)
    }

    // MARK: First-transcribe consent

    func testConsentSheetShowsVoiceCopyAndAllows() {
        launch(["-PraxisVoiceConsentDemo", "YES"])
        let allow = el(.button, "Allow and transcribe")
        XCTAssertTrue(allow.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Voice recordings"].exists)
        shot("voice-consent")
        allow.tap()
        XCTAssertFalse(allow.waitForExistence(timeout: 5))
    }

    func testConsentSheetDeclineDismisses() {
        launch(["-PraxisVoiceConsentDemo", "YES"])
        XCTAssertTrue(el(.button, "Allow and transcribe").waitForExistence(timeout: 10))
        el(.button, "Don't allow").tap()
        XCTAssertFalse(el(.button, "Allow and transcribe").waitForExistence(timeout: 5))
    }
}
