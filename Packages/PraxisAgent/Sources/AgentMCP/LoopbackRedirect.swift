import Foundation
import Network

/// One-shot `http://127.0.0.1:<port>/callback` listener for OAuth servers
/// that only accept loopback redirects for native apps (RFC 8252 §7.3).
/// Lives only while the sign-in sheet is open, binds to the loopback
/// interface only, and answers the first callback request.
///
/// NEEDS DEVICE SPIKE: works on macOS (tested); on iOS the listener must
/// stay reachable while ASWebAuthenticationSession is in front, and the
/// app must cancel the session once the callback arrives. Unverified.
public actor LoopbackRedirect: OAuthLoopbackServer {
    public let path: String
    private var listener: NWListener?
    private var redirect: URL?
    private var received: URL?
    private var waiters: [CheckedContinuation<URL, Error>] = []
    private var failure: Error?
    private let queue = DispatchQueue(label: "PraxisAgent.MCP.loopback")

    public init(path: String = "/callback") { self.path = path }

    public struct ListenerError: Error, LocalizedError, Sendable {
        public var message: String
        public var errorDescription: String? { message }
    }

    public func start(preferredPort: UInt16?) async throws -> URL {
        if let redirect { return redirect }
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        let port = preferredPort.flatMap { NWEndpoint.Port(rawValue: $0) } ?? .any
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
        let listener = try NWListener(using: parameters)
        self.listener = listener

        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { connection.cancel(); return }
            Task { await self.accept(connection) }
        }
        let boundPort: UInt16 = try await withCheckedThrowingContinuation { continuation in
            let once = OnceFlag()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if once.claim() { continuation.resume(returning: listener.port?.rawValue ?? 0) }
                case .failed(let error):
                    if once.claim() { continuation.resume(throwing: error) }
                case .cancelled:
                    if once.claim() { continuation.resume(throwing: CancellationError()) }
                default:
                    break
                }
            }
            listener.start(queue: queue)
        }
        guard boundPort != 0, let url = URL(string: "http://127.0.0.1:\(boundPort)\(path)") else {
            stop()
            throw ListenerError(message: "Couldn't open a loopback port for sign-in.")
        }
        redirect = url
        return url
    }

    public func waitForCallback() async throws -> URL {
        if let received { return received }
        if let failure { throw failure }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { waiters.append($0) }
        } onCancel: {
            Task { await self.fail(CancellationError()) }
        }
    }

    public func stop() {
        listener?.cancel()
        listener = nil
        fail(CancellationError())
    }

    private func fail(_ error: Error) {
        guard received == nil else { return }
        failure = error
        let pending = waiters
        waiters.removeAll()
        for w in pending { w.resume(throwing: error) }
    }

    private func deliver(_ url: URL) {
        guard received == nil else { return }
        received = url
        let pending = waiters
        waiters.removeAll()
        for w in pending { w.resume(returning: url) }
        listener?.cancel()
        listener = nil
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(on: connection, buffer: Data())
    }

    private nonisolated func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, complete, error in
            var buffer = buffer
            if let data { buffer.append(data) }
            let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8))
            if headerEnd == nil, error == nil, !complete, buffer.count < 16_384 {
                self?.receive(on: connection, buffer: buffer)
                return
            }
            guard let self else { connection.cancel(); return }
            Task { await self.respond(to: buffer, on: connection) }
        }
    }

    private func respond(to request: Data, on connection: NWConnection) {
        // "GET /callback?code=…&state=… HTTP/1.1"
        let line = String(decoding: request.prefix { $0 != 0x0D && $0 != 0x0A }, as: UTF8.self)
        let parts = line.split(separator: " ")
        let target = parts.count >= 2 ? String(parts[1]) : ""
        let matches = parts.first == "GET" && (target == path || target.hasPrefix(path + "?"))
        let body = matches
            ? "<!doctype html><meta name=viewport content='width=device-width'><title>Signed in</title><p style='font:17px -apple-system;text-align:center;margin-top:30vh'>You're signed in. You can return to Praxis Chat.</p>"
            : "Not found"
        let response = "HTTP/1.1 \(matches ? "200 OK" : "404 Not Found")\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n\(body)"
        connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in connection.cancel() })
        if matches, let base = redirect, let url = URL(string: "http://127.0.0.1:\(base.port ?? 80)\(target)") {
            deliver(url)
        }
    }
}

/// Resume-once guard for callback-based APIs.
private final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.lock(); defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
