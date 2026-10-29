import XCTest
@testable import PraxisChat

/// Contract tests for the deterministic server itself. Production transport and
/// reducer coverage lives in C-net's suite; these guard the fixture assumptions
/// used by the UI suite, including races and replay rather than only happy paths.
final class CloudTestBackendTests: XCTestCase, @unchecked Sendable {
    private var backend: CloudTestBackend!
    private var session: URLSession!

    override func setUp() {
        backend = CloudTestBackend(chunkDelay: 0.001)
        session = backend.makeSession()
    }
    override func tearDown() {
        session.invalidateAndCancel(); backend.shutdown()
        session = nil; backend = nil
    }
    private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil) throws -> URLRequest {
        var request = URLRequest(url: URL(string: path, relativeTo: CloudTestBackend.baseURL)!)
        request.httpMethod = method
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return request
    }
    private func json(_ path: String, method: String = "GET", body: [String: Any]? = nil,
                      status: Int = 200, file: StaticString = #filePath, line: UInt = #line) async throws -> [String: Any] {
        let (data, response) = try await session.data(for: request(path, method: method, body: body))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, status, file: file, line: line)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any], file: file, line: line)
    }
    private func start(_ script: String = "text", key: String? = nil) async throws -> String {
        let chat = try await json("/v1/chats", method: "POST", body: ["type": "chat.input", "title": "Fixture"], status: 201)
        var input: [String: Any] = ["type": "run.start", "chatId": try XCTUnwrap(chat["id"] as? String), "text": "Hello", "script": script]
        if let key { input["idempotencyKey"] = key }
        let run = try await json("/v1/runs", method: "POST", body: input, status: 202)
        return try XCTUnwrap(run["id"] as? String)
    }
    private struct StreamResult: Sendable {
        var data = Data()
        var error: Error?
        var envelopes: [[String: Any]] {
            String(decoding: data, as: UTF8.self).components(separatedBy: "\r\n")
                .filter { $0.hasPrefix("data: ") }
                .compactMap { try? JSONSerialization.jsonObject(with: Data($0.dropFirst(6).utf8)) as? [String: Any] }
        }
        var payloads: [[String: Any]] { envelopes.compactMap { $0["event"] as? [String: Any] } }
    }
    private func stream(_ id: String, after: String? = nil, query: String = "") async throws -> StreamResult {
        var request = try request("/v1/runs/\(id)/events\(query)")
        if let after { request.setValue(after, forHTTPHeaderField: "Last-Event-ID") }
        let (bytes, response) = try await session.bytes(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertTrue((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("text/event-stream") == true)
        var result = StreamResult()
        do { for try await byte in bytes { result.data.append(byte) } }
        catch { result.error = error }
        return result
    }
    private func types(_ result: StreamResult) -> [String] { result.payloads.compactMap { $0["type"] as? String } }

    func testSessionOmitsBearerOnQueryAndReturnsItOnlyAtSignIn() async throws {
        let current = try await json("/v1/auth/session")
        XCTAssertEqual(current["type"] as? String, "session")
        XCTAssertNil(current["bearerToken"])
        let signedIn = try await json("/v1/auth/sign-in", method: "POST", body: ["type": "auth.input", "email": "cloud@example.test", "password": "fixture-password"])
        XCTAssertEqual(signedIn["bearerToken"] as? String, CloudTestBackend.token)
    }
    func testSignOutRevokesSessionAndDevSignInRestoresIt() async throws {
        _ = try await json("/v1/auth/sign-out", method: "POST")
        _ = try await json("/v1/auth/session", status: 401)
        let denied = try await json("/v1/bootstrap", status: 401)
        XCTAssertEqual(denied["code"] as? String, "unauthorized")
        _ = try await json("/v1/auth/dev", method: "POST", body: ["type": "auth.dev"])
        _ = try await json("/v1/bootstrap")
    }
    func testBootstrapAndServerSideModelSearchAreDeterministic() async throws {
        let bootstrap = try await json("/v1/bootstrap")
        XCTAssertEqual(bootstrap["protocolVersion"] as? Int, 0)
        XCTAssertEqual(bootstrap["serverTime"] as? String, CloudTestBackend.timestamp)
        XCTAssertEqual((bootstrap["providers"] as? [[String: Any]])?.count, 1)
        let found = try await json("/v1/models?q=fixture")
        XCTAssertEqual((found["items"] as? [[String: Any]])?.count, 1)
        let missing = try await json("/v1/models?q=missing")
        XCTAssertEqual((missing["items"] as? [[String: Any]])?.count, 0)
        XCTAssertTrue(missing["nextCursor"] is NSNull)
    }
    func testUnknownEndpointFailsLocally() async throws {
        let result = try await json("/v1/not-a-fixture", status: 404)
        XCTAssertEqual(result["code"] as? String, "not_found")
        XCTAssertEqual(backend.recordedRequests().last?.path, "/v1/not-a-fixture")
    }
    func testIdempotentStartAndChangedBodyConflict() async throws {
        _ = try await start(key: "one-turn")
        let original = try XCTUnwrap(backend.recordedRequests().last { $0.path == "/v1/runs" })
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: original.body) as? [String: Any])
        let same = try await json("/v1/runs", method: "POST", body: body, status: 202)
        XCTAssertEqual(same["id"] as? String, "stub-run-1")
        var changed = body; changed["text"] = "Different"
        _ = try await json("/v1/runs", method: "POST", body: changed, status: 409)
    }
    func testTextStreamPreservesUTF8AndCommittedTranscript() async throws {
        let result = try await stream(start())
        XCTAssertNil(result.error)
        XCTAssertEqual(types(result).last, "run.finished")
        let text = result.payloads.filter { $0["type"] as? String == "text.delta" }.compactMap { $0["text"] as? String }.joined()
        XCTAssertEqual(text, "Cloud reply: Hello 🌍")
        XCTAssertEqual(types(result).filter { $0 == "messages.committed" }.count, 2)
        XCTAssertEqual(result.envelopes.compactMap { $0["id"] as? Int }, Array(1...result.envelopes.count))
    }
    func testToolScriptHasLifecycleAndTrace() async throws {
        let result = try await stream(start("tools"))
        for type in ["tool.started", "tool.running", "tool.progress", "tool.finished", "run.finished"] {
            XCTAssertTrue(types(result).contains(type), type)
        }
    }
    func testApprovalParksAndAllowResumesWithIdempotentDecision() async throws {
        let id = try await start("approval")
        let parked = try await json("/v1/runs/\(id)")
        XCTAssertEqual(parked["status"] as? String, "awaitingApproval")
        let decision: [String: Any] = ["type": "approval.decision", "approvalId": "stub-approval", "decision": "allowOnce"]
        _ = try await json("/v1/runs/\(id)/approvals", method: "POST", body: decision, status: 202)
        _ = try await json("/v1/runs/\(id)/approvals", method: "POST", body: decision, status: 202)
        let result = try await stream(id)
        XCTAssertEqual(types(result).filter { $0 == "approval.resolved" }.count, 1)
        XCTAssertTrue(String(decoding: result.data, as: UTF8.self).contains("Cloud tool approved."))
        var conflict = decision; conflict["decision"] = "deny"
        _ = try await json("/v1/runs/\(id)/approvals", method: "POST", body: conflict, status: 409)
    }
    func testNestedApprovalKeepsParentAndDenial() async throws {
        let id = try await start("nestedApproval")
        _ = try await json("/v1/runs/\(id)/approvals", method: "POST", body: ["type": "approval.decision", "approvalId": "stub-approval", "decision": "deny"], status: 202)
        let result = try await stream(id)
        let approval = try XCTUnwrap(result.payloads.first { $0["type"] as? String == "approval.requested" }?["approval"] as? [String: Any])
        XCTAssertEqual(approval["parentCallId"] as? String, "stub-parent")
        let completion = try XCTUnwrap(result.payloads.first { $0["type"] as? String == "tool.finished" }?["completion"] as? [String: Any])
        XCTAssertEqual(completion["status"] as? String, "denied")
    }
    func testElicitationResponseResumesParkedRun() async throws {
        let id = try await start("elicitation")
        _ = try await json("/v1/runs/\(id)/elicitations", method: "POST", body: ["type": "elicitation.response", "elicitationId": "stub-elicitation", "action": "accept", "content": ["name": "Test"]], status: 202)
        let result = try await stream(id)
        XCTAssertTrue(types(result).contains("elicitation.requested"))
        XCTAssertTrue(types(result).contains("elicitation.resolved"))
        XCTAssertEqual(types(result).last, "run.finished")
    }
    func testCompactionHasStartFinishAndSummary() async throws {
        let result = try await stream(start("compaction"))
        let events = result.payloads.filter { $0["type"] as? String == "compaction" }
        XCTAssertEqual(events.compactMap { $0["phase"] as? String }, ["started", "finished"])
        XCTAssertEqual(events.last?["summary"] as? String, "Earlier fixture turns")
    }
    func testVisionFallbackHasStableActivityID() async throws {
        let result = try await stream(start("vision"))
        let events = result.payloads.filter { $0["type"] as? String == "vision.activity" }
        XCTAssertEqual(events.compactMap { $0["phase"] as? String }, ["started", "finished"])
        XCTAssertEqual(Set(events.compactMap { $0["id"] as? String }), ["stub-vision"])
    }
    func testCancelTerminatesAnOpenStreamAndIsDurable() async throws {
        let id = try await start("cancel")
        let reader = Task { try await self.stream(id) }
        // Wait until URLProtocol has actually opened the stream, not a fixed
        // delay; cancellation then races with real outstanding callbacks.
        for _ in 0..<100 {
            if backend.recordedRequests().contains(where: { $0.path.hasSuffix("/events") }) { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        _ = try await json("/v1/runs/\(id)/cancel", method: "POST", body: ["type": "run.cancel"], status: 202)
        let result = try await reader.value
        XCTAssertNil(result.error)
        XCTAssertEqual(result.payloads.last?["outcome"] as? String, "cancelled")
        let descriptor = try await json("/v1/runs/\(id)")
        XCTAssertEqual(descriptor["status"] as? String, "cancelled")
    }
    func testDisconnectResumeUsesHeaderAndNeverReplaysAcceptedText() async throws {
        let id = try await start("reconnect")
        let first = try await stream(id)
        XCTAssertNotNil(first.error)
        XCTAssertEqual(first.envelopes.count, 4)
        let resumed = try await stream(id, after: "4", query: "?after=0")
        XCTAssertNil(resumed.error)
        XCTAssertEqual(resumed.envelopes.first?["id"] as? Int, 5)
        let text = (first.payloads + resumed.payloads).filter { $0["type"] as? String == "text.delta" }.compactMap { $0["text"] as? String }.joined()
        XCTAssertEqual(text, "Cloud reconnect: one 🌍 answer, no duplicate text.")
        XCTAssertEqual(backend.recordedRequests().last?.lastEventID, "4")
    }
    func testDetachingClientDoesNotCancelDurableRun() async throws {
        let id = try await start("cancel")
        let reader = Task { try await self.stream(id) }
        for _ in 0..<100 {
            if backend.recordedRequests().contains(where: { $0.path.hasSuffix("/events") }) { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        reader.cancel()
        _ = try? await reader.value
        let descriptor = try await json("/v1/runs/\(id)")
        XCTAssertEqual(descriptor["status"] as? String, "running")
        XCTAssertNil(descriptor["outcome"])
        XCTAssertFalse(backend.recordedRequests().contains { $0.path.hasSuffix("/cancel") })
        _ = try await json("/v1/runs/\(id)/cancel", method: "POST", body: ["type": "run.cancel"], status: 202)
    }
    func testSnapshotReturnsAppendOnlyCommittedMessages() async throws {
        let id = try await start("approval")
        _ = try await json("/v1/runs/\(id)/approvals", method: "POST", body: ["type": "approval.decision", "approvalId": "stub-approval", "decision": "deny"], status: 202)
        let descriptor = try await json("/v1/runs/\(id)")
        let chat = try XCTUnwrap(descriptor["chatId"] as? String)
        let snapshot = try await json("/v1/chats/\(chat)/messages")
        let messages = try XCTUnwrap(snapshot["items"] as? [[String: Any]])
        XCTAssertEqual(messages.compactMap { $0["role"] as? String }, ["user", "assistant"])
        XCTAssertEqual((messages.last?["parts"] as? [[String: Any]])?.first?["text"] as? String, "Cloud tool denied.")
    }
    func testInvalidResumeCursorReturnsConflict() async throws {
        let id = try await start()
        let result = try await json("/v1/runs/\(id)/events?after=9999", status: 409)
        XCTAssertEqual(result["code"] as? String, "cursor_expired")
    }
    func testIndependentSessionsNeverShareServerState() async throws {
        let other = CloudTestBackend(chunkDelay: 0.001)
        let otherSession = other.makeSession()
        defer { otherSession.invalidateAndCancel(); other.shutdown() }
        _ = try await start()
        let (data, _) = try await otherSession.data(for: request("/v1/bootstrap"))
        let bootstrap = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual((bootstrap["chats"] as? [[String: Any]])?.count, 0)
        XCTAssertEqual(other.recordedRequests().count, 1)
    }
}
