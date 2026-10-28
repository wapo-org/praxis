import XCTest

/// Voice input through the real UI (VOICE_PLAN.md §9): the mic uses the
/// DEBUG seams (`-PraxisFakeRecording` simulates capture from the bundled
/// `voice-fake.m4a`, `-PraxisFakeTranscript` scripts the transcript), so no
/// mic permission prompt and no network ever happen here.
final class VoiceRecordingUITests: XCTestCase {
    var app: XCUIApplication!

    // MARK: Launch

    /// Launches with the voice seams. `resetData` false keeps Application
    /// Support (recordings) across a relaunch inside one test.
    private func launch(transcript: String = "buy oat milk", elapsed: String? = nil,
                        resetData: Bool = true) {
        continueAfterFailure = false
        app = XCUIApplication()
        if resetData { app.launchArguments += ["-PraxisResetData", "YES"] }
        app.launchArguments += ["-PraxisFakeRecording", "voice-fake.m4a",
                                "-PraxisFakeTranscript", transcript]
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

    /// The field's text; the placeholder stands in for an empty field.
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
        // Type while the old recording waits: the transcript must append,
        // never replace.
        composerField.tap()
        composerField.typeText("typed first")
        tapReliably(elContains(.button, "Review"))
        elContains(.button, "Transcribe recording from").tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 15))
        XCTAssertEqual(fieldText, "typed first\nbuy oat milk")
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
        // The other chat keeps its field; its mic can't hijack the live
        // recording (one live session — the pill returns to it).
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 8))
        el(.button, "Record voice message").tap()
        Thread.sleep(forTimeInterval: 1.0)
        XCTAssertFalse(el(.button, "Stop and transcribe").exists)
        XCTAssertTrue(pill.exists)
        pill.tap()
        XCTAssertTrue(el(.button, "Stop and transcribe").waitForExistence(timeout: 10),
                      "the pill returns to the originating chat")
        // Cleanup: the recording is seconds old, so cancel asks nothing.
        el(.button, "Cancel recording").tap()
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 8))
    }
}
