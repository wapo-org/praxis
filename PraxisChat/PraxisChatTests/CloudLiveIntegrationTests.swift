import XCTest
import Synchronization
import AgentCore
import AgentMCP
@testable import PraxisChat

@MainActor
final class CloudLiveIntegrationTests: XCTestCase {
    private func client() async throws -> CloudAPIClient {
        guard let raw = ProcessInfo.processInfo.environment["PRAXIS_LIVE_API"], raw == "http://127.0.0.1:8807" else {
            throw XCTSkip("Set PRAXIS_LIVE_API=http://127.0.0.1:8807 to exercise the real local API")
        }
        let configuration = try CloudServerConfiguration(baseURL: URL(string: raw)!)
        let client = CloudAPIClient(configuration: configuration, session: URLSession(configuration: .ephemeral), tokens: CloudSessionStore(inMemory: true))
        try await client.tokens.setToken("dev-local", for: configuration.origin)
        return client
    }
    private func request(chat: UUID = UUID(), text: String = "Hello live cloud") -> ChatRunRequest {
        ChatRunRequest(conversationID: chat, history: [], userText: text, mode: .auto, effort: .high,
                       modelID: "scripted", webSearch: false, attachments: [], policy: ToolPolicy(), approvals: AutoApprove(),
                       setup: nil, compaction: nil, contextMeasurement: nil)
    }
    private func drive(_ script: String, client: CloudAPIClient, request: ChatRunRequest? = nil, cancel: Bool = false) async throws -> (Turn, [AgentEvent]) {
        let previous = UserDefaults.standard.object(forKey: "PraxisCloudScenario")
        UserDefaults.standard.set(script, forKey: "PraxisCloudScenario")
        defer { UserDefaults.standard.set(previous, forKey: "PraxisCloudScenario") }
        let flag = RunCancelFlag()
        var request = request ?? self.request()
        request.isCancelled = { flag.isCancelled }
        let center = ElicitationCenter()
        var sawURL = false
        var sawForm = false
        let responder = Task {
            while !Task.isCancelled {
                if let pending = center.current {
                    if case .url = pending.request.kind { sawURL = true; center.respond(pending.id, with: .accept(nil)) }
                    else { sawForm = true; center.respond(pending.id, with: .accept(["name": "Live test"])) }
                }
                try? await Task.sleep(for: .milliseconds(10))
            }
        }
        defer { responder.cancel() }
        let engine = CloudChatEngine(client: client, elicitations: center)
        let finished = expectation(description: script)
        let worker = Task { () -> [AgentEvent] in
            var events: [AgentEvent] = []
            for await event in engine.run(request) {
                events.append(event)
                if cancel, case .textDelta = event { flag.cancel() }
            }
            finished.fulfill()
            return events
        }
        await fulfillment(of: [finished], timeout: 60)
        worker.cancel()
        let events = await worker.value
        var turn = Turn(userText: request.userText)
        var reducer = TurnReducer()
        for event in events { _ = reducer.reduce(event, into: &turn, at: Date()) }
        if script == "elicitationURL", case .failed(let reason) = turn.outcome,
           reason.contains("elicitationURL"), reason.contains("Invalid") {
            throw XCTSkip("scenario not available on this server: elicitationURL")
        }
        if script == "elicitationURL" { XCTAssertTrue(sawURL) }
        if script == "elicitation" { XCTAssertTrue(sawForm) }
        XCTAssertTrue(turn.isFinished, script)
        return (turn, events)
    }
    private func completed(_ script: String) async throws -> [AgentEvent] {
        let api = try await client()
        let (turn, events) = try await drive(script, client: api)
        XCTAssertEqual(turn.outcome, .completed, "\(script): \(String(describing: turn.outcome))")
        XCTAssertEqual(turn.transcript.first?.role, .user)
        XCTAssertEqual(turn.transcript.last?.role, .assistant)
        XCTAssertFalse(turn.blocks.isEmpty)
        return events
    }
    func testLiveText() async throws { _ = try await completed("text") }
    func testLiveTools() async throws {
        let events = try await completed("tools")
        XCTAssertTrue(events.contains { if case .toolFinished = $0 { true } else { false } })
    }
    func testLiveApproval() async throws {
        let events = try await completed("approval")
        XCTAssertTrue(events.contains { if case .toolAwaitingApproval = $0 { true } else { false } })
    }
    func testLiveNestedApproval() async throws {
        let events = try await completed("nestedApproval")
        XCTAssertTrue(events.contains { if case .toolAwaitingApproval(let a) = $0 { a.parentCallID != nil } else { false } })
    }
    func testLiveElicitationForm() async throws { _ = try await completed("elicitation") }
    func testLiveElicitationURL() async throws { _ = try await completed("elicitationURL") }
    func testLiveVision() async throws {
        let events = try await completed("vision")
        XCTAssertTrue(events.contains { if case .toolCallStarted(let t) = $0 { t.name == "image_input" } else { false } })
    }
    func testLiveLong() async throws { _ = try await completed("long") }
    func testLiveError() async throws {
        let (turn, _) = try await drive("error", client: try await client())
        guard case .failed = turn.outcome else { return XCTFail("Expected server failure") }
    }
    func testLiveCancel() async throws {
        let (turn, _) = try await drive("long", client: try await client(), cancel: true)
        XCTAssertEqual(turn.outcome, .stopped)
    }
    func testLiveCompaction() async throws {
        let client = try await client()
        let chat = UUID()
        _ = try await drive("text", client: client, request: request(chat: chat, text: String(repeating: "Context history. ", count: 400)))
        let (turn, events) = try await drive("compaction", client: client, request: request(chat: chat))
        XCTAssertEqual(turn.outcome, .completed)
        XCTAssertTrue(events.contains { if case .compaction = $0 { true } else { false } })
    }
    func testLiveReconnectEventIDsHaveNoGapsOrDuplicates() async throws {
        let api = try await client()
        let previous = UserDefaults.standard.object(forKey: "PraxisCloudScenario")
        UserDefaults.standard.set("long", forKey: "PraxisCloudScenario")
        defer { UserDefaults.standard.set(previous, forKey: "PraxisCloudScenario") }
        let ids = Mutex<[Int]>([])
        let runID = Mutex<String?>(nil)
        let arrived = expectation(description: "connection received live events")
        let req = request()
        let engine = CloudChatEngine(client: api, onRunStarted: { _, _, id in runID.withLock { $0 = id } }, onEvent: { _, _, _, raw in
            let event = try JSONDecoder().decode(CloudRunEvent.self, from: raw)
            ids.withLock { $0.append(event.id) }
            if event.id == 5 { arrived.fulfill() }
        })
        let reader = Task { for await _ in engine.run(req) {} }
        await fulfillment(of: [arrived], timeout: 10)
        reader.cancel(); await reader.value
        let id = try XCTUnwrap(runID.withLock { $0 })
        let cursor = try XCTUnwrap(ids.withLock { $0.last })
        let resumed = Mutex<[Int]>([])
        try await CloudSSEClient(client: api).consume(runID: id, chatID: req.conversationID.uuidString, after: cursor) {
            event in resumed.withLock { $0.append(event.id) }
        }
        let all = Mutex<[Int]>([])
        try await CloudSSEClient(client: api).consume(runID: id, chatID: req.conversationID.uuidString) {
            event in all.withLock { $0.append(event.id) }
        }
        let actual = ids.withLock { $0 } + resumed.withLock { $0 }
        XCTAssertEqual(actual, all.withLock { $0 })
        XCTAssertEqual(actual.count, Set(actual).count)
    }

}
