import Foundation
import Synchronization

/// Status + headers of an HTTP response, as a Sendable value.
public struct HTTPResponseHead: Sendable, Equatable {
    public var status: Int
    /// Header names lowercased.
    public var headers: [String: String]
    /// Final URL after redirects, when known.
    public var url: URL?

    public init(status: Int, headers: [String: String] = [:], url: URL? = nil) {
        self.status = status
        self.headers = Dictionary(headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { _, b in b })
        self.url = url
    }

    public init(_ response: HTTPURLResponse) {
        var h: [String: String] = [:]
        for (k, v) in response.allHeaderFields {
            if let k = k as? String, let v = v as? String { h[k.lowercased()] = v }
        }
        self.init(status: response.statusCode, headers: h, url: response.url)
    }

    public func header(_ name: String) -> String? { headers[name.lowercased()] }
    public var isSuccess: Bool { (200..<300).contains(status) }

    /// `retry-after` (seconds or HTTP date) as a duration. Capped at 60s
    /// (every consumer clamps to 30–60s anyway) and nil for malformed
    /// values — a bare `Int(huge)` here would trap and crash the app.
    public var retryAfter: Duration? {
        if let ms = header("retry-after-ms"), let v = Double(ms) {
            guard v.isFinite, v >= 0 else { return nil }
            return .milliseconds(Int(min(v, 60_000)))
        }
        guard let raw = header("retry-after") else { return nil }
        if let secs = Double(raw) {
            guard secs.isFinite, secs >= 0 else { return nil }
            return .milliseconds(Int(min(secs, 60) * 1000))
        }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        if let date = f.date(from: raw) {
            return .milliseconds(Int(min(max(0, date.timeIntervalSinceNow), 60) * 1000))
        }
        return nil
    }
}

public struct HTTPStreamResponse: Sendable {
    public var head: HTTPResponseHead
    /// Body bytes in arbitrary chunks.
    public var body: AsyncThrowingStream<Data, Error>
    public init(head: HTTPResponseHead, body: AsyncThrowingStream<Data, Error>) {
        self.head = head
        self.body = body
    }

    /// Drains the body (for error responses / JSON replies).
    public func collect(limit: Int = 8 << 20) async throws -> Data {
        var data = Data()
        for try await chunk in body {
            data.append(chunk)
            if data.count > limit { break }
        }
        return data
    }
}

/// HTTP seam for every network call in the agent (LLM providers, MCP, JS
/// `fetch`). Tests swap in `ScriptedTransport`.
public protocol HTTPTransport: Sendable {
    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse
}

public extension HTTPTransport {
    func data(_ request: URLRequest, limit: Int = 8 << 20) async throws -> (Data, HTTPResponseHead) {
        let r = try await stream(request)
        return (try await r.collect(limit: limit), r.head)
    }
}

/// URLSession-backed transport. Streams bytes as they arrive; cancelling
/// the consuming task cancels the request.
public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession
    private let allowRedirect: (@Sendable (URL) -> Bool)?

    /// `allowRedirect` vets every redirect target; a rejected redirect
    /// fails the request instead of being followed.
    public init(session: URLSession = URLSessionTransport.defaultSession,
                allowRedirect: (@Sendable (URL) -> Bool)? = nil) {
        self.session = session
        self.allowRedirect = allowRedirect
    }

    /// Long request timeout: reasoning and server tools can pause a stream
    /// for minutes.
    public static let defaultSession: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 300
        c.timeoutIntervalForResource = 3600
        c.waitsForConnectivity = true
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        return URLSession(configuration: c)
    }()

    public func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        let bytes: URLSession.AsyncBytes
        let response: URLResponse
        let guardian = allowRedirect.map(RedirectGuard.init)
        do {
            (bytes, response) = try await session.bytes(for: request, delegate: guardian)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw ProviderError.network(error.localizedDescription)
        }
        if let blocked = guardian?.blocked {
            bytes.task.cancel()
            throw ProviderError.network("Redirect to \(blocked.host() ?? blocked.absoluteString) was blocked.")
        }
        guard let http = response as? HTTPURLResponse else {
            throw ProviderError.network("Not an HTTP response")
        }
        let body = AsyncThrowingStream<Data, Error> { continuation in
            let task = Task {
                var chunk = Data()
                chunk.reserveCapacity(4096)
                do {
                    for try await byte in bytes {
                        chunk.append(byte)
                        // Hand over at line ends so SSE events surface promptly.
                        if byte == 0x0A || chunk.count >= 16_384 {
                            continuation.yield(chunk)
                            chunk.removeAll(keepingCapacity: true)
                        }
                    }
                    if !chunk.isEmpty { continuation.yield(chunk) }
                    continuation.finish()
                } catch let error as URLError where error.code == .cancelled {
                    continuation.finish(throwing: CancellationError())
                } catch is CancellationError {
                    continuation.finish(throwing: CancellationError())
                } catch {
                    continuation.finish(throwing: ProviderError.network(error.localizedDescription))
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
                // Otherwise the request runs to completion on the wire (and
                // the producer above stays suspended in `for try await byte`).
                bytes.task.cancel()
            }
        }
        return HTTPStreamResponse(head: HTTPResponseHead(http), body: body)
    }
}

/// Per-task delegate that refuses redirects the transport's check rejects
/// (URLSession then returns the 3xx itself, which `stream` turns into an error).
private final class RedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    private let allow: @Sendable (URL) -> Bool
    private let rejected = Mutex<URL?>(nil)

    init(_ allow: @escaping @Sendable (URL) -> Bool) { self.allow = allow }

    var blocked: URL? { rejected.withLock { $0 } }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        guard let url = request.url else { return nil }
        if allow(url) { return request }
        rejected.withLock { $0 = url }
        return nil
    }
}
