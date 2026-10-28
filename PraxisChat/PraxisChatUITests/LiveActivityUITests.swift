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
/// The two activity tests need the reporter wired to sends
/// (bg-runtime's part, swapped at integration): until then they skip
/// when no activity appears — bg DELETES the `guardActivityWired`
/// skips at integration so a regression fails instead of skipping.
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

    // MARK: Activity lifecycle (skip-guarded until integration wires the reporter)

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

    /// DELETE AT INTEGRATION (see class doc): throws XCTSkip unless
    /// an activity is already visible for this run.
    private func guardActivityWired(title: String) throws {
        if !activityVisible(title: title, timeout: 8) {
            throw XCTSkip("no Live Activity appeared: reporter not wired pre-integration")
        }
    }

    func testActivityStartsOnSend() throws {
        // The title seeds from the first message, so the probe is in
        // the activity's label; the run lasts seconds, so look fast.
        let probe = "activity-probe-\(UUID().uuidString.prefix(8))"
        newChat()
        send(probe)
        try guardActivityWired(title: probe)
        XCTAssertTrue(activityVisible(title: probe, timeout: 10),
                      "the run's activity should stay visible while it runs")
    }

    func testNeedsApprovalShowsInActivity() throws {
        // Needs a scripted approval run; until bg-runtime's long-run
        // seed exists this can only assert the start path. DELETE AT
        // INTEGRATION along with the skip (see class doc).
        let probe = "approval-probe-\(UUID().uuidString.prefix(8))"
        newChat()
        send(probe)
        try guardActivityWired(title: probe)
        let island = springboard.descendants(matching: .any)
            .matching(NSPredicate(format: "label CONTAINS %@", probe)).firstMatch
        XCTAssertTrue(island.waitForExistence(timeout: 10))
    }
}
