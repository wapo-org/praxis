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
    func testOpaqueRemoteChatIDUsedForStartAndStream() async throws {
        let backend = CloudTestBackend(chunkDelay: 0.001); defer { backend.shutdown() }
        var request = request(); request.cloudChatID = "opaque-remote-chat"
        let events = await collect(CloudChatEngine(client: try client(backend)).run(request))
        XCTAssertTrue(events.contains { if case .finished(.completed) = $0 { true } else { false } })
        let start = try XCTUnwrap(backend.recordedRequests().first { $0.path == "/v1/runs" })
        let body = try JSONDecoder().decode(JSONValue.self, from: start.body)
        XCTAssertEqual(body["chatId"]?.stringValue, "opaque-remote-chat")
    }
    func testStopImmediatelyBeforeConsumerCancellationStillPostsDurableCancel() async throws {
        let backend = CloudTestBackend(scenario: .cancel, chunkDelay: 0.001); defer { backend.shutdown() }
        let flag = RunCancelFlag()
        var request = request(); request.isCancelled = { flag.isCancelled }
        let received = expectation(description: "receiving stream")
        let engine = CloudChatEngine(client: try client(backend), onCursor: { _, _, _, _ in received.fulfill() })
        let task = Task { for await _ in engine.run(request) {} }
        await fulfillment(of: [received], timeout: 4)
        flag.cancel(); task.cancel() // deliberately faster than the watcher
        await task.value
        await waitUntil { backend.recordedRequests().contains { $0.path.hasSuffix("/cancel") } }
        XCTAssertTrue(backend.recordedRequests().contains { $0.path.hasSuffix("/cancel") })
    }
    func testRestoredApprovalHandlerRespondsAfterCursorWithoutReplay() async throws {
        let backend = CloudTestBackend(scenario: .nestedApproval, chunkDelay: 0.001); defer { backend.shutdown() }
        let client = try client(backend)
        let request = request()
        let chat = CloudChatInput(id: request.conversationID.uuidString, title: "Restored", mode: "auto", connectorIds: [], disabledConnectorIds: [])
        let _: CloudChatIdentity = try await client.send("/v1/chats", method: "POST", body: JSONEncoder().encode(chat))
        let run: CloudRun = try await client.send("/v1/runs", method: "POST", body: Data(("{\"type\":\"run.start\",\"chatId\":\"" + request.conversationID.uuidString + "\",\"text\":\"Restore\"}").utf8))
        let snapshot: JSONValue = try await client.send("/v1/runs/" + run.id + "/snapshot")
        let approvalJSON = try XCTUnwrap(snapshot["pendingApprovals"]?.arrayValue?.first)
        let approval = try JSONDecoder().decode(CloudApproval.self, from: Data(approvalJSON.encodedString().utf8))
        let cursor = Int(snapshot["lastEventId"]?.doubleValue ?? 0)
        let events = await collect(CloudChatEngine(client: client).resume(request: request, runID: run.id, cursor: cursor, pendingEvents: [.approval(approval)]))
        XCTAssertTrue(events.contains { if case .finished(.completed) = $0 { true } else { false } })
        XCTAssertEqual(backend.recordedRequests().filter { $0.path.hasSuffix("/approvals") }.count, 1)
        XCTAssertFalse(events.contains { if case .toolAwaitingApproval = $0 { true } else { false } }, "Restoration registers the waiter; the journal already restored the card")
    }
    func testLocalAPI8808RunThroughProductionTransportWhenEnabled() async throws {
        guard ProcessInfo.processInfo.environment["PRAXIS_LOCAL_API"] == "1" else { throw XCTSkip("Set TEST_RUNNER_PRAXIS_LOCAL_API=1 with the C-net API on port 8808") }
        let config = try CloudServerConfiguration(baseURL: URL(string: "http://127.0.0.1:8808")!)
        let client = CloudAPIClient(configuration: config, session: URLSession(configuration: .ephemeral), tokens: CloudSessionStore(inMemory: true))
        try await client.tokens.setToken("dev-local", for: config.origin)
        var request = request(); request.modelID = "scripted"
        let events = await collect(CloudChatEngine(client: client).run(request))
        XCTAssertTrue(events.contains { if case .finished(.completed) = $0 { true } else { false } })
        let messages: [Message] = events.flatMap { event -> [Message] in if case .committed(let m) = event { m } else { [] } }
        XCTAssertEqual(messages.first?.role, .user)
        XCTAssertEqual(messages.last?.role, .assistant)
        XCTAssertTrue(messages.last?.text.contains("Hello cloud") == true)
    }
    func testAttachmentUploadsBeforeRunAndIncludesPrivacyWithoutBearerAtStorage() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AttachmentStore(directory: directory)
        var attachment = Attachment(kind: .file, name: "private.txt", fileData: Data("attachment bytes".utf8), mediaType: "text/plain", store: store)
        attachment.isHiddenFromCode = true
        var request = request(); request.attachments = [attachment]
        let order = Mutex<[String]>([])
        let chatID = request.conversationID.uuidString
        let client = try cloudNetClient(defaultHeaders: ["Authorization": "Bearer session-default"]) { request in
            let path = request.url!.path
            order.withLock { $0.append(path) }
            switch path {
            case "/v1/chats/" + chatID: return CloudNetReply("{\"id\":\"" + chatID + "\"}")
            case "/v1/uploads": return CloudNetReply(#"{"uploadUrl":"https://storage.test/upload","expiresAt":"2027-01-01T00:00:00Z"}"#)
            case "/upload":
                XCTAssertEqual(request.url!.host(), "storage.test")
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "")
                XCTAssertFalse(request.httpShouldHandleCookies)
                XCTAssertEqual(cloudNetBody(request), Data("attachment bytes".utf8))
                return CloudNetReply(#"{"storageId":"storage-id"}"#)
            case "/v1/uploads/complete":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer api-session")
                let body = try JSONDecoder().decode(JSONValue.self, from: cloudNetBody(request))
                XCTAssertEqual(body["hiddenFromCode"], .bool(true))
                return CloudNetReply(#"{"id":"attachment-id"}"#)
            case "/v1/runs":
                let body = try JSONDecoder().decode(JSONValue.self, from: cloudNetBody(request))
                XCTAssertEqual(body["attachmentIds"]?.arrayValue, [.string("attachment-id")])
                return CloudNetReply("{\"id\":\"run\",\"chatId\":\"" + chatID + "\",\"status\":\"running\",\"lastEventId\":0}")
            default: return CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"run.finished","outcome":"completed"}"#, chat: chatID)])
            }
        }
        try await client.tokens.setToken("api-session", for: client.configuration.origin)
        let events = await collect(CloudChatEngine(client: client, attachments: store).run(request))
        XCTAssertTrue(events.contains { if case .finished(.completed) = $0 { true } else { false } })
        let paths = order.withLock { $0 }
        XCTAssertLessThan(try XCTUnwrap(paths.firstIndex(of: "/v1/uploads/complete")), try XCTUnwrap(paths.firstIndex(of: "/v1/runs")))
    }
    func testCloudSelectionDecodesProviderAndModelPair() throws {
        let pair = try JSONEncoder().encode(["provider", "model"])
        let selection = CloudChatEngine.modelSelection("cloud:" + pair.base64EncodedString())
        XCTAssertEqual(selection.provider, "provider"); XCTAssertEqual(selection.model, "model")
    }
}
