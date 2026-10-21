import XCTest

/// End-to-end acceptance flows driven through the public UI (§15):
/// composer growth + mic→send, send → run → collapse, tray controls
/// applying outside the tray, chips, history, recording, stop/retry/edit.
final class PraxisChatUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launch()
        XCTAssertTrue(el(.button, "History").waitForExistence(timeout: 15))
    }

    // MARK: Query helpers (labels, not identifiers — glass views vary)

    private func el(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func elContains(_ type: XCUIElement.ElementType, _ text: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func elBegins(_ type: XCUIElement.ElementType, _ text: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
    }

    private func lastEl(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        let query = app.descendants(matching: type)
            .matching(NSPredicate(format: "label == %@", label))
        return query.element(boundBy: max(query.count - 1, 0))
    }

    /// Drags inside the bottom content area (tray card or transcript),
    /// scrolling whatever is actually under the finger upward.
    private func scrollContentUp() {
        app.swipeUp()
    }

    private func scrollContentDown() {
        app.swipeDown()
    }

    /// Scrolls toward the element, whichever side of the fold it is on.
    private func scrollToward(_ element: XCUIElement) {
        if element.frame.minY < app.frame.height * 0.30 {
            scrollContentDown()
        } else {
            scrollContentUp()
        }
    }

    /// An element can report hittable while its centre is clipped
    /// below the tray card's fold (the tap then lands on the composer).
    /// Anything reaching into the bottom chrome needs a scroll first.
    private func needsScroll(_ element: XCUIElement) -> Bool {
        element.frame.maxY > app.frame.height - 100 || element.frame.minY < 0
    }

    /// Re-resolves until the element is hittable, then taps. Glass morphs
    /// make one-shot taps flaky; the query is live so this stays honest.
    /// Elements below a scroll fold (tray card, transcript) get dragged
    /// into view between checks.
    private func tapReliably(_ element: XCUIElement, timeout: TimeInterval = 20,
                             clippedScroll: Bool = true) {
        // clippedScroll is retained for call-site clarity; hittability
        // alone gates the tap (an earlier frame-based gate blocked
        // visible rows whose frames reach into the bottom chrome).
        _ = clippedScroll
        let deadline = Date().addingTimeInterval(timeout)
        var scrolls = 0
        while Date() < deadline {
            if element.exists && element.isHittable {
                element.tap()
                return
            }
            if element.exists && scrolls < 6 {
                scrollToward(element)
                scrolls += 1
            }
            Thread.sleep(forTimeInterval: 0.4)
        }
        XCTFail("element never became hittable: \(element)")
    }

    /// Toggles only respond on the knob (right edge), not the row centre.
    private func tapSwitch(_ element: XCUIElement) {
        XCTAssertTrue(element.waitForExistence(timeout: 12))
        var scrolls = 0
        while (!element.isHittable || needsScroll(element)) && scrolls < 5 {
            scrollToward(element)
            scrolls += 1
            Thread.sleep(forTimeInterval: 0.6)
        }
        Thread.sleep(forTimeInterval: 0.6)
        element.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.5)).tap()
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

    private func setEffortLow() {
        el(.button, "Add photos, files and more").tap()
        XCTAssertTrue(el(.button, "Low").waitForExistence(timeout: 15), "tray should open")
        el(.button, "Low").tap()
        el(.button, "Close add menu").tap()
        XCTAssertTrue(el(.button, "Add photos, files and more").waitForExistence(timeout: 10))
    }

    // MARK: Send → streamed run → collapse → answer (isolated new chat)

    func testSendStreamsActivityAndAnswer() {
        setEffortLow()
        el(.button, "New chat").tap()
        XCTAssertTrue(el(.staticText, "How can I help?").waitForExistence(timeout: 10))

        let field = composerField
        field.tap()
        field.typeText("Add haptics to buttons")
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 5),
                      "mic should morph into send once there is text")
        shot("01-typing-send-visible")
        el(.button, "Send message").tap()

        XCTAssertTrue(el(.button, "Stop generating").waitForExistence(timeout: 12)
                      || el(.staticText, "Currently working…").exists,
                      "a run should start with a working activity block")
        XCTAssertTrue(elContains(.any, "You said: Add haptics to buttons").waitForExistence(timeout: 8),
                      "sent text should lift into a user bubble")
        shot("02-running")

        XCTAssertTrue(elBegins(.staticText, "Worked for").waitForExistence(timeout: 40),
                      "activity should finish and read 'Worked for Ns'")
        XCTAssertTrue(elContains(.staticText, "Haptics are in").waitForExistence(timeout: 15),
                      "the streamed answer should arrive")
        XCTAssertTrue(el(.button, "Retry").waitForExistence(timeout: 10),
                      "finished messages show the quiet action row")
        shot("03-finished")
    }

    // MARK: Stop mid-run, then Retry from the action row

    func testStopThenRetry() {
        let field = composerField
        field.tap()
        field.typeText("Why is my build failing?")
        el(.button, "Send message").tap()
        let stopButton = el(.button, "Stop generating")
        XCTAssertTrue(stopButton.waitForExistence(timeout: 12))
        Thread.sleep(forTimeInterval: 1.2)
        // Single tap, no polling loop: repeated snapshots while the
        // answer streams at 60fps can time out under load.
        stopButton.tap()

        if !elBegins(.staticText, "Stopped after").waitForExistence(timeout: 6) {
            app.scrollViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(elBegins(.staticText, "Stopped after").waitForExistence(timeout: 10),
                      "stopping should relabel the activity 'Stopped after Ns'")
        shot("04-stopped")

        // Send leaves the keyboard up over the action row, below the fold.
        // A slow drag dismisses it interactively (a fast swipe does not
        // track the finger), then scroll to the bottom action row.
        if app.keyboards.firstMatch.exists {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.40))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.78))
            start.press(forDuration: 0.3, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        let retryButton = lastEl(.button, "Retry")
        XCTAssertTrue(retryButton.waitForExistence(timeout: 8))
        app.scrollViews.firstMatch.swipeUp()
        tapReliably(retryButton)
        let working = el(.staticText, "Currently working…")
        let stop = el(.button, "Stop generating")
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline && !working.exists && !stop.exists {
            Thread.sleep(forTimeInterval: 0.3)
        }
        XCTAssertTrue(working.exists || stop.exists,
                      "Retry should start a fresh run")
        shot("05-retry-running")
        if el(.button, "Stop generating").exists { el(.button, "Stop generating").tap() }
    }

    // MARK: Tray: mode, model page, effort, tools, screenshots

    func testTrayControlsApplyOutsideTray() {
        el(.button, "Add photos, files and more").tap()
        XCTAssertTrue(el(.button, "Plan").waitForExistence(timeout: 15), "tray should open")
        shot("06-tray-main")

        el(.button, "Plan").tap()
        el(.button, "Model, Atlas").tap()
        XCTAssertTrue(el(.button, "Atlas Mini, Fastest answers").waitForExistence(timeout: 10))
        el(.button, "Atlas Mini, Fastest answers").tap()
        el(.button, "Back").tap()

        let codeSwitch = elContains(.switch, "Code execution")
        XCTAssertTrue(codeSwitch.waitForExistence(timeout: 10))
        tapSwitch(codeSwitch)
        var waited = 0.0
        while waited < 5 {
            if codeSwitch.exists && (codeSwitch.value as? String) == "0" { break }
            Thread.sleep(forTimeInterval: 0.3); waited += 0.3
        }
        XCTAssertTrue(codeSwitch.exists && (codeSwitch.value as? String) == "0",
                      "Code execution toggle should turn off")
        tapSwitch(codeSwitch)

        tapReliably(elBegins(.button, "Connectors"))
        tapSwitch(elContains(.switch, "Linear"))
        el(.button, "Back").tap()

        let thumb = el(.button, "Screenshot 1")
        XCTAssertTrue(thumb.waitForExistence(timeout: 12), "screenshot strip should load")
        tapReliably(thumb)
        XCTAssertEqual(thumb.value as? String, "Selected",
                       "tapping a thumbnail should select it")
        XCTAssertTrue(el(.button, "Add 1").waitForExistence(timeout: 8))
        el(.button, "Add 1").tap()

        // Outside the tray: model caption + mode placeholder + attachment.
        XCTAssertTrue(elContains(.button, "Atlas Mini").waitForExistence(timeout: 10),
                      "toolbar caption should show the chosen model")
        let placeholderOK = app.staticTexts["Plan it out..."].exists
            || composerField.placeholderValue == "Plan it out..."
        XCTAssertTrue(placeholderOK, "placeholder should follow Plan mode")
        XCTAssertTrue(elBegins(.button, "Remove").waitForExistence(timeout: 8),
                      "the chosen screenshot should land in the composer")
        shot("07-after-tray")

        // Swipe-to-dismiss: drag the card itself (it now grows out
        // of the composer at the bottom) and it tracks the finger.
        el(.button, "Add photos, files and more").tap()
        XCTAssertTrue(el(.button, "Plan").waitForExistence(timeout: 15))
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.93))
        start.press(forDuration: 0.3, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
        XCTAssertTrue(el(.button, "Add photos, files and more").waitForExistence(timeout: 10),
                      "swipe down should dismiss the tray")
        shot("08-tray-dismissed")
    }

    // MARK: Inline chips: FileRef sheet, LinkRef preview, CodePill copy

    func testChipTaps() {
        // FileRef opens the mock file sheet.
        let fileLink = app.links["ComposerView.swift"]
        XCTAssertTrue(fileLink.waitForExistence(timeout: 12))
        fileLink.tap()
        XCTAssertTrue(el(.button, "Done").waitForExistence(timeout: 8),
                      "tapping a FileRef should open its sheet")
        shot("09-file-sheet")
        el(.button, "Done").tap()

        // CodePill copies and shows the Copied toast (visible `.light` pill).
        let pill = app.links[".light"]
        XCTAssertTrue(pill.waitForExistence(timeout: 10))
        tapReliably(pill)
        XCTAssertTrue(el(.any, "Copied").waitForExistence(timeout: 15),
                      "tapping a CodePill should copy it with a toast")
        shot("10-copied-toast")
    }

    // MARK: LinkRef: tap opens the glass preview card

    func testLinkChipTap() {
        let link = app.links.matching(NSPredicate(format: "label CONTAINS %@", "agent activity spec")).firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 12))
        link.tap()
        XCTAssertTrue(el(.button, "Open").waitForExistence(timeout: 10),
                      "tapping a LinkRef should show its preview card")
        shot("10b-link-preview")
        el(.button, "Close preview").tap()
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 8))
    }

    // MARK: Recording: mic → waveform → mock transcription

    func testRecordingTypesTranscription() {
        el(.button, "Record voice message").tap()
        XCTAssertTrue(el(.button, "Stop recording").waitForExistence(timeout: 8))
        shot("11-recording")
        el(.button, "Stop recording").tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 8),
                      "stopping should type a transcription and morph mic into send")
        shot("12-transcribed")
    }

    // MARK: History switch + new chat + suggestion send

    func testHistoryNewChatAndSuggestion() {
        el(.button, "History").tap()
        XCTAssertTrue(elContains(.button, "Build failure triage").waitForExistence(timeout: 10))
        shot("13-history")
        elContains(.button, "Build failure triage").tap()
        XCTAssertTrue(elContains(.button, "Build failure triage").waitForExistence(timeout: 10),
                      "toolbar title should switch to the chosen conversation")

        el(.button, "New chat").tap()
        XCTAssertTrue(el(.staticText, "How can I help?").waitForExistence(timeout: 10))
        shot("14-empty-state")
        el(.button, "Audit glass contrast").tap()
        XCTAssertTrue(el(.staticText, "Currently working…").waitForExistence(timeout: 12)
                      || el(.button, "Stop generating").waitForExistence(timeout: 12),
                      "tapping a suggestion should send it and start a run")
        if el(.button, "Stop generating").exists { el(.button, "Stop generating").tap() }
    }

    // MARK: Finished-message actions: thumbs + share sheet

    func testMessageActions() {
        XCTAssertTrue(lastEl(.button, "Good response").waitForExistence(timeout: 12))
        lastEl(.button, "Good response").tap()
        lastEl(.button, "Share").tap()
        XCTAssertTrue(el(.any, "Save to Files").waitForExistence(timeout: 12),
                      "ShareLink should present the share sheet")
        shot("15-share-sheet")
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
        start.press(forDuration: 0.05, thenDragTo: end)
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 10),
                      "share sheet should dismiss back to the chat")
    }

    // MARK: Long-press user bubble → Edit restores the composer

    func testEditFromBubbleContextMenu() {
        setEffortLow()
        el(.button, "New chat").tap()
        let field = composerField
        field.tap()
        field.typeText("Audit glass contrast")
        el(.button, "Send message").tap()
        let bubble = elContains(.any, "You said: Audit glass contrast")
        XCTAssertTrue(bubble.waitForExistence(timeout: 12))
        // Let the short low-effort run finish rather than racing it with a
        // Stop tap (exists-then-tap can land after the run already ended).
        let stop = el(.button, "Stop generating")
        let settled = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: stop)
        wait(for: [settled], timeout: 45)

        bubble.press(forDuration: 1.2)
        XCTAssertTrue(el(.button, "Edit").waitForExistence(timeout: 10),
                      "context menu should offer Edit")
        shot("16-context-menu")
        el(.button, "Edit").tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 10),
                      "Edit should restore the prompt into the composer")
        shot("17-edit-restored")
    }

    // MARK: Photos / Files pickers cancel back into the open tray

    /// System pickers run out of process; their Cancel lives in the
    /// SpringBoard tree, not the app's. Poll both scopes.
    private func waitForPickerCancel() -> XCUIElement? {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            let sb = springboard.buttons["Cancel"]
            if sb.exists { return sb }
            let local = el(.button, "Cancel")
            if local.exists { return local }
            Thread.sleep(forTimeInterval: 0.4)
        }
        return nil
    }

    /// Cancels a system picker and proves the tray is topmost again
    /// (Plan hittable, not merely present under the sheet). Retries
    /// the Cancel tap once if dismissal raced.
    private func cancelPickerBackToTray() -> Bool {
        for _ in 0..<2 {
            guard let cancel = waitForPickerCancel() else {
                return el(.button, "Plan").exists && el(.button, "Plan").isHittable
            }
            cancel.tap()
            let deadline = Date().addingTimeInterval(10)
            while Date() < deadline {
                let plan = el(.button, "Plan")
                if plan.exists && plan.isHittable { return true }
                Thread.sleep(forTimeInterval: 0.4)
            }
        }
        return false
    }

    func testPickerCancelReturnsToTray() {
        el(.button, "Add photos, files and more").tap()
        XCTAssertTrue(el(.button, "Plan").waitForExistence(timeout: 15), "tray should open")

        tapReliably(el(.button, "Photos"))
        XCTAssertNotNil(waitForPickerCancel(), "photo picker should present")
        shot("18-photo-picker")
        XCTAssertTrue(cancelPickerBackToTray(),
                      "cancelling Photos should return to the tray, not close it")
        shot("19-back-in-tray")

        tapReliably(el(.button, "Files"))
        XCTAssertNotNil(waitForPickerCancel(), "document picker should present")
        shot("20-file-picker")
        XCTAssertTrue(cancelPickerBackToTray(),
                      "cancelling Files should return to the tray, not close it")
        shot("21-back-in-tray-files")
    }

    // MARK: Agent prose is selectable like regular text

    func testAgentTextIsSelectable() {
        let prose = elContains(.staticText, "One more check")
        XCTAssertTrue(prose.waitForExistence(timeout: 12))
        prose.press(forDuration: 1.6)
        XCTAssertTrue(el(.button, "Copy").waitForExistence(timeout: 12),
                      "long-pressing agent prose should offer Copy")
        // Look Up only appears for a native range selection (a word under
        // the finger with handles), not a whole-block Copy/Share menu.
        XCTAssertTrue(el(.any, "Look Up").waitForExistence(timeout: 4),
                      "agent prose should select a range like regular text")
        shot("27-text-selection")
    }

    // MARK: Camera affordances

    func testCameraButtonFadesWhenTyping() {
        XCTAssertTrue(el(.button, "Take photo").waitForExistence(timeout: 12),
                      "camera should sit next to the microphone while idle")
        el(.button, "Add photos, files and more").tap()
        XCTAssertTrue(el(.button, "Live camera preview").waitForExistence(timeout: 12),
                      "first gallery item should be the live camera preview")
        shot("25-live-camera-tile")
        el(.button, "Close add menu").tap()

        let field = composerField
        field.tap()
        field.typeText("Hi")
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 8))
        XCTAssertFalse(el(.button, "Take photo").exists,
                       "camera should fade out once typing starts")
        shot("26-camera-faded")
    }

    // MARK: Stress — many attachments + long prompt, streamed end to end

    func testManyAttachmentsLongMessageStreams() {
        setEffortLow()
        el(.button, "New chat").tap()
        XCTAssertTrue(el(.staticText, "How can I help?").waitForExistence(timeout: 10))

        el(.button, "Add photos, files and more").tap()
        XCTAssertTrue(el(.button, "Plan").waitForExistence(timeout: 15))
        for name in ["Screenshot 1", "Screenshot 2", "Screenshot 3"] {
            let thumb = el(.button, name)
            XCTAssertTrue(thumb.waitForExistence(timeout: 12), "\(name) should load")
            tapReliably(thumb)
        }
        XCTAssertTrue(el(.button, "Add 3").waitForExistence(timeout: 8))
        el(.button, "Add 3").tap()
        let removeCount = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Remove")).count
        XCTAssertGreaterThanOrEqual(removeCount, 3, "composer should carry all three attachments")
        shot("22-many-attachments")

        let field = composerField
        field.tap()
        field.typeText("Audit the whole glass stack end to end, every layer, every token, "
            + "every spring, and do not stop until the contrast math is proven for each surface. "
            + "Also check the tray, the chips, the command cards, and the history rows.")
        el(.button, "Send message").tap()
        XCTAssertTrue(el(.button, "Stop generating").waitForExistence(timeout: 12)
                      || el(.staticText, "Currently working…").exists,
                      "run should start with three attachments attached")
        shot("23-stress-running")

        XCTAssertTrue(elBegins(.staticText, "Worked for").waitForExistence(timeout: 60),
                      "streamed activity should finish")
        XCTAssertTrue(el(.button, "Retry").waitForExistence(timeout: 12),
                      "finished stress turn should show its action row")
        shot("24-stress-finished")
        if el(.button, "Stop generating").exists { el(.button, "Stop generating").tap() }
    }
}
