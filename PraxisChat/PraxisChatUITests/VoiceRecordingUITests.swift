import XCTest

final class VoiceRecordingUITests: XCTestCase {
    var app: XCUIApplication!

    // MARK: Launch

    /// resetData false keeps recordings across relaunch; nil transcript runs the real transcriber.
    private func launch(transcript: String? = "buy oat milk", elapsed: String? = nil,
                        resetData: Bool = true) {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo"]
        if resetData { app.launchArguments += ["-PraxisResetData", "YES"] }
        app.launchArguments += ["-PraxisFakeRecording", "voice-fake.m4a"]
        if let transcript { app.launchArguments += ["-PraxisFakeTranscript", transcript] }
        if let elapsed { app.launchArguments += ["-PraxisFakeElapsed", elapsed] }
        app.launch()
        XCTAssertTrue(el(.button, "History").waitForExistence(timeout: 15))
    }

    private func relaunchKeepingData(transcript: String = "buy oat milk") {
        app.terminate()
        launch(transcript: transcript, resetData: false)
    }

    // MARK: Query helpers (same label-based style as PraxisChatUITests)

    private func el(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func elContains(_ type: XCUIElement.ElementType, _ text: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func tapReliably(_ element: XCUIElement, timeout: TimeInterval = 20) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists && element.isHittable {
                element.tap()
                return
            }
            Thread.sleep(forTimeInterval: 0.4)
        }
        XCTFail("element never became hittable: \(element)")
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private var composerField: XCUIElement {
        let tv = app.textViews["Message"]
        if tv.exists { return tv }
        return app.textFields["Message"]
    }

    private var fieldText: String {
        let value = (composerField.value as? String) ?? ""
        return value == "Plan, ask, build..." ? "" : value
    }

    private func startRecording() {
        el(.button, "New chat").tap()
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 10))
        el(.button, "Record voice message").tap()
        XCTAssertTrue(el(.button, "Stop and transcribe").waitForExistence(timeout: 10),
                      "mic should open the recording UI")
    }

    // MARK: Record → stop → transcript

    func testRecordStopTranscriptAppended() {
        launch()
        startRecording()
        shot("voice-recording")
        el(.button, "Stop and transcribe").tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 15),
                      "transcript in the draft morphs mic into send")
        XCTAssertEqual(fieldText, "buy oat milk")
        shot("voice-transcribed")
    }

    func testTrailingStopButtonTranscribes() {
        launch()
        startRecording()
        el(.button, "Stop recording").tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 15))
        XCTAssertEqual(fieldText, "buy oat milk")
    }

    func testPauseAndResume() {
        launch()
        startRecording()
        el(.button, "Pause recording").tap()
        XCTAssertTrue(elContains(.button, "tap to resume").waitForExistence(timeout: 8))
        shot("voice-paused")
        elContains(.button, "tap to resume").tap()
        XCTAssertTrue(el(.button, "Pause recording").waitForExistence(timeout: 8),
                      "tapping the notice resumes")
    }

    // MARK: Stop & review

    func testStopAndReviewRow() {
        launch()
        startRecording()
        el(.button, "Stop and review").tap()
        XCTAssertTrue(el(.button, "Play recording").waitForExistence(timeout: 8))
        XCTAssertTrue(el(.button, "Transcribe recording").exists)
        XCTAssertTrue(el(.button, "Delete recording").exists)
        XCTAssertTrue(composerField.waitForExistence(timeout: 4) == false,
                      "review replaces the text field")
        shot("voice-review")
        el(.button, "Transcribe recording").tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 15))
        XCTAssertEqual(fieldText, "buy oat milk")
    }

    // MARK: Cancel rules

    func testCancelShortRecordingDiscards() {
        launch()
        startRecording()
        el(.button, "Cancel recording").tap()
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 8),
                      "short recordings discard without asking")
    }

    func testCancelLongRecordingAsks() {
        launch(elapsed: "15")
        startRecording()
        el(.button, "Cancel recording").tap()
        let alert = app.alerts["Discard this recording?"]
        XCTAssertTrue(alert.waitForExistence(timeout: 8),
                      "recordings over 10 s need confirmation")
        shot("voice-cancel-confirm")
        alert.buttons["Keep recording"].tap()
        XCTAssertTrue(el(.button, "Stop and transcribe").waitForExistence(timeout: 8),
                      "keeping returns to the live recording")
        el(.button, "Cancel recording").tap()
        XCTAssertTrue(alert.waitForExistence(timeout: 8))
        alert.buttons["Discard"].tap()
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 8))
    }

    // MARK: Recovery banner

    func testRecoveryBannerAfterRelaunch() {
        launch()
        startRecording()
        el(.button, "Stop and review").tap()
        XCTAssertTrue(el(.button, "Transcribe recording").waitForExistence(timeout: 8))

        relaunchKeepingData()

        let banner = elContains(.button, "Review")
        XCTAssertTrue(banner.waitForExistence(timeout: 10),
                      "an untranscribed recording banners on next launch")
        shot("voice-recovery-banner")
        tapReliably(banner)
        let rowTranscribe = elContains(.button, "Transcribe recording from")
        XCTAssertTrue(rowTranscribe.waitForExistence(timeout: 8))
        rowTranscribe.tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 15))
        XCTAssertEqual(fieldText, "buy oat milk")
    }

    func testBannerTranscribePreservesDraft() {
        launch()
        startRecording()
        el(.button, "Stop and review").tap()
        XCTAssertTrue(el(.button, "Transcribe recording").waitForExistence(timeout: 8))

        relaunchKeepingData()
        composerField.tap()
        composerField.typeText("typed first")
        tapReliably(elContains(.button, "Review"))
        elContains(.button, "Transcribe recording from").tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 15))
        XCTAssertEqual(fieldText, "typed first\nbuy oat milk")
    }

    // MARK: Settings list

    func testRecordingsListInSettings() {
        launch()
        startRecording()
        el(.button, "Stop and review").tap()
        XCTAssertTrue(el(.button, "Transcribe recording").waitForExistence(timeout: 8))
        openVoiceSettings()
        el(.button, "Recordings").tap()
        XCTAssertTrue(app.navigationBars["Recordings"].waitForExistence(timeout: 10))
        XCTAssertTrue(elContains(.button, "Transcribe recording from").waitForExistence(timeout: 8),
                      "the Settings list shows the same recording")
        shot("voice-recordings-list")
    }

    // MARK: Cross-chat pill

    func testRecordingPillReturnsToOriginChat() {
        launch()
        startRecording()
        el(.button, "History").tap()
        XCTAssertTrue(elContains(.button, "Build failure triage").waitForExistence(timeout: 10))
        elContains(.button, "Build failure triage").tap()
        let pill = elContains(.button, "Return to recording")
        XCTAssertTrue(pill.waitForExistence(timeout: 10),
                      "leaving the chat shows the recording pill")
        shot("voice-pill")
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 8))
        el(.button, "Record voice message").tap()
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertFalse(el(.button, "Stop and transcribe").exists)
        XCTAssertTrue(pill.exists)
        pill.tap()
        XCTAssertTrue(el(.button, "Stop and transcribe").waitForExistence(timeout: 10),
                      "the pill returns to the originating chat")
        // Cancel asks after 10 s and discards immediately under 10 s, so handle either in cleanup.
        el(.button, "Cancel recording").tap()
        let alert = app.alerts["Discard this recording?"]
        if alert.waitForExistence(timeout: 3) {
            alert.buttons["Discard"].tap()
        }
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 8))
    }

    // MARK: Real transcriber E2E (final voice integration)

    private func openVoiceSettings() {
        el(.button, "History").tap()
        let options = el(.button, "History options")
        XCTAssertTrue(options.waitForExistence(timeout: 10))
        options.tap()
        let settings = el(.button, "Settings")
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        let row = el(.button, "Voice input")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        if !row.isHittable { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.navigationBars["Voice input"].waitForExistence(timeout: 10))
    }

    func testRealTranscriberConsentDeclineKeepsQueued() {
        launch(transcript: nil)
        openVoiceSettings()
        let keyField = el(.secureTextField, "Groq API key")
        XCTAssertTrue(keyField.waitForExistence(timeout: 10))
        keyField.tap()
        keyField.typeText("gsk-ui-e2e")
        el(.button, "Save API key").tap()
        app.navigationBars.buttons["Settings"].tap()
        let done = el(.button, "Done")
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.tap()
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 10))

        startRecording()
        el(.button, "Stop and transcribe").tap()
        let allow = el(.button, "Allow and transcribe")
        XCTAssertTrue(allow.waitForExistence(timeout: 15),
                      "first upload to api.groq.com holds for consent")
        XCTAssertTrue(app.staticTexts["Voice recordings"].exists)
        shot("voice-e2e-consent")
        el(.button, "Don't allow").tap()
        XCTAssertFalse(allow.waitForExistence(timeout: 5))

        XCTAssertTrue(el(.button, "Transcribe recording").waitForExistence(timeout: 8))
        XCTAssertTrue(el(.button, "Play recording").exists)
        XCTAssertTrue(el(.button, "Delete recording").exists)
        XCTAssertFalse(el(.button, "Send message").exists)
    }
}
