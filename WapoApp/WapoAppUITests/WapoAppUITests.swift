import XCTest

/// One uninterrupted end-to-end pass over the public UI:
/// empty -> new chat -> composer -> streaming -> limit -> settings -> error.
/// Requires the local API double on http://localhost:8000.
final class WapoAppUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        // One-time system dictation/Siri consent prompts on fresh
        // simulators must not poison the pass.
        addUIInterruptionMonitor(withDescription: "System prompts") { el in
            for label in ["Not Now", "Cancel", "Close"] {
                let b = el.buttons[label]
                if b.exists { b.tap(); return true }
            }
            return false
        }
        app = XCUIApplication()
        app.launch()
    }

    /// Dismiss Springboard-level consent sheets if present.
    private func dismissSystemSheets() {
        let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if sb.buttons["Not Now"].exists { sb.buttons["Not Now"].tap() }
        if sb.staticTexts["Siri, Dictation & Privacy"].exists {
            let x = sb.buttons.element(boundBy: 0)
            if x.exists { x.tap() }
        }
    }

    private func snap(_ name: String) {
        let att = XCTAttachment(screenshot: app.screenshot())
        att.name = name
        att.lifetime = .keepAlways
        add(att)
    }

    private func wait(_ el: XCUIElement, _ timeout: TimeInterval = 15,
                      file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(el.waitForExistence(timeout: timeout),
                      "missing: \(el)", file: file, line: line)
    }

    func testFullPass() throws {
        // 1. Empty state
        wait(app.staticTexts["How can I help?"])
        snap("01-empty")

        // 2. Sidebar: New chat action
        let newChat = app.buttons["New chat"]
        wait(newChat)
        newChat.tap()
        wait(app.staticTexts["How can I help?"])
        snap("02-new-chat")

        // 3. Composer entry + send
        let composer = app.textViews.firstMatch.exists
            ? app.textViews.firstMatch : app.textFields.firstMatch
        wait(composer)
        composer.tap()
        composer.typeText("hi there")

        let send = app.buttons["Send message"]
        wait(send)
        let t0 = ContinuousClock.now
        send.tap()

        // 4. Streaming state: stop control + paced multi-frame text assembly
        let stop = app.buttons["Stop generating"]
        wait(stop, 10)
        snap("03-streaming-early")
        Thread.sleep(forTimeInterval: 1.4)
        snap("04-streaming-mid")
        let full = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "Hello from local API")).firstMatch
        wait(full, 25)
        let elapsed = ContinuousClock.now - t0
        print("STREAM_TIMING first-to-full: \(elapsed)")
        let gone = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: stop)
        XCTAssertEqual(XCTWaiter.wait(for: [gone], timeout: 10), .completed,
                       "stop control should dismiss at message_stop")
        snap("05-streaming-done")

        // 5. Limit state (local API returns 429 for 'limit')
        composer.tap()
        composer.typeText("limit check")
        wait(send)
        send.tap()
        let limit = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "reached the usage limit")).firstMatch
        wait(limit, 15)
        snap("06-limit")

        // 6. Settings controls: point base URL at a dead port, then Done.
        // Keyboard covers the sidebar bottom toolbar; dismiss it first or
        // the tap lands on the keyboard dictation key (system alert).
        dismissSystemSheets()
        let settings = app.buttons["Settings"]
        wait(settings)
        if !settings.isHittable {
            let hideKB = app.keyboards.buttons["Hide keyboard"]
            if hideKB.exists {
                hideKB.tap()
            } else {
                // Drag the transcript (ScrollView dismisses keyboard).
                app.staticTexts["Hello from local API"].swipeDown()
            }
            Thread.sleep(forTimeInterval: 0.6)
        }
        for _ in 0..<3 where !settings.isHittable {
            app.staticTexts["Hello from local API"].swipeDown()
            Thread.sleep(forTimeInterval: 0.4)
        }
        XCTAssertTrue(settings.isHittable, "Settings button not hittable")
        settings.tap()
        snap("06b-after-settings-tap")
        print("HIERARCHY_AFTER_SETTINGS_TAP:\n\(app.debugDescription)")
        wait(app.navigationBars["Settings"], 10)
        let baseField = app.textFields["settings.baseURL"]
        wait(baseField)
        baseField.tap()
        baseField.typeText("http://localhost:9")
        snap("07-settings")
        let done = app.buttons["settings.done"]
        wait(done)
        done.tap()

        // 7. Error state (unreachable local API)
        composer.tap()
        composer.typeText("hello again")
        wait(send)
        send.tap()
        let err = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "reach the local API")).firstMatch
        wait(err, 20)
        snap("08-error")
    }
}
