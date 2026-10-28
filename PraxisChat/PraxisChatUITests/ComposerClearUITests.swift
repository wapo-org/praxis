import XCTest

/// The composer must be empty after a send, whatever the keyboard is doing
/// with the word being typed (autocorrect candidate, predictive bar,
/// multilingual or IME composition). A real device kept the sent text in
/// the field while the run was already going.
final class ComposerClearUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = true
        app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES"]
        app.launch()
        XCTAssertTrue(app.buttons["History"].waitForExistence(timeout: 15))
        app.buttons["New chat"].tap()
    }

    private var field: XCUIElement {
        let tv = app.textViews["Message"]
        return tv.exists ? tv : app.textFields["Message"]
    }

    /// The field's text; the placeholder stands in for an empty field.
    private var fieldText: String {
        let value = (field.value as? String) ?? ""
        return value == "Plan, ask, build..." ? "" : value
    }

    private func stopRunIfNeeded() {
        let stop = app.buttons["Stop generating"]
        if stop.waitForExistence(timeout: 2) { stop.tap() }
        _ = app.buttons["Record voice message"].waitForExistence(timeout: 4)
    }

    /// Types, then sends at once (no pause for the keyboard to settle),
    /// and checks the field after the keyboard has had time to react.
    func testSendClearsFieldWithPendingAutocorrect() {
        let drafts = ["teh", "adn wirte a long essay", "write a long essay", "recieve", "dont", "Im", "hte quick brown fox"]
        var failures: [String] = []
        for (i, draft) in drafts.enumerated() {
            field.tap()
            field.typeText(draft)
            app.buttons["Send message"].tap()
            // Poll: a re-committed text may land a beat later.
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
                // Clear it so the next iteration starts clean.
                field.tap()
                field.press(forDuration: 1.0)
                if app.menuItems["Select All"].waitForExistence(timeout: 2) { app.menuItems["Select All"].tap() }
                app.keys["delete"].tap()
            }
            stopRunIfNeeded()
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "; "))
    }

    /// The device bug, made deterministic: the keyboard commits an edit
    /// (a candidate, marked text, an autocorrection) right after send is
    /// tapped, before SwiftUI pushes the cleared draft into the text view.
    /// That edit used to copy the whole sent message back into the field.
    /// The app replays such an edit after every send under
    /// `-PraxisSimulateKeyboardCommit`.
    func testSendClearsFieldWhenKeyboardCommitsAfterSend() {
        app.terminate()
        app = XCUIApplication()
        app.launchArguments += ["-PraxisResetData", "YES", "-PraxisSimulateKeyboardCommit", "YES"]
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
