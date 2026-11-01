import XCTest
@testable import PraxisChat

/// Chats are named by their first message, including ones that only carry
/// attachments (they used to be left with a blank title).
@MainActor
final class ConversationTitleTests: XCTestCase {
    private func makeStore() -> ChatStore {
        let store = ChatStore(engine: DemoAgentEngine(timeScale: 0))
        store.newChat()
        return store
    }

    private func photo(_ n: Int = 1, kind: Attachment.Kind = .photo) -> [Attachment] {
        (1...n).map { Attachment(kind: kind, name: "Photo \($0)", imageData: nil) }
    }

    func testTextTitleIsCollapsedAndCapped() {
        XCTAssertEqual(ConversationTitle.make(text: "  hello\n\n  world  ", attachments: []), "hello world")
        let long = String(repeating: "a", count: 80)
        XCTAssertEqual(ConversationTitle.make(text: long, attachments: [])?.count, 42)
        XCTAssertNil(ConversationTitle.make(text: "  \n ", attachments: []))
    }

    func testAttachmentOnlyTitles() {
        XCTAssertEqual(ConversationTitle.make(text: "", attachments: photo()), "Photo")
        XCTAssertEqual(ConversationTitle.make(text: "", attachments: photo(kind: .camera)), "Photo")
        XCTAssertEqual(ConversationTitle.make(text: "", attachments: photo(kind: .screenshot)), "Screenshot")
        XCTAssertEqual(ConversationTitle.make(text: "", attachments: photo(3)), "3 photos")
        XCTAssertEqual(ConversationTitle.make(text: "", attachments: photo(2, kind: .screenshot)), "2 screenshots")
        XCTAssertEqual(ConversationTitle.make(text: "", attachments: photo() + photo(kind: .screenshot)), "2 images")
        let file = Attachment(kind: .file, name: "report.pdf", fileData: Data([1]))
        XCTAssertEqual(ConversationTitle.make(text: "", attachments: [file]), "report.pdf")
        XCTAssertEqual(ConversationTitle.make(text: "", attachments: [file, file]), "2 files")
        XCTAssertEqual(ConversationTitle.make(text: "", attachments: [file] + photo()), "2 attachments")
        XCTAssertNil(ConversationTitle.make(text: "", attachments: []))
    }

    func testAttachmentOnlySendTitlesTheChat() throws {
        let store = makeStore()
        store.attachments = photo(2)
        store.send(text: "")
        XCTAssertEqual(store.selected?.title, "2 photos")
        store.stop()
    }

    func testTextAfterAttachmentOnlyFirstMessageRenamesTheChat() throws {
        let store = makeStore()
        store.attachments = photo()
        store.send(text: "")
        store.stop()
        XCTAssertEqual(store.selected?.title, "Photo")
        store.send(text: "what is in this picture?")
        XCTAssertEqual(store.selected?.title, "what is in this picture?")
        store.stop()
        // A real title is never replaced by later messages.
        store.send(text: "and this one?")
        XCTAssertEqual(store.selected?.title, "what is in this picture?")
        store.stop()
    }

    func testTextFirstThenAttachmentKeepsTheTextTitle() throws {
        let store = makeStore()
        store.send(text: "hello there")
        store.stop()
        store.attachments = photo()
        store.send(text: "")
        XCTAssertEqual(store.selected?.title, "hello there")
        store.stop()
    }

    func testBlankStoredTitleFallsBackWhenDisplayed() throws {
        let store = makeStore()
        store.attachments = photo()
        store.send(text: "")
        store.stop()
        let conv = try XCTUnwrap(store.selected)
        conv.title = ""
        XCTAssertEqual(conv.displayTitle, "Photo")
        conv.turns.removeAll()
        XCTAssertEqual(conv.displayTitle, "New chat")
    }

    func testEditingTheFirstMessageResetsTheTitle() throws {
        let store = makeStore()
        store.send(text: "first words")
        store.stop()
        let first = try XCTUnwrap(store.selected?.turns.first)
        store.edit(turnID: first.id)
        XCTAssertEqual(store.selected?.title, "New chat")
        XCTAssertEqual(store.draft, "first words")
        store.send(text: "better words")
        XCTAssertEqual(store.selected?.title, "better words")
        store.stop()
    }
}
