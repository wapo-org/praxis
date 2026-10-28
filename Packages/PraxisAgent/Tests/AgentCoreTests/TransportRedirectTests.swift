import Foundation
import Network
import Synchronization
import Testing
@testable import AgentCore

@Suite struct TransportRedirectTests {
    @Test func followsAllowedRedirectAndReportsFinalURL() async throws {
        let server = try await RedirectServer.start()
        defer { server.stop() }
        let transport = URLSessionTransport(session: .shared, allowRedirect: { _ in true })
        let (data, head) = try await transport.data(URLRequest(url: server.url("/start")))
        #expect(head.status == 200)
        #expect(String(decoding: data, as: UTF8.self) == "landed")
        #expect(head.url?.path() == "/end")
    }

    @Test func rejectedRedirectFailsTheRequest() async throws {
        let server = try await RedirectServer.start()
        defer { server.stop() }
        let transport = URLSessionTransport(session: .shared, allowRedirect: { $0.path() != "/end" })
        await #expect(throws: ProviderError.self) {
            _ = try await transport.data(URLRequest(url: server.url("/start")))
        }
    }
}

/// Loopback HTTP server: `/start` → 302 to `/end`, `/end` → "landed".
private final class RedirectServer: Sendable {
    private let listener: NWListener
    let port: UInt16

    private init(listener: NWListener, port: UInt16) {
        self.listener = listener
        self.port = port
    }

    func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)\(path)")! }
    func stop() { listener.cancel() }

    static func start() async throws -> RedirectServer {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: params)
        let queue = DispatchQueue(label: "redirect-server")
        listener.newConnectionHandler = { connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, _, _ in
                let request = data.map { String(decoding: $0, as: UTF8.self) } ?? ""
                let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
                let response = path == "/start"
                    ? "HTTP/1.1 302 Found\r\nLocation: /end\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    : "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nConnection: close\r\n\r\nlanded"
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            let resumed = ResumeOnce()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if resumed.claim() { continuation.resume(returning: listener.port?.rawValue ?? 0) }
                case .failed(let error):
                    if resumed.claim() { continuation.resume(throwing: error) }
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
        return RedirectServer(listener: listener, port: port)
    }
}

private final class ResumeOnce: Sendable {
    private let done = Mutex(false)
    func claim() -> Bool { done.withLock { d in defer { d = true }; return !d } }
}
