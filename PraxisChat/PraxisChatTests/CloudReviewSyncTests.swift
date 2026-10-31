import XCTest
import AgentCore
import Synchronization
@testable import PraxisChat

@MainActor
final class CloudReviewSyncTests: XCTestCase {
    func testIntermediatePageCannotResumeStaleRunningStatus() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let turn = Turn(userText: "Unfinished", isFinished: false, engine: .cloud)
        let conversation = Conversation(title: "Remote", turns: [turn], cloudChatID: "chat")
        let store = ChatStore(conversations: [])
        let pages = Mutex(0), streamRequests = Mutex(0)
        let first = """
        {"cursor":"1","nextCursor":"2","entities":[
        {"key":"chat:chat","deleted":false,"value":{"id":"chat","title":"Remote","updatedAt":"2026-10-30T00:00:00Z"}},
        {"key":"run:run","deleted":false,"value":{"id":"run","chatId":"chat","clientTurnId":"\(turn.id)","status":"running","lastEventId":1}}]}
        """
        let last = """
        {"cursor":"2","nextCursor":null,"entities":[{"key":"run:run","deleted":false,"value":{"id":"run","chatId":"chat","clientTurnId":"\(turn.id)","status":"completed","lastEventId":2}}]}
        """
        let client = try cloudNetClient { request in
            if request.url!.path == "/v1/sync/root" { return CloudNetReply(#"{"cursor":"2"}"#) }
            if request.url!.path == "/v1/sync/pull" {
                let i = pages.withLock { $0 += 1; return $0 }; return CloudNetReply(i == 1 ? first : last)
            }
            if request.url!.path.hasSuffix("/events") { streamRequests.withLock { $0 += 1 } }
            return CloudNetReply(#"{"code":"test","message":"Must not resume"}"#, status: 404)
        }
        let controller = CloudAccountReplica(store: store, client: client, root: root)
        controller.sessionChanged(.init(id: "u", name: "U", email: nil))
        // Install the partial local projection before network continuations run.
        store.conversations = [conversation]
        await controller.waitForSync()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(streamRequests.withLock { $0 }, 0)
        XCTAssertFalse(store.isRunning(conversation.id))
        controller.sessionChanged(nil)
    }
}
