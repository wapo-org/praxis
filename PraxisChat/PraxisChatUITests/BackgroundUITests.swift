import XCTest

/// Background pause and Continue (BACKGROUND_PLAN.md §7.1): a scripted
/// long run is backgrounded, pauses through the fallback expiry seam
/// with no lost content, and resumes from the transcript on Continue.
///
/// In the simulator `BGTaskScheduler.submit` always fails
/// (`.unavailable`), so this exercises the `beginBackgroundTask`
/// fallback path; the continued task itself needs a real device.
final class BackgroundUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES",
                                "-PraxisEngine", "scripted",
                                "-PraxisLongRun", "YES",
                                "-PraxisSimulateBackgroundExpiry", "YES"]
        app.launch()
        XCTAssertTrue(el(.button, "History").waitForExistence(timeout: 15))
    }

    private func el(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func elContains(_ type: XCUIElement.ElementType, _ text: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private var composerField: XCUIElement {
        let tv = app.textViews["Message"]
        if tv.exists { return tv }
        return app.textFields["Message"]
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testBackgroundPauseAndContinue() {
        let field = composerField
        XCTAssertTrue(field.waitForExistence(timeout: 10))
        field.tap()
        field.typeText("start the long run")
        el(.button, "Send message").tap()

        // The long run is in flight (first tool streams at once).
        XCTAssertTrue(el(.button, "Stop generating").waitForExistence(timeout: 15)
                      || el(.staticText, "Currently working…").waitForExistence(timeout: 15),
                      "the long run should start")

        // Home: the fallback task opens, and the expiry seam pauses the
        // run seconds later through the real expiry path.
        XCUIDevice.shared.press(.home)
        Thread.sleep(forTimeInterval: 8)
        app.activate()

        // Back: the turn kept its partial work and offers Continue.
        XCTAssertTrue(el(.staticText, "Paused in background").waitForExistence(timeout: 20),
                      "expiry should pause the turn, not lose it")
        XCTAssertTrue(elContains(.staticText, "Stopped after").waitForExistence(timeout: 10),
                      "the partial activity block should survive the pause")
        shot("paused-in-background")

        let cont = el(.button, "Continue")
        XCTAssertTrue(cont.waitForExistence(timeout: 10))
        cont.tap()

        // The Continued run replays the paused transcript: the old note
        // and partial work stay, and a new run starts.
        XCTAssertTrue(el(.button, "Stop generating").waitForExistence(timeout: 15)
                      || el(.staticText, "Currently working…").waitForExistence(timeout: 15),
                      "Continue should start a fresh run")
        XCTAssertTrue(el(.staticText, "Paused in background").exists,
                      "the paused turn keeps its note and partial answer")
        XCTAssertTrue(elContains(.staticText, "Stopped after").exists,
                      "no partial content lost across Continue")
        shot("continued-run")

        // Settle: stop the (minutes-long) scripted run, don't wait it out.
        if el(.button, "Stop generating").exists { el(.button, "Stop generating").tap() }
        XCTAssertTrue(el(.button, "Record voice message").waitForExistence(timeout: 15),
                      "stopping the continued run should settle the composer back to mic")
    }
}
