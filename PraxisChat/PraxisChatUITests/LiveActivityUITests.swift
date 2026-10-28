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
/// The two activity tests assert on the live reporter (wired at
/// integration): a regression fails instead of skipping.
final class LiveActivityUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES"]
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

    private var composerField: XCUIElement {
        let tv = app.textViews["Message"]
        if tv.exists { return tv }
        return app.textFields["Message"]
    }

    private func newChat() {
        el(.button, "New chat").tap()
        XCTAssertTrue(el(.staticText, "How can I help?").waitForExistence(timeout: 10))
    }

    private func send(_ text: String) {
        let field = composerField
        field.tap()
        field.typeText(text)
        XCTAssertTrue(el(.button, "Send message").waitForExistence(timeout: 5))
        el(.button, "Send message").tap()
        XCTAssertTrue(elContains(.any, text).waitForExistence(timeout: 10),
                      "sent text should lift into a user bubble")
    }

    // MARK: Activity lifecycle

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
        // The title seeds from the first message, so the probe is in
        // the activity's label; the run lasts seconds, so look fast.
        let probe = "activity-probe-\(UUID().uuidString.prefix(8))"
        newChat()
        send(probe)
        XCTAssertTrue(activityVisible(title: probe, timeout: 10),
                      "the run's activity should appear and stay visible while it runs")
    }

    func testNeedsApprovalShowsInActivity() throws {
        // The demo "ship" scenario asks to merge PR #42 and holds the
        // run until decided: the activity must stay visible throughout
        // the wait, showing the needs-approval phase.
        let probe = "approval-probe-\(UUID().uuidString.prefix(8))"
        newChat()
        send("ship \(probe)")
        XCTAssertTrue(elContains(.any, "Approval needed").waitForExistence(timeout: 60),
                      "the ship scenario should ask for approval")
        XCTAssertTrue(activityVisible(title: probe, timeout: 10),
                      "the activity should stay visible while awaiting approval")
        el(.button, "Deny").tap()
    }
}
