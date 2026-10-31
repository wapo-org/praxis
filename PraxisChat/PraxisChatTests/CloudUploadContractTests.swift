import XCTest
import AgentCore
import Synchronization
@testable import PraxisChat

@MainActor
final class CloudUploadContractTests: XCTestCase {
    private func upload(method: String, receipt: String = #"{"storageId":"convex-file"}"#, status: Int = 200, apiOrigin: Bool = false) async throws -> (Turn, [String]) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let files = AttachmentStore(directory: root)
        let attachment = Attachment(kind: .file, name: "upload.txt", fileData: Data("Actual bytes".utf8), mediaType: "text/plain", store: files)
        let calls = Mutex<[String]>([])
        let uploadURL = apiOrigin ? "https://cloud.test/once" : "https://upload.convex.test/once"
        let api = try cloudNetClient(defaultHeaders: ["Authorization": "Bearer default-must-not-leak"]) { request in
            let path = request.url!.path
            calls.withLock { $0.append(path) }
            switch path {
            case "/v1/chats/chat": return CloudNetReply(#"{"id":"chat"}"#)
            case "/v1/uploads": return CloudNetReply("{\"uploadUrl\":\"\(uploadURL)\",\"method\":\"\(method)\",\"expiresAt\":\"2027-01-01T00:00:00Z\"}")
            case "/once":
                XCTAssertEqual(request.httpMethod, method)
                if apiOrigin { XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer api-token") }
                else { XCTAssertTrue((request.value(forHTTPHeaderField: "Authorization") ?? "").isEmpty) }
                XCTAssertFalse(request.httpShouldHandleCookies)
                XCTAssertEqual(cloudNetBody(request), Data("Actual bytes".utf8))
                return CloudNetReply(receipt, status: status)
            case "/v1/uploads/complete":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer api-token")
                return CloudNetReply(#"{"id":"uploaded"}"#)
            case "/v1/runs": return CloudNetReply(#"{"id":"run","chatId":"chat","status":"running","lastEventId":0}"#)
            default: return CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"run.finished","outcome":"completed"}"#)])
            }
        }
        try await api.tokens.setToken("api-token", for: api.configuration.origin)
        let request = ChatRunRequest(conversationID: UUID(), cloudChatID: "chat", history: [], userText: "Upload", mode: .auto, effort: .high, modelID: "m", webSearch: false, attachments: [attachment], policy: ToolPolicy(), approvals: AutoApprove(), setup: nil, compaction: nil, contextMeasurement: nil)
        var turn = Turn(userText: "Upload"), reducer = TurnReducer()
        for await event in CloudChatEngine(client: api, attachments: files).run(request) { _ = reducer.reduce(event, into: &turn, at: Date()) }
        return (turn, calls.withLock { $0 })
    }
    func testConvexPOSTWithoutExternalBearer() async throws {
        let (turn, _) = try await upload(method: "POST")
        XCTAssertEqual(turn.outcome, .completed)
    }
    func testAPIOriginUploadRetainsAPIBearer() async throws {
        let (turn, _) = try await upload(method: "PUT", apiOrigin: true)
        XCTAssertEqual(turn.outcome, .completed)
    }
    func testReturnedPUTMethodIsHonoredWithoutExternalBearer() async throws {
        let (turn, _) = try await upload(method: "PUT")
        XCTAssertEqual(turn.outcome, .completed)
    }
    func testHTTPUploadFailureNeverCompletesAttachmentOrStartsRun() async throws {
        let (turn, paths) = try await upload(method: "POST", receipt: #"{"code":"upload_failed","message":"Storage rejected bytes"}"#, status: 500)
        guard case .failed = turn.outcome else { return XCTFail("Upload error must be visible") }
        XCTAssertFalse(paths.contains("/v1/uploads/complete")); XCTAssertFalse(paths.contains("/v1/runs"))
    }
    func testMissingStorageIDNeverCompletesAttachmentOrStartsRun() async throws {
        let (turn, paths) = try await upload(method: "POST", receipt: "{}")
        guard case .failed = turn.outcome else { return XCTFail("Missing storage id must be visible") }
        XCTAssertFalse(paths.contains("/v1/uploads/complete")); XCTAssertFalse(paths.contains("/v1/runs"))
    }
    func testEmptyStorageIDNeverCompletesAttachmentOrStartsRun() async throws {
        let (turn, paths) = try await upload(method: "POST", receipt: #"{"storageId":""}"#)
        guard case .failed = turn.outcome else { return XCTFail("Empty storage id must be visible") }
        XCTAssertFalse(paths.contains("/v1/uploads/complete")); XCTAssertFalse(paths.contains("/v1/runs"))
    }
}
