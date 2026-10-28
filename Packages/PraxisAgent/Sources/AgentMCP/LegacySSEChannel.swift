import Foundation
import AgentCore

/// The deprecated 2024-11-05 HTTP+SSE transport: one long-lived GET event
/// stream carries every server message; the client POSTs its messages to
/// the URL announced by the first `endpoint` event. Responses are matched
/// to waiting requests by id.
actor LegacySSEChannel {
    /// `interactive: false` = a 401 here never opens the sign-in sheet
    /// (agent-run calls, replies, cleanup).
    typealias Poster = @Sendable (_ url: URL, _ message: JSONValue, _ interactive: Bool) async throws -> Void
    typealias ServerRequest = @Sendable (_ id: JSONValue, _ method: String, _ params: JSONValue) async -> JSONValue
    typealias Notification = @Sendable (_ method: String, _ params: JSONValue) async -> Void

    private let streamURL: URL
    private let post: Poster
    private let serverRequest: ServerRequest
    private let notification: Notification

    private var endpoint: URL?
    private var endpointWaiter: CheckedContinuation<URL, Error>?
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private var progress: [Int: @Sendable (MCPProgress) -> Void] = [:]
    private var reader: Task<Void, Never>?
    private(set) var isClosed = false

    init(streamURL: URL, post: @escaping Poster, serverRequest: @escaping ServerRequest, notification: @escaping Notification) {
        self.streamURL = streamURL
        self.post = post
        self.serverRequest = serverRequest
        self.notification = notification
    }

    /// Starts reading `response` (the GET stream) and waits for the
    /// `endpoint` event. The endpoint must share the stream's origin so a
    /// hostile server can't redirect our credentials elsewhere.
    func open(_ response: HTTPStreamResponse, timeout: Duration) async throws -> URL {
        reader = Task { [weak self] in
            var parser = SSEParser()
            do {
                for try await chunk in response.body {
                    for event in parser.feed(chunk) { await self?.receive(event) }
                }
                for event in parser.finish() { await self?.receive(event) }
                await self?.shutdown(MCPError.protocolViolation("the event stream closed"))
            } catch {
                await self?.shutdown(error)
            }
        }
        return try await withThrowingTaskGroup(of: URL.self) { group in
            group.addTask { try await self.waitForEndpoint() }
            group.addTask {
                try await Task.sleep(for: timeout)
                throw MCPError.protocolViolation("no endpoint event from the event stream")
            }
            defer { group.cancelAll() }
            guard let url = try await group.next() else { throw CancellationError() }
            return url
        }
    }

    private func waitForEndpoint() async throws -> URL {
        if let endpoint { return endpoint }
        if isClosed { throw SessionLost() }
        // Without this handler, cancelling the waiter (timeout loss, task
        // cancel) never resumes it, and `open`'s group scope — which waits
        // for every child — hangs until the server speaks or goes away.
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { endpointWaiter = $0 }
        } onCancel: {
            Task { await self.cancelEndpointWait() }
        }
    }

    private func cancelEndpointWait() {
        guard let waiter = endpointWaiter else { return }
        endpointWaiter = nil
        waiter.resume(throwing: CancellationError())
    }

    /// Sends a request and waits for its response on the event stream.
    /// Cancelling sends `notifications/cancelled`.
    func request(id: Int, message: JSONValue, progress handler: (@Sendable (MCPProgress) -> Void)?,
                 interactive: Bool) async throws -> JSONValue {
        guard !isClosed, let endpoint else { throw SessionLost() }
        if let handler { progress[id] = handler }
        defer { progress[id] = nil }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending[id] = continuation
                Task { await self.send(message, to: endpoint, failing: id, interactive: interactive) }
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    func notify(_ message: JSONValue, interactive: Bool) async throws {
        guard !isClosed, let endpoint else { throw SessionLost() }
        try await post(endpoint, message, interactive)
    }

    func close() {
        shutdown(SessionLost())
    }

    // MARK: Internals

    private func send(_ message: JSONValue, to endpoint: URL, failing id: Int, interactive: Bool) async {
        do {
            try await post(endpoint, message, interactive)
        } catch {
            pending.removeValue(forKey: id)?.resume(throwing: error)
        }
    }

    private func cancel(_ id: Int) async {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(throwing: CancellationError())
        guard let endpoint, !isClosed else { return }
        // Cleanup: a 401 on the way out must never prompt.
        try? await post(endpoint, RPC.notification("notifications/cancelled",
                                                   params: ["requestId": .number(Double(id)), "reason": "Cancelled by the client"]), false)
    }

    private func receive(_ event: SSEEvent) async {
        if event.event == "endpoint" {
            let raw = event.data.trimmingCharacters(in: .whitespacesAndNewlines)
            guard endpoint == nil, let url = URL(string: raw, relativeTo: streamURL)?.absoluteURL else { return }
            guard MCPEraCache.origin(of: url) == MCPEraCache.origin(of: streamURL) else {
                shutdown(MCPError.protocolViolation("the endpoint event points to another origin"))
                return
            }
            endpoint = url
            endpointWaiter?.resume(returning: url)
            endpointWaiter = nil
            return
        }
        guard event.event == nil || event.event == "message",
              let value = try? JSONValue(parsing: event.data) else { return }
        for message in RPCMessage.parse(value) {
            switch message {
            case .response(let id, let result):
                if let key = id.intValue ?? id.stringValue.flatMap(Int.init) { pending.removeValue(forKey: key)?.resume(returning: result) }
            case .failure(let id, let error):
                if let key = id?.intValue ?? id?.stringValue.flatMap(Int.init) { pending.removeValue(forKey: key)?.resume(throwing: error) }
            case .notification(let method, let params):
                if method == "notifications/progress", let token = params["progressToken"],
                   let key = token.intValue ?? token.stringValue.flatMap(Int.init), let handler = progress[key] {
                    handler(MCPProgress(progress: params["progress"]?.doubleValue ?? 0, total: params["total"]?.doubleValue,
                                        message: params["message"]?.stringValue))
                } else {
                    await notification(method, params)
                }
            case .request(let id, let method, let params):
                // Answer off the read loop so a slow elicitation doesn't
                // stall delivery of other messages.
                let reply = serverRequest
                let poster = post
                if let endpoint {
                    Task {
                        let response = await reply(id, method, params)
                        // An answer to the server, possibly mid-run: never prompt on a 401.
                        try? await poster(endpoint, response, false)
                    }
                }
            }
        }
    }

    private func shutdown(_ error: Error) {
        guard !isClosed else { return }
        isClosed = true
        reader?.cancel()
        reader = nil
        endpointWaiter?.resume(throwing: error)
        endpointWaiter = nil
        let waiting = pending
        pending.removeAll()
        // In-flight requests may have run: fail them rather than replay
        // (a replayed destructive call could run twice). Later requests
        // see `isClosed` and reconnect.
        for (_, continuation) in waiting {
            continuation.resume(throwing: MCPError.protocolViolation("the connection to the server was lost"))
        }
    }
}
