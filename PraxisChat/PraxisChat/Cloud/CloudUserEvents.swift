import Foundation

struct CloudUserEvent: Decodable, Sendable {
    let type: String
    let id: Int
    let entity: String
    let entityId: String
    let operation: String
    let syncCursor: String
}

/// User events discover work from other clients; individual run streams still
/// own deltas and response handlers. Cursor advances only after reconciliation.
struct CloudUserEvents: Sendable {
    let client: CloudAPIClient
    func consume(after: Int, accept: @escaping @Sendable (CloudUserEvent) async throws -> Void) async throws {
        var cursor = after, failures = 0
        while !Task.isCancelled {
            do {
                var request = try await client.request("/v1/events")
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                request.setValue(String(cursor), forHTTPHeaderField: "Last-Event-ID")
                request.timeoutInterval = 300
                let (bytes, response) = try await client.session.bytes(for: request, delegate: CloudRedirectGuard())
                try CloudAPIClient.validate(response)
                guard (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.lowercased().hasPrefix("text/event-stream") == true else { throw CloudAPIError.invalidContentType }
                var parser = CloudSSEParser()
                for try await byte in bytes {
                    try Task.checkCancellation()
                    guard let frame = try parser.feed(byte), !frame.data.isEmpty else { continue }
                    let event = try JSONDecoder().decode(CloudUserEvent.self, from: Data(frame.data.utf8))
                    guard event.type == "user.event", event.id > 0, event.id <= 9_007_199_254_740_991,
                          frame.id == nil || frame.id == String(event.id) else { throw CloudAPIError.malformedEvent("Invalid user event cursor") }
                    guard event.id > cursor else { continue }
                    try await accept(event)
                    cursor = event.id; failures = 0
                }
            } catch {
                if Task.isCancelled || error is CancellationError { return }
                if let api = error as? CloudAPIError, api.statusCode == 401 { throw error }
                // A rejected sync page retains this event's cursor for retry.
            }
            failures += 1
            try await Task.sleep(for: .milliseconds(min(30_000, 250 * (1 << min(failures - 1, 7)))))
        }
    }
}
