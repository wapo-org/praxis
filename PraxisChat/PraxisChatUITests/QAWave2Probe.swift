import XCTest

/// Wave-2 final QA probe (not part of the regular suite): one pose per
/// user item, run once per appearance. Skipped unless `PRAXIS_QA` is set
/// (`TEST_RUNNER_PRAXIS_QA=1 xcodebuild test
/// -only-testing:…/QAWave2Probe`). Writes PNGs to $PRAXIS_QA_DIR (or
/// /tmp/praxis-qa-shots/). Set the simulator appearance before each run.
/// Poses assert the must-hold behavior AND save screenshots for eyeball
/// verification; continueAfterFailure stays true so one bad pose can't
/// hide the rest.
final class QAWave2Probe: XCTestCase {
    var app: XCUIApplication!
    var outDir: String!

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_QA"] != nil, "qa probe")
        continueAfterFailure = true
        outDir = ProcessInfo.processInfo.environment["PRAXIS_QA_DIR"] ?? "/tmp/praxis-qa-shots"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
    }

    // MARK: Helpers

    private func launch(_ extra: [String] = [], resetData: Bool = true) {
        app = XCUIApplication()
        // A previous xcodebuild invocation may have left the app running;
        // launch() on a running app is a no-op and the stale process keeps
        // its old launch args (this ran the demo engine under scripted
        // args once). Always terminate first so the args below take.
        app.terminate()
        if resetData { app.launchArguments += ["-PraxisResetData", "YES"] }
        app.launchArguments += extra
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
        Thread.sleep(forTimeInterval: 1.0)
    }

    private func save(_ name: String) {
        Thread.sleep(forTimeInterval: 0.6)
        let shot = app.screenshot()
        try? shot.pngRepresentation.write(to: URL(fileURLWithPath: "\(outDir)/\(name).png"))
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func el(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        app.descendants(matching: type).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func elContains(_ type: XCUIElement.ElementType, _ text: String) -> XCUIElement {
        app.descendants(matching: type).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func elBegins(_ type: XCUIElement.ElementType, _ text: String) -> XCUIElement {
        app.descendants(matching: type).matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
    }

    private func field(_ label: String) -> XCUIElement {
        let tv = app.textViews[label]
        return tv.exists ? tv : app.textFields[label]
    }

    private func fieldText(_ label: String = "Message") -> String {
        let value = (field(label).value as? String) ?? ""
        return value == "Plan, ask, build..." ? "" : value
    }

    private func tapWhenHittable(_ element: XCUIElement, timeout: TimeInterval = 10) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists, element.isHittable { element.tap(); return }
            Thread.sleep(forTimeInterval: 0.3)
        }
        XCTFail("element never became hittable: \(element)")
    }

    private func openTray() {
        el(.button, "Add photos, files and more").tap()
        XCTAssertTrue(el(.button, "Plan").waitForExistence(timeout: 15), "tray should open")
    }

    private func openModelPage() {
        openTray()
        elBegins(.button, "Model, ").tap()
        XCTAssertTrue(el(.button, "Atlas Mini, Fastest answers").waitForExistence(timeout: 15))
    }

    private func openSettings() {
        el(.button, "History").tap()
        let options = el(.button, "History options")
        XCTAssertTrue(options.waitForExistence(timeout: 10))
        options.tap()
        el(.button, "Settings").tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
    }

    private func scrollTo(_ element: XCUIElement, swipes: Int = 8) {
        for _ in 0..<swipes {
            if element.waitForExistence(timeout: 1), element.isHittable { return }
            app.swipeUp()
        }
    }

    private func startRecording() {
        el(.button, "New chat").tap()
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 10))
        el(.button, "Record voice message").tap()
        XCTAssertTrue(el(.button, "Stop and transcribe").waitForExistence(timeout: 10),
                      "mic should open the recording UI")
    }

    // MARK: Items 1+7 — progressive blur

    func testQAChatEdges() {
        launch(["-PraxisLongThread", "YES"])
        save("qa-chat-0-launch-bottom")
        // Nudge dense text up through the bottom feather zone.
        for i in 0..<3 {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.55))
            let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.72))
            start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
            Thread.sleep(forTimeInterval: 0.8)
            save("qa-chat-bottom-\(i)")
        }
        // Scroll down so content passes under the top title bar.
        app.swipeDown()
        Thread.sleep(forTimeInterval: 0.8)
        save("qa-chat-top-1")
        app.swipeDown()
        Thread.sleep(forTimeInterval: 0.8)
        save("qa-chat-top-2")
    }

    func testQAScrolledViews() {
        launch(["-PraxisLongThread", "YES"])
        // History with enough rows to scroll under its header.
        for _ in 0..<8 {
            el(.button, "History").tap()
            Thread.sleep(forTimeInterval: 0.5)
            let next = el(.button, "New chat")
            if next.waitForExistence(timeout: 5) { next.tap() }
            Thread.sleep(forTimeInterval: 0.5)
        }
        el(.button, "History").tap()
        Thread.sleep(forTimeInterval: 0.8)
        save("qa-history-0")
        app.swipeUp()
        Thread.sleep(forTimeInterval: 0.8)
        save("qa-history-1-scrolled")
        el(.button, "New chat").tap()
        Thread.sleep(forTimeInterval: 0.6)

        openSettings()
        save("qa-settings-0-root")
        app.swipeUp()
        Thread.sleep(forTimeInterval: 0.8)
        save("qa-settings-1-scrolled")
        el(.button, "Skills").tap()
        XCTAssertTrue(app.navigationBars["Skills"].waitForExistence(timeout: 10))
        save("qa-settings-2-skills")
        app.navigationBars["Skills"].buttons.firstMatch.tap()
        el(.button, "Connectors").tap()
        XCTAssertTrue(app.navigationBars["Connectors"].waitForExistence(timeout: 10))
        save("qa-settings-3-connectors")
    }

    /// The provider editor is the longest settings form: content scrolling
    /// under its nav bar proves the pinned top edge on nav-bar screens.
    func testQAProviderEditor() {
        launch()
        openSettings()
        el(.button, "Add provider").tap()
        Thread.sleep(forTimeInterval: 0.8)
        let preset = el(.any, "Anthropic")
        XCTAssertTrue(preset.waitForExistence(timeout: 5))
        preset.tap()
        XCTAssertTrue(app.navigationBars["Add provider"].waitForExistence(timeout: 10))
        Thread.sleep(forTimeInterval: 0.8)
        save("qa-settings-4-editor-top")
        app.swipeUp()
        Thread.sleep(forTimeInterval: 0.8)
        save("qa-settings-5-editor-scrolled")
    }

    // MARK: Item 2 — per-chat drafts + photo selection

    func testQATrayDraftIsolation() {
        launch(["-PraxisMockGallery", "YES"])
        app.buttons["New chat"].tap()
        // Title chat A first so History can find it again.
        field("Message").tap()
        field("Message").typeText("chat A title")
        el(.button, "Send message").tap()
        let stop = el(.button, "Stop generating")
        if stop.waitForExistence(timeout: 12) { stop.tap() }
        field("Message").tap()
        field("Message").typeText("chat A draft")
        openTray()
        let thumb = el(.button, "Screenshot 1")
        XCTAssertTrue(thumb.waitForExistence(timeout: 12), "mock gallery should load")
        tapWhenHittable(thumb)
        XCTAssertTrue(el(.button, "Add 1").waitForExistence(timeout: 8))
        el(.button, "Add 1").tap()
        XCTAssertTrue(elBegins(.button, "Remove").waitForExistence(timeout: 8))
        save("qa-tray-0-chatA-attached")
        // Attaching auto-dismisses the tray; close only if still open.
        if el(.button, "Close add menu").waitForExistence(timeout: 2) {
            el(.button, "Close add menu").tap()
        }

        // New chat: composer empty, tray fresh, system picker unselected.
        app.buttons["New chat"].tap()
        XCTAssertTrue(el(.staticText, "How can I help?").waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove")).count, 0)
        XCTAssertEqual(fieldText(), "")
        openTray()
        // The tray's "Add N" attach button only (not the empty state's
        // "Add haptics to buttons" suggestion, which also begins with "Add ").
        let addCount = app.descendants(matching: .button)
            .matching(NSPredicate(format: "label MATCHES %@", "Add [0-9]+")).firstMatch
        XCTAssertFalse(addCount.exists, "nothing stays checked in the new chat")
        save("qa-tray-1-newchat-fresh")

        // The system photo picker also opens with no selection carried over.
        el(.button, "Photos").tap()
        Thread.sleep(forTimeInterval: 2.0)
        save("qa-tray-2-system-picker")
        // Dismiss the picker: Cancel, or tap outside.
        let cancel = app.buttons["Cancel"]
        if cancel.waitForExistence(timeout: 3) { cancel.tap() } else { app.tap() }
        Thread.sleep(forTimeInterval: 1.0)
        if el(.button, "Close add menu").waitForExistence(timeout: 2) {
            el(.button, "Close add menu").tap()
        }

        // Back to chat A via History: draft + attachment restored.
        el(.button, "History").tap()
        let row = el(.button, "chat A title")
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the titled chat is in History")
        row.tap()
        XCTAssertTrue(elBegins(.button, "Remove").waitForExistence(timeout: 8),
                      "returning restores the attachment")
        XCTAssertEqual(fieldText(), "chat A draft", "returning restores the text")
        save("qa-tray-3-chatA-restored")
    }

    // MARK: Item 9 — real gallery + item 10 — solid buttons

    func testQARealGallery() {
        launch() // no mock flag: the real photo library
        openTray()
        // First open asks for Photos access (SpringBoard prompt, sim-only).
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow Full Access"]
        if allow.waitForExistence(timeout: 8) {
            save("qa-gallery-0-prompt")
            allow.tap()
        }
        let photo = elBegins(.button, "Photo ")
        XCTAssertTrue(photo.waitForExistence(timeout: 15), "real photos should load, not mock tiles")
        XCTAssertFalse(el(.button, "Screenshot 1").exists, "no mock tiles without the mock flag")
        save("qa-gallery-1-real")
        tapWhenHittable(photo)
        XCTAssertTrue(el(.button, "Add 1").waitForExistence(timeout: 8))
        save("qa-gallery-2-checked")
        el(.button, "Add 1").tap()
        XCTAssertTrue(elBegins(.button, "Remove").waitForExistence(timeout: 15),
                      "full-res attach lands in the composer")
        if el(.button, "Close add menu").waitForExistence(timeout: 2) {
            el(.button, "Close add menu").tap()
        }
        save("qa-composer-0-solid-buttons")
    }

    // MARK: Items 3+4 — model search + pin favorites

    func testQAModelSearch() {
        launch(["-PraxisDemoModels", "400"])
        field("Message").tap()
        field("Message").typeText("keep me")
        openModelPage()
        let search = field("Search models")
        XCTAssertTrue(search.waitForExistence(timeout: 10), "the composer becomes the search field")
        XCTAssertFalse(el(.button, "Send message").exists, "no send button while searching")
        search.tap()
        search.typeText("mini")
        XCTAssertTrue(el(.button, "Atlas Mini, Fastest answers").waitForExistence(timeout: 10))
        XCTAssertFalse(el(.button, "Atlas Pro, Deepest reasoning").exists, "non-matches are filtered out")
        save("qa-picker-0-query")
        el(.button, "Clear search").tap()
        XCTAssertTrue(el(.button, "Atlas Pro, Deepest reasoning").waitForExistence(timeout: 10))
        save("qa-picker-1-cleared")

        // Long-press → pin menu → Favorites.
        let row = el(.button, "Atlas Mini, Fastest answers")
        row.press(forDuration: 1.0)
        XCTAssertTrue(el(.button, "Pin to Favorites").waitForExistence(timeout: 8))
        save("qa-picker-2-pin-menu")
        el(.button, "Pin to Favorites").tap()
        XCTAssertTrue(el(.staticText, "Favorites").waitForExistence(timeout: 8))
        save("qa-picker-3-favorites")

        // Leaving the page restores the draft byte-for-byte.
        el(.button, "Back").tap()
        XCTAssertTrue(field("Message").waitForExistence(timeout: 10))
        XCTAssertEqual(fieldText(), "keep me")
        el(.button, "Close add menu").tap()
        XCTAssertEqual(fieldText(), "keep me")
    }

    // MARK: Item 5 — voice

    private func openVoiceSettings() {
        openSettings()
        let row = el(.button, "Voice input")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        if !row.isHittable { app.swipeUp() }
        row.tap()
        XCTAssertTrue(app.navigationBars["Voice input"].waitForExistence(timeout: 10))
    }

    func testQAVoiceNoKeyRoutesToSettings() {
        // Real transcriber (no fake transcript), no key saved. The Keychain
        // survives -PraxisResetData by design, so remove any leftover key
        // from earlier runs first.
        launch(["-PraxisFakeRecording", "voice-fake.m4a"])
        openVoiceSettings()
        let remove = el(.button, "Remove saved key")
        if remove.waitForExistence(timeout: 3) { remove.tap() }
        XCTAssertTrue(el(.secureTextField, "Groq API key").waitForExistence(timeout: 5))
        app.navigationBars.buttons["Settings"].tap()
        let done = el(.button, "Done")
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        done.tap()
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 10))
        startRecording()
        save("qa-voice-0-recording")
        el(.button, "Stop and transcribe").tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10),
                      "transcribing without a key routes to Settings")
        save("qa-voice-1-settings-routed")
        el(.button, "Done").tap()
        Thread.sleep(forTimeInterval: 1.0)
        // The audio is kept: review row offers transcribe/play/delete.
        XCTAssertTrue(el(.button, "Transcribe recording").waitForExistence(timeout: 8),
                      "audio is kept when no key is configured")
        XCTAssertTrue(elContains(.staticText, "Groq API key").exists)
        save("qa-voice-2-kept")
    }

    func testQAVoiceSettings() {
        launch(["-PraxisFakeGroqModels", "YES"])
        openVoiceSettings()
        XCTAssertTrue(el(.button, "Use model whisper-large-v3-turbo").waitForExistence(timeout: 10))
        XCTAssertTrue(el(.secureTextField, "Groq API key").exists)
        save("qa-voice-3-settings")
    }

    func testQAVoiceRecovery() {
        launch(["-PraxisFakeRecording", "voice-fake.m4a",
                "-PraxisFakeTranscript", "recovered words"])
        startRecording()
        el(.button, "Stop and review").tap()
        XCTAssertTrue(el(.button, "Transcribe recording").waitForExistence(timeout: 8))
        // Relaunch keeping recordings: the banner offers the pending audio.
        app.terminate()
        launch(["-PraxisFakeRecording", "voice-fake.m4a",
                "-PraxisFakeTranscript", "recovered words"], resetData: false)
        let banner = elContains(.button, "Review")
        XCTAssertTrue(banner.waitForExistence(timeout: 10), "untranscribed audio banners on next launch")
        save("qa-voice-4-recovery-banner")

        // Review fix R6: the same pending recording must also appear in
        // Settings → Voice input → Recordings (used to always say "No
        // recordings").
        openVoiceSettings()
        el(.button, "Recordings").tap()
        XCTAssertTrue(app.navigationBars["Recordings"].waitForExistence(timeout: 10))
        XCTAssertFalse(elContains(.staticText, "No recordings").exists,
                       "the pending recording is listed, not an empty state")
        XCTAssertTrue(elContains(.button, "Transcribe recording from").waitForExistence(timeout: 8))
        save("qa-voice-5-recordings-list")
    }

    // MARK: Item 6 — per-tool MCP toggles

    func testQAMCPTools() {
        launch(["-PraxisMockConnector", "YES"])
        openSettings()
        el(.button, "Connectors").tap()
        XCTAssertTrue(app.navigationBars["Connectors"].waitForExistence(timeout: 10))
        elContains(.button, "Mock Server").tap()
        XCTAssertTrue(app.navigationBars["Mock Server"].waitForExistence(timeout: 10))
        scrollTo(el(.button, "Disable all tools"))
        let search = app.switches.matching(identifier: "toolToggle.search_docs").firstMatch
        scrollTo(search)
        XCTAssertEqual(search.value as? String, "1")
        save("qa-mcptools-0-all-on")
        search.tap()
        XCTAssertTrue(el(.staticText, "2 of 3 on").waitForExistence(timeout: 5))
        save("qa-mcptools-1-one-off")
    }

    // MARK: Item 8 — per-model reasoning effort

    func testQAEffort() {
        launch()
        openTray()
        for level in ["Low", "Medium", "High", "Max"] {
            XCTAssertTrue(el(.button, level).waitForExistence(timeout: 10))
        }
        el(.button, "Max").tap()
        save("qa-effort-0-all-four")
        elBegins(.button, "Model, ").tap()
        XCTAssertTrue(el(.button, "Atlas Mini, Fastest answers").waitForExistence(timeout: 15))
        el(.button, "Atlas Mini, Fastest answers").tap()
        el(.button, "Back").tap()
        XCTAssertTrue(el(.button, "High").waitForExistence(timeout: 10))
        XCTAssertEqual(el(.button, "High").value as? String, "Selected")
        XCTAssertFalse(el(.button, "Max").exists, "unsupported levels are not shown")
        save("qa-effort-1-three-levels")
        elBegins(.button, "Model, ").tap()
        el(.button, "Atlas Chat, Quick chat, no reasoning").tap()
        el(.button, "Back").tap()
        XCTAssertTrue(el(.button, "Model, Atlas Chat").waitForExistence(timeout: 10))
        for level in ["Low", "Medium", "High", "Max"] {
            XCTAssertFalse(el(.button, level).exists, "\(level) hides for a no-reasoning model")
        }
        save("qa-effort-2-hidden")
    }

    // MARK: Item 11 — background + Live Activity

    private var springboard: XCUIApplication {
        XCUIApplication(bundleIdentifier: "com.apple.springboard")
    }

    /// The compact island's trailing text carries the run summary;
    /// the cover sheet shows the chat title. Either proves the
    /// activity is live (same predicate as LiveActivityUITests).
    private func activityVisible(title: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let hit = springboard.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
            if hit.exists { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
    }

    /// Cover sheet first (foregrounded: no background-expiry race),
    /// then the island (backgrounded). The operator shoots both with
    /// simctl from the Mac side while the sleeps hold the poses.
    /// Swipes go through SpringBoard coordinates — app coordinates
    /// don't dispatch while the app is backgrounded.
    func testQABackgroundIslandAndCover() {
        launch(["-PraxisEngine", "scripted", "-PraxisLongRun", "YES"])
        let probe = "island-\(UUID().uuidString.prefix(6))"
        el(.button, "New chat").tap()
        XCTAssertTrue(el(.staticText, "How can I help?").waitForExistence(timeout: 10))
        field("Message").tap()
        field("Message").typeText(probe)
        el(.button, "Send message").tap()
        XCTAssertTrue(el(.button, "Stop generating").waitForExistence(timeout: 15),
                      "the long run should start")
        // Pose 1: cover sheet over the foreground app.
        let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.02))
        let mid = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
        top.press(forDuration: 0.1, thenDragTo: mid, withVelocity: .slow, thenHoldForDuration: 0.3)
        Thread.sleep(forTimeInterval: 2.0)
        XCTAssertTrue(activityVisible(title: probe, timeout: 15),
                      "the cover sheet should show the running chat")
        Thread.sleep(forTimeInterval: 10) // pose 1: cover sheet with the activity
        let up = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8))
        let edge = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05))
        up.press(forDuration: 0.1, thenDragTo: edge, withVelocity: .fast, thenHoldForDuration: 0.1)
        Thread.sleep(forTimeInterval: 1.0)
        // Pose 2: the island (own-app activities render only
        // backgrounded, so Home first, then shoot fast — sim
        // background grace is short and unpredictable).
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(activityVisible(title: probe, timeout: 15),
                      "the run's activity should appear in the island once backgrounded")
        Thread.sleep(forTimeInterval: 8) // pose 2: island on the home screen
        app.activate()
        if el(.button, "Stop generating").waitForExistence(timeout: 10) {
            el(.button, "Stop generating").tap()
        }
    }

    func testQABackgroundPausedContinue() {
        launch(["-PraxisEngine", "scripted", "-PraxisLongRun", "YES",
                "-PraxisSimulateBackgroundExpiry", "YES"])
        field("Message").tap()
        field("Message").typeText("pause probe run")
        el(.button, "Send message").tap()
        XCTAssertTrue(el(.button, "Stop generating").waitForExistence(timeout: 15)
                      || el(.staticText, "Currently working…").waitForExistence(timeout: 15))
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 8)
        app.activate()
        XCTAssertTrue(el(.staticText, "Paused in background").waitForExistence(timeout: 20))
        XCTAssertTrue(elContains(.staticText, "Stopped after").waitForExistence(timeout: 10))
        save("qa-bg-0-paused")
        let cont = el(.button, "Continue")
        XCTAssertTrue(cont.waitForExistence(timeout: 10))
        cont.tap()
        XCTAssertTrue(el(.button, "Stop generating").waitForExistence(timeout: 15)
                      || el(.staticText, "Currently working…").waitForExistence(timeout: 15),
                      "Continue starts a fresh run")
        XCTAssertTrue(el(.staticText, "Paused in background").exists)
        save("qa-bg-1-continued")
        if el(.button, "Stop generating").exists { el(.button, "Stop generating").tap() }
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 15))
    }

    // MARK: Cross-feature

    /// Recording wins over model search: opening the Model page mid-recording
    /// must not show the search field, and the transcript must land intact.
    func testQACrossRecordModelPage() {
        launch(["-PraxisFakeRecording", "voice-fake.m4a",
                "-PraxisFakeTranscript", "cross check", "-PraxisDemoModels", "400"])
        startRecording()
        el(.button, "Add photos, files and more").tap()
        XCTAssertTrue(el(.button, "Plan").waitForExistence(timeout: 15))
        elBegins(.button, "Model, ").tap()
        XCTAssertTrue(el(.button, "Atlas Mini, Fastest answers").waitForExistence(timeout: 15))
        XCTAssertTrue(el(.button, "Stop and transcribe").exists, "recording UI owns the composer")
        XCTAssertFalse(field("Search models").exists, "no search field while recording")
        save("qa-cross-0-record-modelpage")
        el(.button, "Back").tap()
        el(.button, "Close add menu").tap()
        el(.button, "Stop and transcribe").tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 15))
        XCTAssertEqual(fieldText(), "cross check", "no audio lost across the tray excursion")
    }

    /// The tray opens and closes fine mid-recording; cancelling then settles.
    func testQACrossTrayWhileRecording() {
        launch(["-PraxisFakeRecording", "voice-fake.m4a",
                "-PraxisFakeTranscript", "tray cross"])
        startRecording()
        el(.button, "Add photos, files and more").tap()
        XCTAssertTrue(el(.button, "Plan").waitForExistence(timeout: 15))
        save("qa-cross-1-tray-while-recording")
        el(.button, "Close add menu").tap()
        XCTAssertTrue(el(.button, "Stop and transcribe").waitForExistence(timeout: 8))
        el(.button, "Cancel recording").tap()
        let alert = app.alerts["Discard this recording?"]
        if alert.waitForExistence(timeout: 3) { alert.buttons["Discard"].tap() }
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 8))
    }

    /// Backgrounding mid-recording keeps the session alive; the transcript
    /// still lands afterwards.
    func testQACrossBackgroundWhileRecording() {
        launch(["-PraxisFakeRecording", "voice-fake.m4a",
                "-PraxisFakeTranscript", "background kept"])
        startRecording()
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 6)
        app.activate()
        XCTAssertTrue(el(.button, "Stop and transcribe").waitForExistence(timeout: 10),
                      "recording survives backgrounding")
        save("qa-cross-2-recording-after-background")
        el(.button, "Stop and transcribe").tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 15))
        XCTAssertEqual(fieldText(), "background kept", "no audio lost across backgrounding")
    }

    /// Pending review audio + a long run: transcribe the review into the
    /// draft, send the run, stop it — the transcript must survive as the
    /// sent text and nothing may crash.
    func testQACrossLongRunVoicePending() {
        launch(["-PraxisEngine", "scripted", "-PraxisLongRun", "YES",
                "-PraxisFakeRecording", "voice-fake.m4a",
                "-PraxisFakeTranscript", "voice drove this run"])
        startRecording()
        el(.button, "Stop and review").tap()
        XCTAssertTrue(el(.button, "Transcribe recording").waitForExistence(timeout: 8))
        el(.button, "Transcribe recording").tap()
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 15))
        XCTAssertEqual(fieldText(), "voice drove this run")
        save("qa-cross-3-review-transcribed")
        el(.button, "Send message").tap()
        XCTAssertTrue(el(.button, "Stop generating").waitForExistence(timeout: 15)
                      || el(.staticText, "Currently working…").waitForExistence(timeout: 15),
                      "the long run starts on the voice draft")
        XCTAssertTrue(elContains(.any, "voice drove this run").waitForExistence(timeout: 10))
        save("qa-cross-4-longrun-on-voice")
        if el(.button, "Stop generating").exists { el(.button, "Stop generating").tap() }
    }
}
