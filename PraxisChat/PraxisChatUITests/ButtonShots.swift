import XCTest

/// Button-consistency probe (not part of the regular suite): walks
/// Settings → Skills → Connectors → Add → registries and holds each
/// screen while the host takes `simctl io screenshot`s. Skipped unless
/// `PRAXIS_BUTTONSHOTS` is set. Each pose prints `BUTTONSHOTS <label>`.
final class ButtonShots: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["PRAXIS_BUTTONSHOTS"] != nil, "Optional button capture requires PRAXIS_BUTTONSHOTS; functional buttons run elsewhere")
        continueAfterFailure = true
    }

    private func mark(_ label: String) {
        print("BUTTONSHOTS \(label) \(Date().timeIntervalSince1970)", terminator: "\n")
    }

    private func hold(_ label: String) {
        mark(label)
        Thread.sleep(forTimeInterval: 4.0)
    }

    private func button(containing text: String) -> XCUIElement {
        app.buttons.containing(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func back(from title: String, waitFor element: XCUIElement, timeout: TimeInterval = 8) {
        let bar = app.navigationBars[title]
        XCTAssertTrue(bar.waitForExistence(timeout: 5))
        bar.buttons.firstMatch.tap()
        XCTAssertTrue(element.waitForExistence(timeout: timeout))
        Thread.sleep(forTimeInterval: 0.6)
    }

    func testButtonWalk() {
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))

        app.buttons["History"].tap()
        XCTAssertTrue(app.buttons["History options"].waitForExistence(timeout: 5))
        hold("history")
        app.buttons["History options"].tap()
        app.buttons["Select chats"].tap()
        Thread.sleep(forTimeInterval: 1.0)
        // Select the first conversation row to enable Delete.
        let firstRow = app.cells.firstMatch
        if firstRow.waitForExistence(timeout: 5) { firstRow.tap() }
        Thread.sleep(forTimeInterval: 0.8)
        hold("history-selecting")
        app.buttons["Done selecting"].tap()
        Thread.sleep(forTimeInterval: 0.8)
        app.buttons["History options"].tap()
        app.buttons["Settings"].tap()
        XCTAssertTrue(app.staticTexts["Tools"].waitForExistence(timeout: 5))
        hold("settings-root")

        let skills = button(containing: "Skills")
        XCTAssertTrue(skills.waitForExistence(timeout: 5))
        skills.tap()
        XCTAssertTrue(app.buttons["Import skill"].waitForExistence(timeout: 5))
        hold("skills")

        app.buttons["browseSkills"].tap()
        Thread.sleep(forTimeInterval: 1.5)
        hold("skill-browser")
        back(from: "Browse skills", waitFor: app.buttons["Import skill"])

        back(from: "Skills", waitFor: app.staticTexts["Tools"]) // Skills -> Settings
        let connectors = button(containing: "Connectors")
        XCTAssertTrue(connectors.waitForExistence(timeout: 5))
        connectors.tap()
        Thread.sleep(forTimeInterval: 1.5)
        hold("connectors")

        let addURL = button(containing: "Add by URL")
        XCTAssertTrue(addURL.waitForExistence(timeout: 5))
        addURL.tap()
        Thread.sleep(forTimeInterval: 1.5)
        hold("add-connector")
        back(from: "Add by URL", waitFor: button(containing: "Add by URL"))

        let registry = button(containing: "Browse the MCP registry")
        XCTAssertTrue(registry.waitForExistence(timeout: 5))
        registry.tap()
        Thread.sleep(forTimeInterval: 1.5)
        hold("connector-registry")
    }
}
