import XCTest
@testable import PraxisChat

/// Attachments (and draft text) belong to the chat they were added in:
/// switching chats stashes the composer's draft and restores the other
/// chat's, instead of carrying the selection over.
@MainActor
final class DraftPerChatTests: XCTestCase {
    private func makeStore() -> ChatStore {
        ChatStore(engine: DemoAgentEngine(timeScale: 0),
                  conversations: [Conversation(title: "Chat A"), Conversation(title: "Chat B")])
    }

    private func photo(_ name: String = "Photo") -> Attachment {
        Attachment(kind: .photo, name: name)
    }

    func testAttachmentsStayInTheirChat() {
        let store = makeStore()
        let a = store.conversations[0].id, b = store.conversations[1].id
        XCTAssertEqual(store.selectedID, a)

        store.attachments = [photo()]
        store.select(b)
        XCTAssertTrue(store.attachments.isEmpty, "chat B must not inherit chat A's picks")
        store.select(a)
        XCTAssertEqual(store.attachments.count, 1, "returning to A restores its picks")
    }

    func testDraftTextIsPerChat() {
        let store = makeStore()
        let a = store.conversations[0].id, b = store.conversations[1].id

        store.draft = "hello A"
        store.select(b)
        XCTAssertEqual(store.draft, "")
        store.draft = "hello B"
        store.select(a)
        XCTAssertEqual(store.draft, "hello A")
        store.select(b)
        XCTAssertEqual(store.draft, "hello B")
    }

    func testNewChatStartsEmptyAndPreservesOldDraft() {
        let store = makeStore()
        let a = store.conversations[0].id

        store.draft = "unsent"
        store.attachments = [photo()]
        store.newChat()
        XCTAssertEqual(store.draft, "")
        XCTAssertTrue(store.attachments.isEmpty)
        store.select(a)
        XCTAssertEqual(store.draft, "unsent")
        XCTAssertEqual(store.attachments.count, 1)
    }

    func testSelectingCurrentChatKeepsDraft() {
        let store = makeStore()
        store.draft = "typing…"
        store.select(store.selectedID!)
        XCTAssertEqual(store.draft, "typing…")
    }

    func testSendClearsStashedDraft() async {
        let store = makeStore()
        let a = store.conversations[0].id, b = store.conversations[1].id

        store.draft = "sent from A"
        store.select(b)
        store.select(a)
        store.send(text: store.draft)
        await store.settle()
        store.select(b)
        store.select(a)
        XCTAssertEqual(store.draft, "", "a sent draft must not come back")
        XCTAssertTrue(store.attachments.isEmpty)
    }

    func testDepositLandsLiveWhenStillSelected() {
        let store = makeStore()
        let a = store.conversations[0].id
        XCTAssertTrue(store.deposit([photo()], for: a))
        XCTAssertEqual(store.attachments.count, 1)
    }

    func testDepositStashesWhenChatSwitchedMidAttach() {
        let store = makeStore()
        let a = store.conversations[0].id, b = store.conversations[1].id
        // A slow attach captured A, then the user switched to B.
        store.select(b)
        XCTAssertFalse(store.deposit([photo()], for: a))
        XCTAssertTrue(store.attachments.isEmpty, "B's composer must stay clean")
        store.select(a)
        XCTAssertEqual(store.attachments.count, 1, "returning to A surfaces the late attach")
    }

    func testDepositToDeletedChatDrops() {
        let store = makeStore()
        let a = store.conversations[0].id
        store.deleteConversations([a])
        XCTAssertFalse(store.deposit([photo()], for: a))
        XCTAssertTrue(store.attachments.isEmpty)
    }

    func testDeleteConversationDropsItsDraft() {
        let store = makeStore()
        let a = store.conversations[0].id, b = store.conversations[1].id

        store.draft = "doomed"
        store.select(b)
        store.deleteConversations([a])
        XCTAssertEqual(store.selectedID, b)
        XCTAssertEqual(store.draft, "")
        XCTAssertEqual(store.conversations.count, 1)
    }
}
