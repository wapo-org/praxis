import XCTest
import AgentCore
import Synchronization
@testable import PraxisChat

/// REV-C3 F9: the journal's duplicate verdict must gate what the UI sees, not
/// only the journal file. A reconnect whose replay overlaps already-delivered
/// events must not repeat text in the turn.
@MainActor
final class CloudJournalDedupeUITests: XCTestCase {
    func testReconnectReplayOverlapDeliversEachDeltaOnce() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let streams = Mutex(0)
        let client = try cloudNetClient { request in
            switch request.url!.path {
            case "/v1/runs": return CloudNetReply(#"{"id":"run","chatId":"chat","status":"running","lastEventId":0}"#)
            case "/v1/runs/run/events":
                let first = cloudNetFrame(1, #"{"type":"text.delta","blockId":"b","text":"Hel"}"#)
                let second = cloudNetFrame(2, #"{"type":"text.delta","blockId":"b","text":"lo"}"#)
                // The second connection ignores Last-Event-ID and replays from the start.
                if streams.withLock({ $0 += 1; return $0 }) == 1 { return CloudNetReply(sse: [first, second]) }
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
            if case .textDelta(_, let text) = event { deltas.append(text) }
            _ = reducer.reduce(event, into: &turn, at: Date())
        }
        XCTAssertEqual(streams.withLock { $0 }, 2, "The fixture must exercise a reconnect")
        XCTAssertEqual(deltas, ["Hel", "lo", " world"])
        XCTAssertEqual(turn.outcome, .completed)
        XCTAssertEqual(turn.transcript.filter { $0.role == .assistant }.map(\.text).joined(), "Hello world")
    }
}
