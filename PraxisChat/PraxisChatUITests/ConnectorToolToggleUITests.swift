import XCTest

/// Per-tool switches in the connector detail screen, against the
/// `-PraxisMockConnector YES` seed (a hermetic connector with scripted
/// tools). Nothing here reaches the network.
final class ConnectorToolToggleUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES", "-PraxisMockConnector", "YES"]
    }

    private func launch(_ extra: [String] = []) {
        app.launchArguments += extra
        app.launch()
        XCTAssertTrue(el(.button, "History").waitForExistence(timeout: 15))
    }

    private func el(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        app.descendants(matching: type).matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func elContains(_ type: XCUIElement.ElementType, _ text: String) -> XCUIElement {
        app.descendants(matching: type).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func toolSwitch(_ name: String) -> XCUIElement {
        app.switches.matching(identifier: "toolToggle.\(name)").firstMatch
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// History → ⋯ → Settings → Connectors → Mock Server.
    private func openMockConnector() {
        el(.button, "History").tap()
        let options = el(.button, "History options")
        XCTAssertTrue(options.waitForExistence(timeout: 10))
        options.tap()
        let settings = el(.button, "Settings")
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 10))
        el(.button, "Connectors").tap()
        XCTAssertTrue(app.navigationBars["Connectors"].waitForExistence(timeout: 10))
        let row = elContains(.button, "Mock Server")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.navigationBars["Mock Server"].waitForExistence(timeout: 10))
    }

    /// The tools section sits below the fold: swipe until the element
    /// can be tapped (the VStack renders eagerly, so existence alone
    /// says nothing about visibility).
    private func scrollTo(_ element: XCUIElement) {
        for _ in 0..<8 {
            if element.waitForExistence(timeout: 1), element.isHittable { return }
            app.swipeUp()
        }
        XCTAssertTrue(element.isHittable)
    }

    func testToolTogglePersists() {
        launch()
        openMockConnector()

        // The header scrolls into view first, then the rows below it.
        let disableAll = el(.button, "Disable all tools")
        let enableAll = el(.button, "Enable all tools")
        scrollTo(disableAll)
        let search = toolSwitch("search_docs")
        scrollTo(search)
        XCTAssertEqual(search.value as? String, "1")
        XCTAssertTrue(el(.staticText, "3 tools").exists, "all on: plain count")
        XCTAssertTrue(elContains(.staticText, "Says read-only").exists)
        XCTAssertTrue(elContains(.staticText, "Can change things").exists)
        shot("mcptools-01-all-on")

        // One toggle off: the count follows.
        search.tap()
        XCTAssertEqual(search.value as? String, "0")
        XCTAssertTrue(el(.staticText, "2 of 3 on").waitForExistence(timeout: 5))
        shot("mcptools-02-one-off")

        // Disable all, then enable all.
        disableAll.tap()
        XCTAssertEqual(toolSwitch("list_projects").value as? String, "0")
        XCTAssertTrue(el(.staticText, "0 of 3 on").waitForExistence(timeout: 5))
        enableAll.tap()
        XCTAssertEqual(search.value as? String, "1")
        XCTAssertTrue(el(.staticText, "3 tools").waitForExistence(timeout: 5))

        // Off survives leaving and reopening the detail screen.
        let ticket = toolSwitch("create_ticket")
        scrollTo(ticket)
        ticket.tap()
        XCTAssertEqual(ticket.value as? String, "0")
        app.navigationBars.buttons["Connectors"].tap()
        XCTAssertTrue(app.navigationBars["Connectors"].waitForExistence(timeout: 10))
        elContains(.button, "Mock Server").tap()
        XCTAssertTrue(app.navigationBars["Mock Server"].waitForExistence(timeout: 10))
        scrollTo(toolSwitch("create_ticket"))
        XCTAssertEqual(toolSwitch("create_ticket").value as? String, "0")
        XCTAssertTrue(el(.staticText, "2 of 3 on").exists)
    }

    func testNewToolBadge() {
        launch(["-PraxisMockConnectorNewTool", "YES"])
        openMockConnector()

        let added = toolSwitch("summarize_thread")
        scrollTo(added)
        XCTAssertEqual(added.value as? String, "1", "new tools start on")
        XCTAssertTrue(el(.staticText, "New tool").exists)
        shot("mcptools-03-new-badge")

        // Looked at once: leaving clears the badge.
        app.navigationBars.buttons["Connectors"].tap()
        XCTAssertTrue(app.navigationBars["Connectors"].waitForExistence(timeout: 10))
        elContains(.button, "Mock Server").tap()
        XCTAssertTrue(app.navigationBars["Mock Server"].waitForExistence(timeout: 10))
        scrollTo(toolSwitch("summarize_thread"))
        XCTAssertFalse(el(.staticText, "New tool").exists)
    }
}
