import Foundation
import Network
import Synchronization
import Testing
@testable import AgentCore

/// Regression tests for Team C hardening fixes (R1-H1, R1-L4).
@Suite struct CHardeningJSONTests {
    @Test func hugeNumbersAreNotInts() throws {
        for text in [#"{"v": 1e300}"#, #"{"v": -1e300}"#, #"{"v": 1e30}"#] {
            let v = try JSONValue(parsing: text)["v"]
            #expect(v?.intValue == nil)
        }
        // Ordinary values still convert; fractions still don't.
        #expect(try JSONValue(parsing: #"{"v": 42}"#)["v"]?.intValue == 42)
        #expect(try JSONValue(parsing: #"{"v": -7}"#)["v"]?.intValue == -7)
        #expect(try JSONValue(parsing: #"{"v": 2.5}"#)["v"]?.intValue == nil)
        #expect(try JSONValue(parsing: #"{"v": 9007199254740991}"#)["v"]?.intValue == 9007199254740991)
    }
}

@Suite struct CHardeningRetryAfterTests {
    @Test func hugeAndMalformedValuesNeitherTrapNorWaitForever() {
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after": "1e300"]).retryAfter == .seconds(60))
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after-ms": "1e300"]).retryAfter == .seconds(60))
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after": "-1e300"]).retryAfter == nil)
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after": "-5"]).retryAfter == nil)
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after": "nan"]).retryAfter == nil)
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after": "inf"]).retryAfter == nil)
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after": "tomorrow"]).retryAfter == nil)
        // Ordinary values unchanged, large ones capped like every consumer does.
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after": "2"]).retryAfter == .seconds(2))
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after": "120"]).retryAfter == .seconds(60))
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after-ms": "1500"]).retryAfter == .milliseconds(1500))
    }
}

@Suite struct CHardeningScratchEvictTests {
    final class Folder {
        let url = FileManager.default.temporaryDirectory.appending(path: "scratch-\(UUID().uuidString)", directoryHint: .isDirectory)
        deinit { try? FileManager.default.removeItem(at: url) }
    }

    @Test func failedDeleteKeepsItsAccounting() throws {
        let folder = Folder()
        let store = ScratchStore(root: folder.url, maxTotalBytes: 1_500, maxFileBytes: 1_000)
        let kb = Data(count: 1_000)
        try store.write(kb, conversationID: "c1", name: "stuck")
        let dir = folder.url.appending(path: "c1", directoryHint: .isDirectory)
        // Read-only directory: the eviction delete fails.
        try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: dir.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: dir.path) }
        try store.write(kb, conversationID: "c2", name: "new")
        #expect(store.totalBytes == 2_000) // not silently decremented
        #expect(FileManager.default.fileExists(atPath: dir.appending(path: "stuck").path))
    }
}

@Suite struct CHardeningTransportCancelTests {
    @Test func droppingTheConsumerCancelsTheRequestOnTheWire() async throws {
        let server = try await SlowServer.start()
        defer { server.stop() }
        let transport = URLSessionTransport(session: .shared)
        var response: HTTPStreamResponse? = try await transport.stream(URLRequest(url: server.url("/slow")))
        var gotByte = false
        if let body = response?.body {
            for try await chunk in body {
                if !chunk.isEmpty { gotByte = true; break }
            }
        }
        #expect(gotByte)
        response = nil
        let deadline = Date().addingTimeInterval(10)
        while !server.sawClose, Date() < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(server.sawClose)
    }
}

/// Loopback HTTP server: `/slow` sends one line of an unbounded body, then
/// holds the connection open until the client goes away.
private final class SlowServer: Sendable {
    final class Flag: Sendable {
        private let box = Mutex(false)
        var value: Bool { box.withLock { $0 } }
        func set() { box.withLock { $0 = true } }
    }

    private let listener: NWListener
    private let closed: Flag
    let port: UInt16

    var sawClose: Bool { closed.value }

    private init(listener: NWListener, port: UInt16, closed: Flag) {
        self.listener = listener
        self.port = port
        self.closed = closed
    }

    func url(_ path: String) -> URL { URL(string: "http://127.0.0.1:\(port)\(path)")! }
    func stop() { listener.cancel() }

    static func start() async throws -> SlowServer {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: params)
        let closed = Flag()
        let queue = DispatchQueue(label: "slow-server")
        listener.newConnectionHandler = { connection in
            connection.stateUpdateHandler = { state in
                switch state {
                case .cancelled, .failed: closed.set()
                default: break
                }
            }
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { _, _, isComplete, _ in
                if isComplete { closed.set(); return }
                let head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 1000000\r\nConnection: close\r\n\r\nx\n"
                connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in
                    // The client going away completes this receive.
                    connection.receive(minimumIncompleteLength: 1, maximumLength: 1) { _, _, isComplete, error in
                        if isComplete || error != nil { closed.set() }
                    }
                })
            }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            let resumed = Mutex(false)
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    let first = resumed.withLock { r in if r { return false }; r = true; return true }
                    if first { continuation.resume(returning: listener.port?.rawValue ?? 0) }
                case .failed(let error):
                    let first = resumed.withLock { r in if r { return false }; r = true; return true }
                    if first { continuation.resume(throwing: error) }
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
        return SlowServer(listener: listener, port: port, closed: closed)
    }
}
