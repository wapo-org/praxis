import XCTest
import Synchronization
import AgentCore
import AgentMCP
@testable import PraxisChat

@MainActor
final class CloudEngineTests: XCTestCase {
    private func request(approvals: any ApprovalHandler = AutoApprove()) -> ChatRunRequest {
        ChatRunRequest(conversationID: UUID(), history: [], userText: "Hello cloud", mode: .auto, effort: .high,
                       modelID: "stub-model", webSearch: false, attachments: [], policy: ToolPolicy(), approvals: approvals,
                       setup: nil, compaction: nil, contextMeasurement: nil)
    }
    private func client(_ backend: CloudTestBackend) throws -> CloudAPIClient {
        CloudAPIClient(configuration: try CloudServerConfiguration(baseURL: CloudTestBackend.baseURL),
                       session: backend.makeSession(), tokens: CloudSessionStore(inMemory: true))
    }
    private func collect(_ stream: AsyncStream<AgentEvent>, timeout: TimeInterval = 8) async -> [AgentEvent] {
        let ended = expectation(description: "stream finishes")
        let task = Task { var events: [AgentEvent] = []; for await event in stream { events.append(event) }; ended.fulfill(); return events }
        await fulfillment(of: [ended], timeout: timeout)
        task.cancel()
        return await task.value
    }
    func testTextRunUsesStableChatAndTurnIDsAndCommitsOnce() async throws {
        let backend = CloudTestBackend(chunkDelay: 0.001); defer { backend.shutdown() }
        let engine = CloudChatEngine(client: try client(backend))
        let request = request()
        let events = await collect(engine.run(request))
        let text = events.compactMap { if case .textDelta(_, let text) = $0 { text } else { nil } }.joined()
        XCTAssertTrue(text.contains("Hello cloud"))
        let committed: [Message] = events.flatMap { event -> [Message] in if case .committed(let m) = event { m } else { [] } }
        XCTAssertEqual(committed.map(\.role), [.user, .assistant])
        let outcomes: [RunOutcome] = events.compactMap { event -> RunOutcome? in if case .finished(let outcome) = event { outcome } else { nil } }
        XCTAssertEqual(outcomes, [.completed])
        let start = try XCTUnwrap(backend.recordedRequests().first { $0.path == "/v1/runs" })
        let body = try JSONDecoder().decode(JSONValue.self, from: start.body)
        XCTAssertEqual(body["clientTurnId"]?.stringValue, request.turnID.uuidString)
        XCTAssertEqual(body["idempotencyKey"]?.stringValue, request.turnID.uuidString)
        XCTAssertEqual(body["chatId"]?.stringValue, request.conversationID.uuidString)
    }
    func testReconnectKeepsOneCopyOfEveryDelta() async throws {
        let backend = CloudTestBackend(scenario: .reconnect, chunkDelay: 0.001); defer { backend.shutdown() }
        let events = await collect(CloudChatEngine(client: try client(backend)).run(request()))
        let text = events.compactMap { if case .textDelta(_, let t) = $0 { t } else { nil } }.joined()
        XCTAssertEqual(text, "Cloud reconnect: one 🌍 answer, no duplicate text.")
        let streams = backend.recordedRequests().filter { $0.path.hasSuffix("/events") }
        XCTAssertEqual(streams.count, 2)
        XCTAssertEqual(streams.last?.lastEventID, "4")
    }
    func testNestedApprovalUsesRequestHandlerAndDurableApprovalID() async throws {
        let backend = CloudTestBackend(scenario: .nestedApproval, chunkDelay: 0.001); defer { backend.shutdown() }
        let events = await collect(CloudChatEngine(client: try client(backend)).run(request()))
        let approvals = events.compactMap { if case .toolAwaitingApproval(let a) = $0 { a } else { nil } }
        XCTAssertEqual(approvals.first?.id, "stub-call")
        XCTAssertEqual(approvals.first?.parentCallID, "stub-parent")
        let post = try XCTUnwrap(backend.recordedRequests().first { $0.path.hasSuffix("/approvals") })
        let body = try JSONDecoder().decode(JSONValue.self, from: post.body)
        XCTAssertEqual(body["approvalId"]?.stringValue, "stub-approval")
        XCTAssertEqual(body["decision"]?.stringValue, "allowOnce")
    }
    func testElicitationUsesProvidedCenterAndResponseEndpoint() async throws {
        let backend = CloudTestBackend(scenario: .elicitation, chunkDelay: 0.001); defer { backend.shutdown() }
        let center = ElicitationCenter()
        let engine = CloudChatEngine(client: try client(backend), elicitations: center)
        let task = Task { await collect(engine.run(request())) }
        await waitUntil { center.current != nil }
        let pending = try XCTUnwrap(center.current)
        XCTAssertEqual(pending.request.message, "Choose a fixture name")
        center.respond(pending.id, with: .accept(["name": "cloud"]))
        let events = await task.value
        XCTAssertTrue(events.contains { if case .finished(.completed) = $0 { true } else { false } })
        XCTAssertTrue(backend.recordedRequests().contains { $0.path.hasSuffix("/elicitations") })
    }
    func testPendingApprovalDoesNotBlockReadingFinishedEvent() async throws {
        let approval = #"{"type":"approval.requested","approval":{"id":"a","callId":"c","toolName":"write","source":{"type":"builtin"},"arguments":{},"reason":"change","title":"Write"}}"#
        let request = request(approvals: ApprovalCenter())
        let client = try cloudNetClient { _ in CloudNetReply(sse: [cloudNetFrame(1, approval, chat: request.conversationID.uuidString), cloudNetFrame(2, #"{"type":"run.finished","outcome":"completed"}"#, chat: request.conversationID.uuidString)]) }
        let events = await collect(CloudChatEngine(client: client).resume(request: request, runID: "run", cursor: 0))
        XCTAssertTrue(events.contains { if case .finished(.completed) = $0 { true } else { false } })
    }
    func testPendingElicitationDoesNotBlockReaderAndIsCancelledAtEnd() async throws {
        let request = request()
        let client = try cloudNetClient { _ in CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"elicitation.requested","elicitation":{"id":"a","message":"Input","schema":{"type":"object"}}}"#, chat: request.conversationID.uuidString), cloudNetFrame(2, #"{"type":"run.finished","outcome":"completed"}"#, chat: request.conversationID.uuidString)]) }
        let center = ElicitationCenter()
        let events = await collect(CloudChatEngine(client: client, elicitations: center).resume(request: request, runID: "run", cursor: 0))
        XCTAssertTrue(events.contains { if case .finished(.completed) = $0 { true } else { false } })
        await waitUntil { center.queue.isEmpty }
        XCTAssertTrue(center.queue.isEmpty)
    }
    func testCompactionAndVisionPreservePresentationAndCallback() async throws {
        let records = Mutex<[ContextCompaction]>([])
        var request = request()
        request.onCompaction = { record in records.withLock { $0.append(record) } }
        let compaction = CloudTestBackend(scenario: .compaction, chunkDelay: 0.001); defer { compaction.shutdown() }
        let events = await collect(CloudChatEngine(client: try client(compaction)).run(request))
        XCTAssertEqual(records.withLock { $0.count }, 1)
        XCTAssertTrue(events.contains { if case .compaction(_, .finished) = $0 { true } else { false } })
        let vision = CloudTestBackend(scenario: .vision, chunkDelay: 0.001); defer { vision.shutdown() }
        let visual = await collect(CloudChatEngine(client: try client(vision)).run(self.request()))
        XCTAssertTrue(visual.contains { if case .toolCallStarted(let a) = $0 { a.name == "image_input" } else { false } })
        XCTAssertTrue(visual.contains { if case .toolFinished(_, let c) = $0 { c.summary == "A fixture image." } else { false } })
    }
    func testStopPostsCancelWhileDetachDoesNot() async throws {
        let backend = CloudTestBackend(scenario: .cancel, chunkDelay: 0.001); defer { backend.shutdown() }
        let flag = RunCancelFlag()
        var request = request(); request.isCancelled = { flag.isCancelled }
        let engine = CloudChatEngine(client: try client(backend), onRunStarted: { _, _, _ in flag.cancel() })
        let events = await collect(engine.run(request))
        XCTAssertTrue(backend.recordedRequests().contains { $0.path.hasSuffix("/cancel") })
        XCTAssertTrue(events.contains { if case .finished(.cancelled) = $0 { true } else { false } })
        let detached = CloudTestBackend(scenario: .cancel, chunkDelay: 0.001); defer { detached.shutdown() }
        let began = expectation(description: "durable run")
        let detachedEngine = CloudChatEngine(client: try client(detached), onCursor: { _, _, _, _ in began.fulfill() })
        let task = Task { for await _ in detachedEngine.run(self.request()) {} }
        await fulfillment(of: [began], timeout: 4)
        task.cancel()
        await task.value
        XCTAssertFalse(detached.recordedRequests().contains { $0.path.hasSuffix("/cancel") })
    }
    func testJournalReceivesOriginalUnknownJSONBeforeProjection() async throws {
        let request = request()
        let json = #"{"type":"future.event","custom":{"opaque":[1,2,3]}}"#
        let client = try cloudNetClient { _ in CloudNetReply(sse: [cloudNetFrame(1, json, chat: request.conversationID.uuidString), cloudNetFrame(2, #"{"type":"run.finished","outcome":"completed"}"#, chat: request.conversationID.uuidString)]) }
        let data = Mutex<[Data]>([])
        let engine = CloudChatEngine(client: client, onEvent: { _, _, _, raw in data.withLock { $0.append(raw) } })
        _ = await collect(engine.resume(request: request, runID: "run", cursor: 0))
        let raw = try XCTUnwrap(data.withLock { $0.first })
        let value = try JSONDecoder().decode(JSONValue.self, from: raw)
        XCTAssertEqual(value["event"]?["custom"]?["opaque"]?.arrayValue?.count, 3)
    }
    func testContextMeasurementReasoningAndToolProgressMapping() async throws {
        let measured = Mutex<[ContextMeasurement]>([])
        var request = request(); request.onContextMeasured = { value in measured.withLock { $0.append(value) } }
        let mapper = CloudEventMapper(request: request)
        let measurement = await mapper.map(.measured(400, 0, "model"))
        XCTAssertEqual(measured.withLock { $0.first?.promptTokens }, 400)
        XCTAssertTrue(measurement.contains { if case .contextMeasured = $0 { true } else { false } })
        let reasoning = await mapper.map(.reasoning("r", "Thinking"))
        XCTAssertTrue(reasoning.contains { if case .reasoningDelta("r", "Thinking") = $0 { true } else { false } })
        let progress = await mapper.map(.progress("tool", "trace", nil, ["trace line"], .api))
        XCTAssertTrue(progress.contains { if case .toolProgress("tool", .trace(.api, "trace line")) = $0 { true } else { false } })
    }
    func testCloudSelectionDecodesProviderAndModelPair() throws {
        let pair = try JSONEncoder().encode(["provider", "model"])
        let selection = CloudChatEngine.modelSelection("cloud:" + pair.base64EncodedString())
        XCTAssertEqual(selection.provider, "provider"); XCTAssertEqual(selection.model, "model")
    }
}
