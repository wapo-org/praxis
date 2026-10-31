import XCTest

/// Recording probe for the send animation (not part of the regular suite):
/// drives sends while `simctl io recordVideo` captures the screen on the
/// host. Skipped unless `PRAXIS_SENDPROBE` is set
/// (`TEST_RUNNER_PRAXIS_SENDPROBE=1 xcodebuild test -only-testing:…/SendFlightProbe`).
/// Each send writes a wall-clock marker to /tmp/praxis-sendprobe/markers.txt.
final class SendFlightProbe: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_SENDPROBE"] != nil, "Optional send performance capture requires PRAXIS_SENDPROBE")
        continueAfterFailure = true
    }

    private func mark(_ label: String) {
        let line = "\(label) \(Date().timeIntervalSince1970)\n"
        print("SENDPROBE \(line)", terminator: "")
        let url = URL(fileURLWithPath: "/tmp/praxis-sendprobe/markers.txt")
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try? handle.close()
        } else {
            try? Data(line.utf8).write(to: url)
        }
    }

    private func launch(_ extra: [String] = []) {
        app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES"] + (extra.contains("-PraxisEngine") || extra.contains("-PraxisTestProviderURL") ? [] : ["-PraxisEngine", "demo"]) + extra
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
    }

    private var field: XCUIElement {
        let tv = app.textViews["Message"]
        return tv.exists ? tv : app.textFields["Message"]
    }

    private func send(_ label: String) {
        Thread.sleep(forTimeInterval: 0.8)
        mark(label)
        app.buttons["Send message"].tap()
        Thread.sleep(forTimeInterval: 2.0)
        if app.buttons["Stop generating"].exists { app.buttons["Stop generating"].tap() }
        Thread.sleep(forTimeInterval: 0.6)
    }

    /// Scrolls up a little so the next send also exercises the jump
    /// back to the bottom. (The keyboard stays up: the drag that fits
    /// above the composer is too short to complete the interactive
    /// scroll dismiss, and focus survives backgrounding. The
    /// attachment-only send covers the keyboard-down geometry.)
    private func scrollUpFromBottom() {
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.35))
        from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)))
        Thread.sleep(forTimeInterval: 0.6)
    }

    func testLongThreadKeyboardUpAndDown() {
        launch(["-PraxisLongThread", "YES"])
        Thread.sleep(forTimeInterval: 1)
        field.tap()
        field.typeText("Short one")
        send("long-kbup-short")
        field.tap()
        field.typeText("A longer message that wraps over a couple of lines in the bubble so the flight has height")
        send("long-kbup-wrap")
        field.tap()
        field.typeText("Sent while scrolled up")
        scrollUpFromBottom()
        send("long-scrolled")
    }

    func testEmptyChatAndAttachments() {
        launch()
        app.buttons["New chat"].tap()
        XCTAssertTrue(app.staticTexts["How can I help?"].waitForExistence(timeout: 10))
        field.tap()
        field.typeText("Hello from an empty chat")
        send("empty-kbup")

        app.buttons["New chat"].tap()
        app.buttons["Add photos, files and more"].tap()
        for name in ["Screenshot 1", "Screenshot 2"] {
            let thumb = app.buttons[name]
            XCTAssertTrue(thumb.waitForExistence(timeout: 12))
            thumb.tap()
        }
        let add = app.buttons["Add 2"]
        XCTAssertTrue(add.waitForExistence(timeout: 8))
        add.tap()
        Thread.sleep(forTimeInterval: 0.8)
        field.tap()
        field.typeText("Two screenshots")
        send("attach-text")

        app.buttons["Add photos, files and more"].tap()
        let thumb = app.buttons["Screenshot 3"]
        XCTAssertTrue(thumb.waitForExistence(timeout: 12))
        thumb.tap()
        let add1 = app.buttons["Add 1"]
        XCTAssertTrue(add1.waitForExistence(timeout: 8))
        add1.tap()
        Thread.sleep(forTimeInterval: 0.8)
        send("attach-only")
    }

}
