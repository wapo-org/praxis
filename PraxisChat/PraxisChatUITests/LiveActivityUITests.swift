import XCTest

/// Live Activity lifecycle visibility.
///
/// The deep link itself (`praxis-app://chat/<id>` → select, ignore
/// the rest) is unit-tested in ChatDeepLinkTests and was verified
/// end to end with temporary scaffolding (simctl openurl + alert tap
/// for unknown ids, widget tap for a valid id — see the bg-live
/// report): no committed UI test can open a URL standalone on-sim.
/// `UIApplication.open` from the runner is a silent no-op, Safari
/// searches custom schemes instead of opening them, and simctl needs
/// a Mac-side driver.
///
/// Detection: iOS suppresses an app's own activity in the island
/// while that app is foreground, so both tests press Home and poll
/// SpringBoard. The first test uses the scripted long-run seed so
/// the run outlasts the assertion window; the second uses the demo
/// "ship" scenario, which holds the run at an approval.
final class LiveActivityUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

    /// Launch with ResetData plus per-test engine args; wait for idle.
    private func launch(extraArgs: [String] = []) {
        app.launchArguments += ["-PraxisResetData", "YES"] + (extraArgs.contains("-PraxisEngine") ? [] : ["-PraxisEngine", "demo"]) + extraArgs
        app.launch()
        XCTAssertTrue(el(.button, "History").waitForExistence(timeout: 15))
    }

    // MARK: Query + flow helpers (same conventions as PraxisChatUITests)

    private func el(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func elContains(_ type: XCUIElement.ElementType, _ text: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func newChat() {
        el(.button, "New chat").tap()
        XCTAssertTrue(el(.staticText, "How can I help?").waitForExistence(timeout: 10))
    }

    private func send(_ text: String) {
        let tv = app.textViews["Message"]
        let field: XCUIElement = tv.exists ? tv : app.textFields["Message"]
        field.tap()
        field.typeText(text)
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 5))
        el(.button, "Send message").tap()
        XCTAssertTrue(elContains(.any, text).waitForExistence(timeout: 10),
                      "sent text should lift into a user bubble")
    }

    // MARK: Activity lifecycle (asserted backgrounded: the foreground
    // app's own island pill is suppressed by the system)

    private var springboard: XCUIApplication {
        XCUIApplication(bundleIdentifier: "com.apple.springboard")
    }

    /// The compact island's trailing text carries the run summary as
    /// its accessibility label; the lock screen shows the chat title.
    /// Either proves an activity is (or was recently) live.
    private func activityVisible(title: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let island = springboard.descendants(matching: .any)
                .matching(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
            if island.exists { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return false
    }

    func testActivityStartsOnSend() throws {
        // Long-run seed: minutes of tool steps, so the run is still
        // going when the backgrounded assertion runs.
        launch(extraArgs: ["-PraxisEngine", "scripted", "-PraxisLongRun", "YES"])
        // The title seeds from the first message, so the probe is in
        // the activity's label.
        let probe = "activity-probe-\(UUID().uuidString.prefix(8))"
        newChat()
        send(probe)
        XCTAssertTrue(el(.button, "Stop generating").waitForExistence(timeout: 15),
                      "the long run should start")
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(activityVisible(title: probe, timeout: 15),
                      "the run's activity should appear in the island once backgrounded")
        // Settle: stop the minutes-long run, don't wait it out.
        app.activate()
        if el(.button, "Stop generating").waitForExistence(timeout: 10) {
            el(.button, "Stop generating").tap()
        }
    }

    func testNeedsApprovalShowsInActivity() throws {
        // The demo "ship" scenario asks to merge PR #42 and holds the
        // run until decided: the activity must stay visible throughout
        // the wait, showing the needs-approval phase.
        launch()
        let probe = "approval-probe-\(UUID().uuidString.prefix(8))"
        newChat()
        send("ship \(probe)")
        XCTAssertTrue(elContains(.any, "Approval needed").waitForExistence(timeout: 60),
                      "the ship scenario should ask for approval")
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(activityVisible(title: probe, timeout: 15),
                      "the activity should stay visible while awaiting approval")
        app.activate()
        el(.button, "Deny").tap()
    }
}
