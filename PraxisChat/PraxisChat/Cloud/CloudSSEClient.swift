import Foundation

struct CloudSSEFrame: Sendable, Equatable {
    var event: String
    var data: String
    var id: String?
    var retryMilliseconds: Int?
}

/// Accumulates bytes until a complete line, so a split UTF-8 scalar is never
/// decoded independently. CR, LF and CRLF are valid event-stream separators.
struct CloudSSEParser: Sendable {
    private var line: [UInt8] = []
    private var data: [String] = []
    private var event = ""
    private var lastID: String?
    private var retry: Int?
    private var skipLF = false
    private var firstLine = true
    private var eventBytes = 0
    var maxEventBytes = 8 * 1024 * 1024

    mutating func feed(_ byte: UInt8) throws -> CloudSSEFrame? {
        if skipLF { skipLF = false; if byte == 10 { return nil } }
        if byte == 13 { skipLF = true; return try finishLine() }
        if byte == 10 { return try finishLine() }
        line.append(byte); eventBytes += 1
        guard eventBytes <= maxEventBytes else { throw CloudAPIError.malformedEvent("event exceeds size limit") }
        return nil
    }

    mutating func feed(_ bytes: Data) throws -> [CloudSSEFrame] {
        var frames: [CloudSSEFrame] = []
        for byte in bytes { if let frame = try feed(byte) { frames.append(frame) } }
        return frames
    }

    private mutating func finishLine() throws -> CloudSSEFrame? {
        guard var text = String(bytes: line, encoding: .utf8) else { throw CloudAPIError.malformedEvent("invalid UTF-8") }
        line.removeAll(keepingCapacity: true)
        if firstLine { firstLine = false; if text.first == "\u{FEFF}" { text.removeFirst() } }
        if text.isEmpty {
            defer { data.removeAll(keepingCapacity: true); event = ""; retry = nil; eventBytes = 0 }
            // Control-only frames carry id/retry updates too; consumers do not
            // acknowledge a run cursor until a JSON event has been accepted.
            return CloudSSEFrame(event: event.isEmpty ? "message" : event,
                                 data: data.joined(separator: "\n"), id: lastID, retryMilliseconds: retry)
        }
        if text.hasPrefix(":") { return nil }
        let pair = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        var value = pair.count == 2 ? String(pair[1]) : ""
        if value.first == " " { value.removeFirst() }
        switch pair[0] {
        case "data": data.append(value)
        case "event": event = value
        case "id": if !value.contains("\0") { lastID = value }
        case "retry": if !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }), let n = Int(value) { retry = n }
        default: break
        }
        return nil
    }
}

struct CloudSSEClient: Sendable {
    let client: CloudAPIClient
    var initialBackoff: Duration = .milliseconds(250)
    var maxReconnects = 8

    /// `accept` returns only after the consumer has applied the event. A cursor
    /// is acknowledged afterwards; malformed or rejected events never advance it.
    func consume(runID: String, chatID: String, after: Int = 0,
                 onCursor: @escaping @Sendable (Int) async -> Void = { _ in },
                 onEvent: @escaping @Sendable (CloudRunEvent, Data) async throws -> Void = { _, _ in },
                 accept: @escaping @Sendable (CloudRunEvent) async throws -> Void) async throws {
        var cursor = after
        var failures = 0
        var retryDelay = initialBackoff
        while true {
            try Task.checkCancellation()
            do {
                var request = try await client.request("/v1/runs/\(CloudAPIClient.segment(runID))/events")
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                request.timeoutInterval = 300
                if cursor > 0 { request.setValue(String(cursor), forHTTPHeaderField: "Last-Event-ID") }
                let (bytes, response) = try await client.session.bytes(for: request, delegate: CloudRedirectGuard())
                if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                    var body = Data()
                    for try await byte in bytes { body.append(byte); if body.count >= 65536 { break } }
                    try CloudAPIClient.validate(response, data: body)
                }
                try CloudAPIClient.validate(response)
                guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("text/event-stream") == true else {
                    throw CloudAPIError.invalidContentType
                }
                var parser = CloudSSEParser()
                for try await byte in bytes {
                    try Task.checkCancellation()
                    guard let frame = try parser.feed(byte) else { continue }
                    if let retry = frame.retryMilliseconds { retryDelay = .milliseconds(min(30000, max(100, retry))) }
                    guard !frame.data.isEmpty else { continue }
                    let event = try JSONDecoder().decode(CloudRunEvent.self, from: Data(frame.data.utf8))
                    guard event.runId == runID, event.chatId == chatID, event.id > 0,
                          event.id <= 9_007_199_254_740_991,
                          frame.id == nil || frame.id == String(event.id) else {
                        throw CloudAPIError.malformedEvent("run, chat or sequence mismatch")
                    }
                    if event.id <= cursor { continue }
                    try await onEvent(event, Data(frame.data.utf8))
                    try await accept(event)
                    cursor = event.id
                    await onCursor(cursor)
                    failures = 0
                    if case .finished = event.event { return }
                }
            } catch {
                if Task.isCancelled || error is CancellationError { throw CancellationError() }
                if let api = error as? CloudAPIError {
                    // Snapshot reconciliation belongs to the lifecycle owner.
                    // Never silently reset cursor_expired or skip a bad event.
                    switch api {
                    case .http(let status, _) where status == 408 || status == 429 || status >= 500: break
                    default: throw api
                    }
                } else if !(error is URLError) { throw error }
            }
            failures += 1
            guard failures <= maxReconnects else { throw CloudAPIError.reconnectLimit }
            let multiplier = 1 << min(failures - 1, 6)
            try await Task.sleep(for: min(retryDelay * multiplier, .seconds(30)))
        }
    }
}
