import XCTest

/// Tray attachments and drafts belong to their chat (items 2+9): nothing
/// selected carries over to the next chat, and returning restores both.
/// The solid composer buttons (item 10) keep their labels here; their
/// look is verified by screenshots in both modes (see the wave report).
final class PlusTrayUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES", "-PraxisMockGallery", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
    }

    private func el(_ type: XCUIElement.ElementType, _ label: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label == %@", label)).firstMatch
    }

    private func elBegins(_ type: XCUIElement.ElementType, _ text: String) -> XCUIElement {
        app.descendants(matching: type)
            .matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
    }

    /// The tray's "Add N" attach button only (not the empty state's
    /// "Add haptics to buttons" suggestion, which also begins with "Add ").
    private func addCountButton() -> XCUIElement {
        app.descendants(matching: .button)
            .matching(NSPredicate(format: "label MATCHES %@", "Add [0-9]+")).firstMatch
    }

    private var field: XCUIElement {
        let tv = app.textViews["Message"]
        return tv.exists ? tv : app.textFields["Message"]
    }

    private var fieldText: String {
        let value = (field.value as? String) ?? ""
        return value == "Plan, ask, build..." ? "" : value
    }

    private func shot(_ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func tapWhenHittable(_ element: XCUIElement, timeout: TimeInterval = 10) {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if element.exists && element.isHittable {
                element.tap()
                return
            }
            Thread.sleep(forTimeInterval: 0.3)
        }
        XCTFail("element never became hittable: \(element)")
    }

    private func openTray() {
        el(.button, "Add photos, files and more").tap()
        XCTAssertTrue(el(.button, "Plan").waitForExistence(timeout: 15), "tray should open")
    }

    private func closeTray() {
        el(.button, "Close add menu").tap()
        XCTAssertTrue(el(.button, "Add photos, files and more").waitForExistence(timeout: 10))
    }

    /// The reported bug: photos picked in one chat stayed selected and
    /// attached in the next.
    func testPhotoSelectionDoesNotCarryToNewChat() {
        app.buttons["New chat"].tap()
        openTray()
        let thumb = el(.button, "Screenshot 1")
        XCTAssertTrue(thumb.waitForExistence(timeout: 12), "mock gallery should load")
        tapWhenHittable(thumb)
        XCTAssertTrue(el(.button, "Add 1").waitForExistence(timeout: 8))
        shot("tray-gallery-checked")
        el(.button, "Add 1").tap()
        XCTAssertTrue(elBegins(.button, "Remove").waitForExistence(timeout: 8),
                      "attachment lands in the composer")

        app.buttons["New chat"].tap()
        XCTAssertTrue(el(.staticText, "How can I help?").waitForExistence(timeout: 10))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Remove")).count, 0,
                       "the new chat's composer must carry nothing over")
        XCTAssertEqual(fieldText, "")

        openTray()
        XCTAssertFalse(addCountButton().exists, "nothing stays checked in the new chat")
        shot("tray-gallery-fresh")
        closeTray()
        shot("composer-solid-buttons")
    }

    /// The Screenshot tile quick-adds the newest screenshot and leaves
    /// the tray open (a shortcut, not a flow).
    func testScreenshotTileQuickAdds() {
        app.buttons["New chat"].tap()
        openTray()
        el(.button, "Screenshot").tap()
        XCTAssertTrue(elBegins(.button, "Remove").waitForExistence(timeout: 10),
                      "tapping Screenshot attaches it to the composer")
        XCTAssertTrue(el(.button, "Plan").exists, "the tray stays open after a quick-add")
        shot("tray-screenshot-quickadd")
        closeTray()
    }

    /// Switching away stashes the draft; coming back restores its text
    /// and its attachments.
    func testDraftRestoredWhenReturningToChat() {
        app.buttons["New chat"].tap()
        // Title the chat first, so History can find it again.
        field.tap()
        field.typeText("tray draft check")
        el(.button, "Send message").tap()
        let stop = el(.button, "Stop generating")
        if stop.waitForExistence(timeout: 12) { stop.tap() }

        field.tap()
        field.typeText("unsent part two")
        openTray()
        let thumb = el(.button, "Screenshot 1")
        XCTAssertTrue(thumb.waitForExistence(timeout: 12))
        tapWhenHittable(thumb)
        el(.button, "Add 1").tap()
        XCTAssertTrue(elBegins(.button, "Remove").waitForExistence(timeout: 8))

        app.buttons["New chat"].tap()
        XCTAssertTrue(el(.staticText, "How can I help?").waitForExistence(timeout: 10))

        el(.button, "History").tap()
        let row = el(.button, "tray draft check")
        XCTAssertTrue(row.waitForExistence(timeout: 10), "the titled chat is in History")
        row.tap()

        XCTAssertTrue(elBegins(.button, "Remove").waitForExistence(timeout: 8),
                      "returning restores the attachment")
        XCTAssertEqual(fieldText, "unsent part two", "returning restores the text")
        shot("composer-draft-restored")
    }
}
