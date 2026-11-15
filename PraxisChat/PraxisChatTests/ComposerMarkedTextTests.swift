import XCTest
import SwiftUI
import UIKit
@testable import PraxisChat

/// Guards clearFocusedTextView() against UIKit keyboard edits copying stale text back pre-update.
@MainActor
final class ComposerMarkedTextTests: XCTestCase {
    @Observable final class Model { var text = "" }

    struct Field: View {
        @Bindable var model: Model
        @FocusState private var focused: Bool
        var body: some View {
            TextField("Message", text: $model.text, axis: .vertical)
                .lineLimit(1...6)
                .focused($focused)
                .onAppear { focused = true }
        }
    }

    private var window: UIWindow?
    private let sent = "write a long essay"

    override func tearDown() async throws {
        window?.isHidden = true
        window = nil
    }

    private func spin(_ seconds: TimeInterval = 0.3) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    private func makeField(typed: String, marked: String? = nil) throws -> (Model, UITextView) {
        let model = Model()
        let host = UIHostingController(rootView: Field(model: model))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 300)
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        spin(1)
        let textView = try XCTUnwrap(ComposerInput.firstResponder() as? UITextView, "the field's text view is focused")
        textView.insertText(typed)
        if let marked {
            textView.setMarkedText(marked, selectedRange: NSRange(location: marked.count, length: 0))
        }
        spin()
        XCTAssertEqual(model.text, sent)
        return (model, textView)
    }

    private func send(_ model: Model) {
        model.text = ""
        ComposerInput.clearFocusedTextView()
    }

    private func assertCleared(_ model: Model, _ textView: UITextView, file: StaticString = #filePath, line: UInt = #line) {
        spin(0.4)
        XCTAssertFalse(model.text.contains("write"), "draft got the sent text back: \(model.text)", file: file, line: line)
        XCTAssertFalse(textView.text.contains("write"), "field shows the sent text: \(textView.text ?? "")", file: file, line: line)
    }

    func testKeyboardEditAfterSendDoesNotRestoreText() throws {
        let (model, textView) = try makeField(typed: sent)
        send(model)
        textView.delegate?.textViewDidChange?(textView)
        assertCleared(model, textView)
    }

    func testCommittedMarkedTextAfterSendDoesNotRestoreText() throws {
        let (model, textView) = try makeField(typed: "write a long ", marked: "essay")
        send(model)
        XCTAssertNil(textView.markedTextRange, "the composition ends with the send")
        textView.unmarkText()
        assertCleared(model, textView)
    }

    func testLateKeystrokeAfterSendKeepsOnlyTheKeystroke() throws {
        let (model, textView) = try makeField(typed: sent)
        send(model)
        textView.insertText("a")
        assertCleared(model, textView)
        XCTAssertEqual(model.text, "a")
    }
}
