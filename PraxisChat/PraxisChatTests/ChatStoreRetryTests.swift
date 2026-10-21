import XCTest
@testable import PraxisChat

/// Retry semantics: retrying a turn rewinds the thread — every turn
/// below the retried one is removed before the fresh run starts.
@MainActor
final class ChatStoreRetryTests: XCTestCase {

    func testRetryRemovesTurnsBelow() throws {
        let store = ChatStore()
        let conv = try XCTUnwrap(store.selected)
        XCTAssertEqual(conv.turns.count, 2, "seeded conversation has two turns")
        let first = conv.turns[0]

        store.retry(turnID: first.id)

        let after = try XCTUnwrap(store.selected)
        XCTAssertEqual(after.turns.count, 1, "retry should drop turns below the retried turn")
        XCTAssertEqual(after.turns.first?.id, first.id)
        XCTAssertEqual(after.turns.first?.userText, first.userText)
        store.stop()
    }

    func testRetryLastTurnKeepsCount() throws {
        let store = ChatStore()
        let conv = try XCTUnwrap(store.selected)
        let last = try XCTUnwrap(conv.turns.last)

        store.retry(turnID: last.id)

        XCTAssertEqual(store.selected?.turns.count, 2)
        store.stop()
    }

    func testSendWithManyAttachmentsAndLongMessage() throws {
        let store = ChatStore()
        store.newChat()
        store.attachments = (1...12).map {
            Attachment(kind: .screenshot, name: "Screenshot \($0)", imageData: nil)
        }
        let longText = String(repeating: "Please audit the glass stack end to end. ", count: 12)

        store.send(text: longText)

        let conv = try XCTUnwrap(store.selected)
        let turn = try XCTUnwrap(conv.turns.last)
        XCTAssertEqual(turn.attachments.count, 12)
        XCTAssertEqual(turn.userText, longText.trimmingCharacters(in: .whitespacesAndNewlines))
        XCTAssertTrue(store.attachments.isEmpty, "composer strip drains into the turn")
        store.stop()
    }
}
