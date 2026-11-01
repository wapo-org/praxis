import XCTest
import AgentCore
import Synchronization
@testable import PraxisChat

/// REV-C3 F9: journal dedupe must hold at the UI, not only in the journal file.
/// Within one SSE session the transport cursor drops overlap; across a
/// background/foreground reattach the journal replay and the new stream both
/// carry already-shown events, and the UI must still see each delta once.
@MainActor
final class CloudJournalDedupeUITests: XCTestCase {
    func testReattachAfterBackgroundDeliversEachDeltaOnce() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cursors = Mutex([String?]())
        let client = try cloudNetClient { request in
            switch request.url!.path {
            case "/v1/chats/chat": return CloudNetReply(#"{"id":"chat"}"#)
            case "/v1/runs": return CloudNetReply(#"{"id":"run","chatId":"chat","status":"running","lastEventId":0}"#)
            case "/v1/runs/run/events":
                let first = cloudNetFrame(1, #"{"type":"text.delta","blockId":"b","text":"Hel"}"#)
                let second = cloudNetFrame(2, #"{"type":"text.delta","blockId":"b","text":"lo"}"#)
                let attempt = cursors.withLock { $0.append(request.value(forHTTPHeaderField: "Last-Event-ID")); return $0.count }
                // The first stream stays open until the app backgrounds; the
                // reattached stream overlaps by replaying from the start.
                if attempt == 1 { return CloudNetReply(sse: [first, second], close: false) }
                return CloudNetReply(sse: [first, second, cloudNetFrame(3, #"{"type":"text.delta","blockId":"b","text":" world"}"#),
                                           cloudNetFrame(4, #"{"type":"run.finished","outcome":"completed"}"#)])
            default: return CloudNetReply(#"{"code":"not_found","message":"No fixture"}"#, status: 404)
            }
        }
        let engine = CloudLifecycleEngine(client: client, journal: CloudRunJournal(directory: root), elicitations: ElicitationCenter())
        var req = ChatRunRequest(conversationID: UUID(), history: [], userText: "Overlap", mode: .auto, effort: .high, modelID: "m", webSearch: false, attachments: [], policy: ToolPolicy(), approvals: AutoApprove(), setup: nil, compaction: nil, contextMeasurement: nil)
        req.cloudChatID = "chat"
        var turn = Turn(userText: req.userText), reducer = TurnReducer(), deltas: [String] = []
        for await event in engine.run(req) {
            if case .textDelta(_, let text) = event {
                deltas.append(text)
                if deltas.count == 2 { await engine.setBackgrounded(true); await engine.setBackgrounded(false) }
            }
            _ = reducer.reduce(event, into: &turn, at: Date())
        }
        XCTAssertEqual(cursors.withLock { $0.count }, 2, "The fixture must exercise a reattach")
        XCTAssertEqual(deltas, ["Hel", "lo", " world"])
        XCTAssertEqual(turn.outcome, .completed)
    }
}
