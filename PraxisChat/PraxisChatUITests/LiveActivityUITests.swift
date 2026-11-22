import XCTest

/// iOS hides an app's island activity in the foreground, so tests press Home and poll SpringBoard.
final class LiveActivityUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
    }

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

    private var springboard: XCUIApplication {
        XCUIApplication(bundleIdentifier: "com.apple.springboard")
    }

    /// Compact island trailing text exposes the run summary label; lock screen exposes chat title.
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
        launch(extraArgs: ["-PraxisEngine", "scripted", "-PraxisLongRun", "YES"])
        let probe = "activity-probe-\(UUID().uuidString.prefix(8))"
        newChat()
        send(probe)
        XCTAssertTrue(el(.button, "Stop generating").waitForExistence(timeout: 15),
                      "the long run should start")
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(activityVisible(title: probe, timeout: 15),
                      "the run's activity should appear in the island once backgrounded")
        app.activate()
        if el(.button, "Stop generating").waitForExistence(timeout: 10) {
            el(.button, "Stop generating").tap()
        }
    }

    func testNeedsApprovalShowsInActivity() throws {
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
