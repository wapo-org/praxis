import Foundation
import AgentCore
import Synchronization

/// An `HTTPTransport` that answers from a handler, delivering bodies in
/// configurable chunk sizes (to exercise split SSE frames).
public final class ScriptedTransport: HTTPTransport, Sendable {
    public struct Reply: Sendable {
        public var status: Int
        public var headers: [String: String]
        public var body: Data
        public var chunkSize: Int
        public init(status: Int = 200, headers: [String: String] = [:], body: Data, chunkSize: Int = 64) {
            self.status = status
            self.headers = headers
            self.body = body
            self.chunkSize = chunkSize
        }
        public static func json(_ text: String, status: Int = 200, headers: [String: String] = [:]) -> Reply {
            Reply(status: status, headers: ["content-type": "application/json"].merging(headers) { _, b in b }, body: Data(text.utf8))
        }
        public static func sse(_ text: String, chunkSize: Int = 7, headers: [String: String] = [:]) -> Reply {
            Reply(status: 200, headers: ["content-type": "text/event-stream"].merging(headers) { _, b in b },
                  body: Data(text.utf8), chunkSize: chunkSize)
        }
    }

    public struct RecordedRequest: Sendable {
        public var url: URL?
        public var method: String
        public var headers: [String: String]
        public var body: Data?
        public var json: JSONValue? { body.flatMap { try? JSONValue(parsing: $0) } }

        public init(url: URL?, method: String, headers: [String: String], body: Data?) {
            self.url = url
            self.method = method
            self.headers = headers
            self.body = body
        }

        public init(_ request: URLRequest) {
            self.init(url: request.url, method: request.httpMethod ?? "GET",
                      headers: request.allHTTPHeaderFields ?? [:], body: request.httpBody)
        }
    }

    private let handler: @Sendable (URLRequest, Int) throws -> Reply
    private let recorded = Mutex<[RecordedRequest]>([])

    /// `handler` gets the request and its 0-based sequence number.
    public init(handler: @escaping @Sendable (URLRequest, Int) throws -> Reply) {
        self.handler = handler
    }

    /// Replies in order, one per request.
    public convenience init(replies: [Reply]) {
        self.init { _, n in
            guard n < replies.count else { throw ProviderError.network("ScriptedTransport ran out of replies") }
            return replies[n]
        }
    }

    public var requests: [RecordedRequest] { recorded.withLock { $0 } }

    public func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        let n = recorded.withLock { r -> Int in
            r.append(RecordedRequest(request))
            return r.count - 1
        }
        let reply = try handler(request, n)
        let body = AsyncThrowingStream<Data, Error> { continuation in
            var offset = 0
            let size = max(1, reply.chunkSize)
            while offset < reply.body.count {
                let end = min(offset + size, reply.body.count)
                continuation.yield(reply.body.subdata(in: offset..<end))
                offset = end
            }
            continuation.finish()
        }
        return HTTPStreamResponse(head: HTTPResponseHead(status: reply.status, headers: reply.headers), body: body)
    }
}
