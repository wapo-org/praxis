import XCTest
import Synchronization
@testable import PraxisChat

@MainActor
final class CloudC5FollowingTests: XCTestCase {
    func testForegroundUserChannelDiscoversRemoteApprovalWithoutAnotherForegroundCycle() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let pulls = Mutex(0), eventHeaders = Mutex([String?]()), approved = Mutex(false)
        let rows = #"{"cursor":"1","entities":[{"key":"chat:chat","deleted":false,"value":{"id":"chat","title":"Web chat","updatedAt":"2026-10-31T00:00:00Z"}},{"key":"message:m","deleted":false,"value":{"id":"m","chatId":"chat","runId":"web-run","clientTurnId":"opaque-web-turn","role":"user","parts":[{"type":"text","text":"Started on web"}],"createdAt":"2026-10-31T00:00:00Z"}},{"key":"run:web-run","deleted":false,"value":{"id":"web-run","chatId":"chat","clientTurnId":"opaque-web-turn","status":"awaitingApproval","lastEventId":1}}]}"#
        let client = try cloudNetClient { request in
            switch request.url!.path {
            case "/v1/bootstrap": return CloudNetReply(#"{"eventCursor":17}"#)
            case "/v1/sync/root": return CloudNetReply(#"{"cursor":"1"}"#)
            case "/v1/sync/pull": return CloudNetReply(pulls.withLock { $0 += 1; return $0 } == 1 ? #"{"cursor":"0","entities":[]}"# : rows)
            case "/v1/events":
                eventHeaders.withLock { $0.append(request.value(forHTTPHeaderField: "Last-Event-ID")) }
                return CloudNetReply(sse: ["id: 18\nevent: user.event\ndata: {\"type\":\"user.event\",\"id\":18,\"entity\":\"run\",\"entityId\":\"web-run\",\"operation\":\"upsert\",\"syncCursor\":\"1\"}\n\n"])
            case "/v1/runs/web-run": return CloudNetReply(#"{"id":"web-run","chatId":"chat","clientTurnId":"opaque-web-turn","status":"awaitingApproval","lastEventId":1}"#)
            case "/v1/runs/web-run/events":
                if approved.withLock({ $0 }) {
                    return CloudNetReply(sse: [cloudNetFrame(2, #"{"type":"text.delta","blockId":"b","text":"Approved on iOS"}"#, run: "web-run"), cloudNetFrame(3, #"{"type":"run.finished","outcome":"completed"}"#, run: "web-run")])
                }
                return CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"approval.requested","approval":{"id":"approval","callId":"call","toolName":"write","source":{"type":"builtin"},"arguments":{},"reason":"Change","title":"Remote approval"}}"#, run: "web-run")])
            case "/v1/runs/web-run/approvals": approved.withLock { $0 = true }; return CloudNetReply(#"{"type":"ok"}"#)
            case "/v1/chats/chat": return CloudNetReply(#"{"id":"chat","title":"Web chat"}"#)
            default: XCTFail("Unexpected request \(request.url!.path)"); return CloudNetReply("{}")
            }
        }
        let store = ChatStore(conversations: [])
        let controller = CloudAccountReplica(store: store, client: client, root: root)
        controller.sessionChanged(.init(id: "u", name: "U", email: nil)); await controller.waitForSync()
        await waitUntil(timeout: 2) { !store.approvals.pendingIDs.isEmpty }
        XCTAssertEqual(eventHeaders.withLock { $0.first ?? nil }, "17")
        let id = try XCTUnwrap(store.approvals.pendingIDs.first)
        store.resolveApproval(id, decision: .allowOnce)
        await waitUntil(timeout: 3) { approved.withLock { $0 } && store.conversations.first(where: { $0.cloudChatID == "chat" })?.turns.first?.isFinished == true }
        XCTAssertTrue(approved.withLock { $0 })
        controller.background(); controller.sessionChanged(nil); await controller.waitForSync()
    }
}
