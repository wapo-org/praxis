import XCTest

/// Composer must clear on send even with active autocorrect, predictive bar, or IME composition.
final class ComposerClearUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
        app.buttons["New chat"].tap()
    }

    private var field: XCUIElement {
        let tv = app.textViews["Message"]
        return tv.exists ? tv : app.textFields["Message"]
    }

    private var fieldText: String {
        let value = (field.value as? String) ?? ""
        return value == "Plan, ask, build..." ? "" : value
    }

    private func stopRunIfNeeded() {
        let stop = app.buttons["Stop generating"]
        if stop.waitForExistence(timeout: 2) { stop.tap() }
        _ = app.buttons["Record voice message"].waitForExistence(timeout: 4)
    }

    func testSendClearsFieldWithPendingAutocorrect() {
        let drafts = ["teh", "adn wirte a long essay", "write a long essay", "recieve", "dont", "Im", "hte quick brown fox"]
        var failures: [String] = []
        for (i, draft) in drafts.enumerated() {
            field.tap()
            field.typeText(draft)
            app.buttons["Send message"].tap()
            var leftover = ""
            for _ in 0..<8 {
                Thread.sleep(forTimeInterval: 0.12)
                leftover = fieldText
                if !leftover.isEmpty { break }
            }
            if !leftover.isEmpty {
                failures.append("#\(i) \"\(draft)\" left \"\(leftover)\" in the field")
                let shot = XCTAttachment(screenshot: app.screenshot())
                shot.name = "leftover-\(i)"; shot.lifetime = .keepAlways; add(shot)
                field.tap()
                field.press(forDuration: 1.0)
                if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
                app.keys["delete"].tap()
            }
            stopRunIfNeeded()
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "; "))
    }

    /// Replays a post-send keyboard commit before SwiftUI clears the text view to guard the race.
    func testSendClearsFieldWhenKeyboardCommitsAfterSend() {
        app.terminate()
        app = XCUIApplication()
        app.launchArguments += ["-PraxisEngine", "demo", "-PraxisResetData", "YES", "-PraxisSimulateKeyboardCommit", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
        app.buttons["New chat"].tap()
        for (i, draft) in ["write a long essay", "teh quick brown fox"].enumerated() {
            field.tap()
            field.typeText(draft)
            app.buttons["Send message"].tap()
            Thread.sleep(forTimeInterval: 0.8)
            if !fieldText.isEmpty {
                let shot = XCTAttachment(screenshot: app.screenshot())
                shot.name = "leftover-commit-\(i)"; shot.lifetime = .keepAlways; add(shot)
            }
            XCTAssertEqual(fieldText, "", "the composer must be empty after send #\(i)")
            stopRunIfNeeded()
        }
    }
}
