import XCTest

/// Sending in a long thread keeps the thread at the bottom: the new bubble
/// shows where the conversation ends and older turns never scroll into
/// view (a send used to land several turns up, mid-thread).
final class TranscriptScrollUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        // A seeded long thread: tall answers, then short failed turns.
        app.launchArguments += ["-PraxisResetData", "YES", "-PraxisLongThread", "YES"]
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

    /// On screen between the top of the window and the composer.
    private func isOnScreen(_ element: XCUIElement) -> Bool {
        guard element.exists else { return false }
        let frame = element.frame
        let composerTop = composerField.exists ? composerField.frame.minY : app.frame.height
        return !frame.isEmpty && frame.minY >= 0 && frame.maxY <= composerTop + 1
    }

    func testSendInLongThreadStaysAtBottom() {
        // Launch lands on the newest turn.
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
        // Sample through the send flight and the first streamed rows: the
        // new bubble stays in view and the thread never jumps up to an
        // older turn.
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
        let field = composerField
        field.tap()
        field.typeText("what's happening")
        app.buttons["Send message"].tap()
        XCTAssertTrue(bubble("what's happening").waitForExistence(timeout: 5))

        // Dismiss the keyboard, then scroll well up while the run streams.
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        if app.keyboards.firstMatch.exists {
            top.press(forDuration: 0.3, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.78)),
                      withVelocity: .slow, thenHoldForDuration: 0.2)
        }
        // Scroll up until "Jump to latest" offers, to an overall deadline.
        // A fixed drag count plus one 5s wait flakes under load: a drag
        // can land slowly, and a snapshot query can take 10–20s ("Timed
        // out while evaluating UI query") even while the app streams
        // fine — the main thread samples idle mid-window with no app
        // hotspot while animations sit mid-flight, and identical
        // iterations vary 21–112s with the same binary, so this is host
        // contention (observed load 53 on 12 cores) slowing the sim to a
        // crawl, not a busy app. `exists` reads a timed-out query as
        // "not there yet" (unlike `waitForExistence`, which fails the
        // test on it), and extra drags only scroll further, so this loop
        // rides through both. The budget past the research run's ~10s of
        // streaming is covered by the skip below, which keeps the test
        // honest when the stream outruns the scroll.
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
        // The point is a reader scrolled up DURING the stream: if the run
        // already ended, nothing below can yank, so skip instead of
        // asserting vacuously.
        guard app.buttons["Stop generating"].exists else {
            throw XCTSkip("the stream ended before the scroll completed")
        }
        // The stream keeps growing below; the reader stays where they are.
        Thread.sleep(forTimeInterval: 4)
        // Poll briefly: one snapshot query can time out under load even
        // while Jump to latest sits on screen.
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
