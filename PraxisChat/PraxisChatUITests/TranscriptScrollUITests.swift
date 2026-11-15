import XCTest

/// Sending in a long thread must keep the viewport anchored at the bottom on the new bubble.
final class TranscriptScrollUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES", "-PraxisLongThread", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
    }

    private func bubble(_ text: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "You said: \(text)")).firstMatch
    }

    private var composerField: XCUIElement {
        let tv = app.textViews["Message"]
        if tv.exists { return tv }
        return app.textFields["Message"]
    }

    private func isOnScreen(_ element: XCUIElement) -> Bool {
        guard element.exists else { return false }
        let frame = element.frame
        let composerTop = composerField.exists ? composerField.frame.minY : app.frame.height
        return !frame.isEmpty && frame.minY >= 0 && frame.maxY <= composerTop + 1
    }

    func testSendInLongThreadStaysAtBottom() {
        let lastOld = bubble("what")
        XCTAssertTrue(lastOld.waitForExistence(timeout: 10))
        XCTAssertTrue(isOnScreen(lastOld), "a long thread should open at its bottom")

        let field = composerField
        field.tap()
        field.typeText("what's happening")
        app.buttons["Send message"].tap()

        let sent = bubble("what's happening")
        let older = bubble("try creating new doc saying hello world")
        XCTAssertTrue(sent.waitForExistence(timeout: 5), "the sent text should become a bubble")
        let deadline = Date().addingTimeInterval(1.6)
        var samples = 0
        while Date() < deadline {
            XCTAssertTrue(isOnScreen(sent), "the new bubble should stay in view (sample \(samples))")
            XCTAssertFalse(isOnScreen(older), "the thread must not jump up to an older turn (sample \(samples))")
            samples += 1
            Thread.sleep(forTimeInterval: 0.15)
        }
        XCTAssertFalse(app.buttons["Jump to latest"].exists, "the thread should sit at the bottom")

        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = "30-long-thread-sent"
        shot.lifetime = .keepAlways
        add(shot)
        if app.buttons["Stop generating"].exists { app.buttons["Stop generating"].tap() }
    }

    func testScrolledUpReaderIsNotYanked() throws {
        // Uses a minutes-long scripted stream so streaming cannot finish before scrolling under load.
        app.terminate()
        app.launchArguments = ["-PraxisEngine", "scripted", "-PraxisLongRun", "YES", "-PraxisResetData", "YES", "-PraxisLongThread", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
        let field = composerField
        field.tap()
        field.typeText("what's happening")
        app.buttons["Send message"].tap()
        XCTAssertTrue(bubble("what's happening").waitForExistence(timeout: 5))

        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        if app.keyboards.firstMatch.exists {
            top.press(forDuration: 0.3, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.78)),
                      withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        let jump = app.buttons["Jump to latest"]
        let scrollDeadline = Date().addingTimeInterval(20)
        var drags = 0
        var found = false
        while !found, Date() < scrollDeadline {
            found = jump.exists
            if !found {
                top.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.75)))
                drags += 1
                Thread.sleep(forTimeInterval: 0.3)
            }
        }
        XCTAssertTrue(found, "scrolling up should offer Jump to latest (after \(drags) drags)")
        XCTAssertTrue(app.buttons["Stop generating"].exists, "The scripted run must still be active while scrolled up")
        Thread.sleep(forTimeInterval: 4)
        // Poll briefly because a single snapshot query can time out under load while button is visible.
        var stillThere = false
        let assertDeadline = Date().addingTimeInterval(5)
        while !stillThere, Date() < assertDeadline {
            stillThere = jump.exists
            if !stillThere { Thread.sleep(forTimeInterval: 0.5) }
        }
        XCTAssertTrue(stillThere, "streaming must not pull a reader who scrolled up back down")
        jump.tap()
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: jump)
        wait(for: [gone], timeout: 8)
        if app.buttons["Stop generating"].exists { app.buttons["Stop generating"].tap() }
    }
}
