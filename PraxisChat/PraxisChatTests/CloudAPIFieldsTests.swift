import XCTest
import AgentCore
import Synchronization
@testable import PraxisChat

@MainActor
final class CloudAPIFieldsTests: XCTestCase {
    private func connector(_ status: String? = nil, enabled: Bool = true) throws -> CloudCatalogConnector {
        var value: [String: Any] = ["type":"connector", "id":"remote", "name":"Remote", "url":"https://mcp.test", "transport":"streamableHttp", "enabled":enabled, "trusted":false, "disabledTools":[], "authStatus":"none", "updatedAt":"2026-10-31T00:00:00Z"]
        value["status"] = status
        return try JSONDecoder().decode(CloudCatalogConnector.self, from: JSONSerialization.data(withJSONObject: value))
    }
    private func message(_ parts: String) throws -> Message {
        try JSONDecoder().decode(CloudMessage.self, from: Data("{\"id\":\"message\",\"role\":\"user\",\"parts\":\(parts)}".utf8)).native
    }
    private func root() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    func testAllConnectorHealthStatesReachChatToggleAdapters() throws {
        for (raw, label) in [("connected","Connected"),("unreachable","Unreachable"),("needs_auth","Needs sign-in"),("needs_reauth","Sign in again"),("error","Error")] {
            let item = try connector(raw)
            XCTAssertEqual(item.statusLabel, label)
            XCTAssertEqual(item.adapter(isOn: true).statusLabel, label)
            XCTAssertEqual(item.needsSignIn, raw == "needs_auth" || raw == "needs_reauth")
        }
        XCTAssertEqual(try connector().statusLabel, "Not checked")
        XCTAssertEqual(try connector("connected", enabled: false).presentationStatus, "Off · Connected")
    }
    func testRefreshPOSTUsesReturnedStatusAndFailureKeepsLastKnownState() async throws {
        let calls = Mutex(0)
        let data = try JSONEncoder().encode(connector("unreachable"))
        let client = try cloudNetClient { request in
            XCTAssertEqual(request.url?.path, "/v1/connectors/remote/refresh")
            XCTAssertEqual(request.httpMethod, "POST")
            let count = calls.withLock { $0 += 1; return $0 }
            if count == 1 { return CloudNetReply(String(decoding: data, as: UTF8.self)) }
            return CloudNetReply(#"{"code":"unavailable","message":"Try later"}"#, status: 503)
        }
        let services = CloudServices(client: client)
        try await services.refreshConnector("remote")
        XCTAssertEqual(services.connectors.first?.status, "unreachable")
        do { try await services.refreshConnector("remote"); XCTFail("Refresh must surface server failures") }
        catch { XCTAssertEqual((error as? CloudAPIError)?.statusCode, 503) }
        XCTAssertEqual(services.connectors.first?.status, "unreachable")
    }
    func testDocumentPartBecomesStableReadOnlyFileChipWithoutFakeBytes() throws {
        let native = try message(#"[{"type":"text","text":"Read this"},{"type":"document","attachmentId":"opaque-file","name":"Plan.pdf","mediaType":"application/pdf"}]"#)
        let turn = Turn(userText: "Read this", transcript: [native], engine: .cloud)
        let first = CloudDocumentChips.visible(in: turn)
        XCTAssertEqual(first.map(\.name), ["Plan.pdf"])
        XCTAssertEqual(first.first?.kind, .file)
        XCTAssertEqual(first.first?.mediaType, "application/pdf")
        XCTAssertEqual(first, CloudDocumentChips.visible(in: turn))
        XCTAssertNil(AttachmentStore.shared.data(for: try XCTUnwrap(first.first?.id)))
        XCTAssertTrue(turn.attachments.isEmpty, "Presentation must not mutate upload/retry payloads")
    }
    func testRemoteDocumentDoesNotDuplicateLocalAttachmentChip() throws {
        let local = Attachment(kind: .file, name: "Plan.pdf", mediaType: "application/pdf")
        let native = try message(#"[{"type":"document","attachmentId":"uploaded-id","name":"Plan.pdf","mediaType":"application/pdf"}]"#)
        let turn = Turn(userText: "", attachments: [local], transcript: [native], engine: .cloud)
        XCTAssertEqual(CloudDocumentChips.visible(in: turn).map(\.id), [local.id])
    }
    func testSameNameDocumentsRemainDistinctAndReplayDoesNotDuplicate() throws {
        let native = try message(#"[{"type":"document","attachmentId":"first","name":"file.txt","mediaType":"text/plain"},{"type":"document","attachmentId":"second","name":"file.txt","mediaType":"text/plain"}]"#)
        let turn = Turn(userText: "", transcript: [native, native], engine: .cloud)
        let chips = CloudDocumentChips.visible(in: turn)
        XCTAssertEqual(chips.count, 2)
        XCTAssertEqual(Set(chips.map(\.id)).count, 2)
        var demo = turn; demo.engine = .demo
        XCTAssertTrue(CloudDocumentChips.visible(in: demo).isEmpty)
    }
    func testNewChatLeavesAutomaticTitleToServer() async throws {
        let client = try cloudNetClient { request in
            switch request.url!.path {
            case "/v1/chats/chat": return CloudNetReply(#"{"code":"not_found","message":"Missing"}"#, status: 404)
            case "/v1/chats":
                let body = try JSONSerialization.jsonObject(with: cloudNetBody(request)) as? [String: Any]
                XCTAssertEqual(body?["title"] as? String, "New chat")
                return CloudNetReply(#"{"id":"chat"}"#)
            case "/v1/runs": return CloudNetReply(#"{"id":"run","chatId":"chat","status":"running","lastEventId":0}"#)
            default: return CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"run.finished","outcome":"completed"}"#)])
            }
        }
        let req = ChatRunRequest(conversationID: UUID(), cloudChatID: "chat", history: [], userText: "Name this on the server", mode: .auto, effort: .high, modelID: "m", webSearch: false, attachments: [], policy: ToolPolicy(), approvals: AutoApprove(), setup: nil, compaction: nil, contextMeasurement: nil)
        var completed = false
        for await event in CloudChatEngine(client: client).run(req) {
            if case .finished(.completed) = event { completed = true }
        }
        XCTAssertTrue(completed)
    }
    func testServerTitleUpdatesConversationAndIndex() async throws {
        let client = try cloudNetClient { request in
            XCTAssertEqual(request.url?.path, "/v1/chats/opaque")
            return CloudNetReply(#"{"id":"opaque","title":"Server-set title"}"#)
        }
        let disk = ConversationStore(directory: root())
        let conversation = Conversation(title: "Local guess", cloudChatID: "opaque")
        let store = ChatStore(engine: CloudChatEngine(client: client), conversations: [conversation], persistence: disk)
        let applied = await store.refreshCloudServerTitle(conversationID: conversation.id, client: client)
        XCTAssertTrue(applied)
        XCTAssertEqual(conversation.title, "Server-set title")
        await disk.flush()
        XCTAssertEqual(disk.load()?.conversations.first?.title, "Server-set title")
    }
    func testFailedTitleRefreshRetainsLocalTitle() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(#"{"code":"offline","message":"Offline"}"#, status: 503) }
        let conversation = Conversation(title: "Keep me")
        let store = ChatStore(conversations: [conversation])
        let applied = await store.refreshCloudServerTitle(conversationID: conversation.id, client: client)
        XCTAssertFalse(applied); XCTAssertEqual(conversation.title, "Keep me")
    }
    func testTitleResponseCannotOverwriteAnotherAccountConversation() async throws {
        let started = expectation(description: "title requested")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        let client = try cloudNetClient { _ in
            started.fulfill(); _ = release.wait(timeout: .now() + 5)
            return CloudNetReply(#"{"id":"opaque","title":"Old account"}"#)
        }
        let old = Conversation(title: "Old", cloudChatID: "opaque")
        let store = ChatStore(conversations: [old])
        let request = Task { await store.refreshCloudServerTitle(conversationID: old.id, client: client) }
        await fulfillment(of: [started], timeout: 5)
        let next = Conversation(id: old.id, title: "New account", cloudChatID: "opaque")
        store.conversations = [next]
        release.signal()
        let applied = await request.value
        XCTAssertFalse(applied); XCTAssertEqual(next.title, "New account")
    }
    func testMCPProgressDecodesThroughReducerIntoRunningRowTitle() async throws {
        let request = ChatRunRequest(conversationID: UUID(), history: [], userText: "Run", mode: .auto, effort: .high, modelID: "m", webSearch: false, attachments: [], policy: ToolPolicy(), approvals: AutoApprove(), setup: nil, compaction: nil, contextMeasurement: nil)
        let mapper = CloudEventMapper(request: request)
        let payloads = [
            #"{"type":"tool.started","activity":{"id":"call","name":"index","source":{"type":"mcp","serverId":"remote","serverName":"Remote"},"presentation":{"category":"integration","runningTitle":"Indexing…","finishedTitle":"Indexed"}}}"#,
            #"{"type":"tool.running","callId":"call"}"#,
            #"{"type":"tool.progress","callId":"call","kind":"status","text":"Indexed 3 of 10 files"}"#
        ]
        var turn = Turn(userText: "Run", engine: .cloud), reducer = TurnReducer()
        for json in payloads {
            let payload = try JSONDecoder().decode(CloudEventPayload.self, from: Data(json.utf8))
            for event in await mapper.map(payload) { _ = reducer.reduce(event, into: &turn, at: Date()) }
        }
        let steps = turn.blocks.compactMap { if case .activity(let value) = $0 { return value }; return nil }.flatMap(\.steps)
        XCTAssertEqual(steps.first?.lineTitle, "Indexed 3 of 10 files")
        XCTAssertEqual(steps.first?.status, .running)
    }
}
