import Foundation

/// Local-API client. The reference binary honours a `Claude-API-Base-Url`
/// user-defaults override and ships `http://localhost:8000`, `https://claude.ai/api`
/// and `https://api.anthropic.com` base strings; this client mirrors that
/// resolution order and defaults to the local API.
final class APIClient {
    static let baseURLDefaultsKey = "Claude-API-Base-Url" // observed key name
    static let defaultBaseURL = URL(string: "http://localhost:8000")!

    private let session: URLSession
    init(session: URLSession = .shared) { self.session = session }

    var baseURL: URL {
        if let raw = UserDefaults.standard.string(forKey: Self.baseURLDefaultsKey),
           let url = URL(string: raw) {
            return url
        }
        return Self.defaultBaseURL
    }

    private func request(_ path: String, method: String = "GET") -> URLRequest {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")
        if let token = UserDefaults.standard.string(forKey: "Wapo-API-Token") {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    /// GET /api/organizations/ — path observed in the reference binary.
    func organizations() async throws -> [Organization] {
        let (data, _) = try await session.data(for: request("api/organizations/"))
        return (try? JSONDecoder().decode([Organization].self, from: data)) ?? []
    }

    /// Streams a chat turn from the local API as SSE.
    /// Expected local contract (event names observed in the reference):
    /// POST {base}/api/chat with JSON `{"messages":[…],"stream":true}`,
    /// responding `text/event-stream` with message/content-block events.
    /// The path itself is an adapter choice — no chat POST path was
    /// recoverable as a plain string, so keep it in one place here.
    func streamChat(messages: [ChatMessage]) -> AsyncThrowingStream<StreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = request("api/chat", method: "POST")
                    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    let payload: [String: Any] = [
                        "stream": true,
                        "messages": messages.map {
                            ["role": $0.role.rawValue, "content": $0.text]
                        },
                    ]
                    req.httpBody = try JSONSerialization.data(withJSONObject: payload)
                    let (bytes, response) = try await session.bytes(for: req)
                    if let http = response as? HTTPURLResponse,
                       !(200..<300).contains(http.statusCode) {
                        // 429 maps to the limit-reached view state
                        // (`approaching_limit` / `claude_message_limit_reached`).
                        continuation.yield(.error(http.statusCode == 429
                            ? "LIMIT_REACHED"
                            : "HTTP \(http.statusCode) from local API"))
                        continuation.finish()
                        return
                    }
                    var eventField: String?
                    for try await line in bytes.lines {
                        if line.hasPrefix("event:") {
                            eventField = String(line.dropFirst(6))
                                .trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            let data = String(line.dropFirst(5))
                                .trimmingCharacters(in: .whitespaces)
                            continuation.yield(SSEDecoder.decode(eventField: eventField, data: data))
                            eventField = nil
                        }
                    }
                    continuation.yield(.messageStop)
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
