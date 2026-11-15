import XCTest
@testable import PraxisChat

/// Only praxis-app://chat/<uuid> selects a chat; other links pass through for in-app tiles.
final class ChatDeepLinkTests: XCTestCase {
    private let id = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!

    func testChatURLParses() {
        let url = URL(string: "praxis-app://chat/11111111-2222-3333-4444-555555555555")!
        XCTAssertEqual(ChatScreen.chatDeepLinkConversationID(from: url), id)
    }

    func testChatURLParsesUppercaseUUID() {
        let url = URL(string: "praxis-app://chat/11111111-2222-3333-4444-555555555555".uppercased())!
        XCTAssertEqual(ChatScreen.chatDeepLinkConversationID(from: url), id)
    }

    func testChatHostIsCaseInsensitive() {
        let url = URL(string: "PRAXIS-APP://CHAT/11111111-2222-3333-4444-555555555555")!
        XCTAssertEqual(ChatScreen.chatDeepLinkConversationID(from: url), id)
    }

    func testIntegrationTileHostIgnored() {
        XCTAssertNil(ChatScreen.chatDeepLinkConversationID(from: URL(string: "praxis-app://GitHub")!))
    }

    func testOtherSchemesIgnored() {
        XCTAssertNil(ChatScreen.chatDeepLinkConversationID(from: URL(string: "https://example.com/chat/x")!))
        XCTAssertNil(ChatScreen.chatDeepLinkConversationID(from: URL(string: "praxis-file://note.txt")!))
    }

    func testBadUUIDIgnored() {
        XCTAssertNil(ChatScreen.chatDeepLinkConversationID(from: URL(string: "praxis-app://chat/not-a-uuid")!))
    }

    func testMissingPathIgnored() {
        XCTAssertNil(ChatScreen.chatDeepLinkConversationID(from: URL(string: "praxis-app://chat")!))
        XCTAssertNil(ChatScreen.chatDeepLinkConversationID(from: URL(string: "praxis-app://chat/")!))
    }
}
