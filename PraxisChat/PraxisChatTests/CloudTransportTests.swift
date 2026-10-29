import XCTest
import Synchronization
import AgentCore
@testable import PraxisChat

struct CloudNetReply: Sendable {
    var status = 200
    var contentType = "application/json"
    var chunks: [Data]
    var close = true
    init(_ json: String, status: Int = 200) { chunks = [Data(json.utf8)]; self.status = status }
    init(sse: [String], close: Bool = true) { contentType = "text/event-stream; charset=utf-8"; chunks = sse.map { Data($0.utf8) }; self.close = close }
}

final class CloudNetURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> CloudNetReply
    static let handlers = Mutex<[String: Handler]>([:])
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let handler = Self.handlers.withLock { $0[request.value(forHTTPHeaderField: "X-Cloud-Test") ?? ""] }
        do {
            let result = try XCTUnwrap(handler)(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: result.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": result.contentType])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            for chunk in result.chunks { client?.urlProtocol(self, didLoad: chunk) }
            if result.close { client?.urlProtocolDidFinishLoading(self) }
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

func cloudNetClient(_ handler: @escaping CloudNetURLProtocol.Handler) throws -> CloudAPIClient {
    let key = UUID().uuidString
    CloudNetURLProtocol.handlers.withLock { $0[key] = handler }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [CloudNetURLProtocol.self]
    config.httpAdditionalHeaders = ["X-Cloud-Test": key]
    return CloudAPIClient(configuration: try CloudServerConfiguration(baseURL: URL(string: "https://cloud.test")!),
                          session: URLSession(configuration: config), tokens: CloudSessionStore(inMemory: true))
}
func cloudNetFrame(_ id: Int, _ payload: String, run: String = "run", chat: String = "chat") -> String {
    "id: \(id)\nevent: run.event\ndata: {\"type\":\"run.event\",\"id\":\(id),\"runId\":\"\(run)\",\"chatId\":\"\(chat)\",\"createdAt\":\"2026-10-29T00:00:00.000Z\",\"event\":\(payload)}\n\n"
}

@MainActor
final class CloudTransportTests: XCTestCase {
    func testParserSplitUTF8CRLFMultilineCommentsIDRetry() throws {
        let input = Data(": comment\r\nid: 42\r\nretry: 120\r\nevent: run.event\r\ndata: café 🦊\r\ndata: next\r\n\r\n".utf8)
        var parser = CloudSSEParser()
        var frames: [CloudSSEFrame] = []
        for byte in input { if let frame = try parser.feed(byte) { frames.append(frame) } }
        XCTAssertEqual(frames, [CloudSSEFrame(event: "run.event", data: "café 🦊\nnext", id: "42", retryMilliseconds: 120)])
    }
    func testParserBOMLoneCRAndInvalidRetry() throws {
        var parser = CloudSSEParser()
        let frames = try parser.feed(Data("\u{FEFF}id: 1\rretry: -2\rdata: x\r\rdata: y\r\r".utf8))
        XCTAssertEqual(frames.map(\.data), ["x", "y"])
        XCTAssertEqual(frames.map(\.id), ["1", "1"])
        XCTAssertNil(frames[0].retryMilliseconds)
    }
    func testParserRejectsMalformedUTF8AndOversizedEvent() throws {
        var parser = CloudSSEParser()
        XCTAssertThrowsError(try parser.feed(Data([0xff, 10])))
        parser = CloudSSEParser(); parser.maxEventBytes = 3
        XCTAssertThrowsError(try parser.feed(Data("data: big".utf8)))
    }
    func testIncompleteEventIsNeverDispatched() throws {
        var parser = CloudSSEParser()
        XCTAssertTrue(try parser.feed(Data("id: 2\ndata: partial".utf8)).isEmpty)
    }
    func testJSONStatusValidationAndBearerInjection() async throws {
        let client = try cloudNetClient { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer session-only")
            XCTAssertEqual(request.httpMethod, "PATCH")
            return CloudNetReply(#"{"id":"ok"}"#)
        }
        try await client.tokens.setToken("session-only", for: client.configuration.origin)
        let value: CloudChatIdentity = try await client.send("/v1/item", method: "PATCH", body: Data("{}".utf8))
        XCTAssertEqual(value.id, "ok")
    }
    func testStructuredHTTPErrorExposesStatusAndCode() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(#"{"type":"error","code":"rate_limited","message":"Try later"}"#, status: 429) }
        do { let _: CloudChatIdentity = try await client.send("/v1/item"); XCTFail("expected error") }
        catch let error as CloudAPIError { XCTAssertEqual(error.statusCode, 429); XCTAssertEqual(error.code, "rate_limited") }
    }
    func testRejectsNonJSONSuccess() async throws {
        let client = try cloudNetClient { _ in var r = CloudNetReply("<html/>"); r.contentType = "text/html"; return r }
        do { let _: CloudChatIdentity = try await client.send("/v1/item"); XCTFail("expected error") }
        catch CloudAPIError.invalidContentType {}
    }
    func testMultipartUsesSameSession() async throws {
        let client = try cloudNetClient { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "multipart/form-data; boundary=test")
            return CloudNetReply(#"{"id":"audio"}"#)
        }
        let value: CloudChatIdentity = try await client.send("/v1/transcribe", method: "POST", body: Data("audio".utf8), contentType: "multipart/form-data; boundary=test")
        XCTAssertEqual(value.id, "audio")
    }
    func testInvalidAndCrossOriginPathsRejectedBeforeNetwork() async throws {
        let client = try cloudNetClient { _ in XCTFail("must not send"); return CloudNetReply("{}") }
        for path in ["https://evil.test/v1", "//evil.test/v1", "relative"] {
            do { try await client.sendVoid(path); XCTFail("accepted \(path)") } catch CloudAPIError.invalidPath {}
        }
    }
    func testSSEReconnectSendsAcceptedCursorAndDeduplicates() async throws {
        let count = Mutex(0)
        let client = try cloudNetClient { request in
            let attempt = count.withLock { $0 += 1; return $0 }
            if attempt == 1 {
                XCTAssertNil(request.value(forHTTPHeaderField: "Last-Event-ID"))
                return CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"text.delta","blockId":"b","text":"Hello"}"#)])
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Last-Event-ID"), "1")
            return CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"text.delta","blockId":"b","text":"Hello"}"#), cloudNetFrame(2, #"{"type":"run.finished","outcome":"completed"}"#)])
        }
        let ids = Mutex<[Int]>([])
        try await CloudSSEClient(client: client, initialBackoff: .milliseconds(1)).consume(runID: "run", chatID: "chat", onCursor: { id in ids.withLock { $0.append(id) } }) { _ in }
        XCTAssertEqual(ids.withLock { $0 }, [1, 2])
        XCTAssertEqual(count.withLock { $0 }, 2)
    }
    func testUnknownFutureEventAdvancesCursor() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"future.event","activity":123}"#), cloudNetFrame(2, #"{"type":"run.finished","outcome":"completed"}"#)]) }
        let ids = Mutex<[Int]>([])
        try await CloudSSEClient(client: client).consume(runID: "run", chatID: "chat", onCursor: { id in ids.withLock { $0.append(id) } }) { _ in }
        XCTAssertEqual(ids.withLock { $0 }, [1, 2])
    }
    func testRejectedEventDoesNotAcknowledgeCursor() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"run.started"}"#)]) }
        let ids = Mutex<[Int]>([])
        do {
            try await CloudSSEClient(client: client).consume(runID: "run", chatID: "chat", onCursor: { id in ids.withLock { $0.append(id) } }) { _ in throw CloudAPIError.invalidResponse }
            XCTFail("expected rejection")
        } catch CloudAPIError.invalidResponse {}
        XCTAssertTrue(ids.withLock { $0.isEmpty })
    }
    func testMismatchedRunRejectedWithoutCursorAdvance() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(sse: [cloudNetFrame(1, #"{"type":"run.started"}"#, run: "wrong")]) }
        do { try await CloudSSEClient(client: client).consume(runID: "run", chatID: "chat") { _ in }; XCTFail("expected mismatch") }
        catch CloudAPIError.malformedEvent {}
    }
    func testExpiredCursorSurfacedForSnapshotRecovery() async throws {
        let client = try cloudNetClient { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Last-Event-ID"), "99")
            return CloudNetReply(#"{"type":"error","code":"cursor_expired","message":"Snapshot needed"}"#, status: 409)
        }
        do { try await CloudSSEClient(client: client).consume(runID: "run", chatID: "chat", after: 99) { _ in }; XCTFail("expected recovery") }
        catch let error as CloudAPIError { XCTAssertEqual(error.code, "cursor_expired") }
    }
    func testCancellationOfHangingSSECompletes() async throws {
        let began = expectation(description: "started")
        let client = try cloudNetClient { _ in began.fulfill(); return CloudNetReply(sse: [": keepalive\n\n"], close: false) }
        let task = Task { try await CloudSSEClient(client: client).consume(runID: "run", chatID: "chat") { _ in } }
        await fulfillment(of: [began], timeout: 3)
        task.cancel()
        do { try await task.value; XCTFail("expected cancellation") } catch is CancellationError {}
    }
    func testRetryLimitForEmptyDisconnectedStream() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(sse: []) }
        do { try await CloudSSEClient(client: client, initialBackoff: .milliseconds(1), maxReconnects: 1).consume(runID: "run", chatID: "chat") { _ in }; XCTFail("expected limit") }
        catch CloudAPIError.reconnectLimit {}
    }
}
