import XCTest

final class ConnectorToolToggleUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES", "-PraxisMockConnector", "YES"]
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

    /// Tools VStack renders eagerly offscreen, so existence alone does not imply tappable visibility.
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

        search.tap()
        XCTAssertEqual(search.value as? String, "0")
        XCTAssertTrue(el(.staticText, "2 of 3 on").waitForExistence(timeout: 5))
        shot("mcptools-02-one-off")

        disableAll.tap()
        XCTAssertEqual(toolSwitch("list_projects").value as? String, "0")
        XCTAssertTrue(el(.staticText, "0 of 3 on").waitForExistence(timeout: 5))
        enableAll.tap()
        XCTAssertEqual(search.value as? String, "1")
        XCTAssertTrue(el(.staticText, "3 tools").waitForExistence(timeout: 5))

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

        app.navigationBars.buttons["Connectors"].tap()
        XCTAssertTrue(app.navigationBars["Connectors"].waitForExistence(timeout: 10))
        elContains(.button, "Mock Server").tap()
        XCTAssertTrue(app.navigationBars["Mock Server"].waitForExistence(timeout: 10))
        scrollTo(toolSwitch("summarize_thread"))
        XCTAssertFalse(el(.staticText, "New tool").exists)
    }
}
