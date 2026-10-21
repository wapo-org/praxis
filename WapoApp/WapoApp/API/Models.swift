import Foundation

/// Wire models for the local API. Event names are the ones observed in the
/// reference binary's SSE handling: `message_start`, `content_block_start`,
/// `content_block_delta`, `message_stop` with `text/event-stream`.
enum StreamEvent: Equatable {
    case messageStart(id: String?)
    case textDelta(String)
    case messageStop
    case error(String)
    case unknown(String)
}

struct ChatMessage: Identifiable, Equatable {
    enum Role: String { case user, assistant, system }
    var id: String
    var role: Role
    var text: String
    var isStreaming: Bool = false

    init(id: String = UUID().uuidString, role: Role, text: String) {
        self.id = id
        self.role = role
        self.text = text
    }
}

struct Conversation: Identifiable, Equatable {
    var id: String
    var title: String
    var updatedAt: Date
    var messages: [ChatMessage] = []
}

struct Organization: Decodable, Identifiable {
    var uuid: String?
    var id: String { uuid ?? name ?? "org" }
    var name: String?
}

/// Decodes one SSE frame's JSON payload into a `StreamEvent`.
/// Tolerant of the Anthropic-style content-block shape:
/// `{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}`
enum SSEDecoder {
    static func decode(eventField: String?, data: String) -> StreamEvent {
        let trimmed = data.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "[DONE]" else { return .messageStop }
        var type = eventField ?? ""
        var text: String?
        var messageId: String?
        var errorMessage: String?
        if let raw = trimmed.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: raw) as? [String: Any] {
            if let t = obj["type"] as? String { type = t }
            if let m = obj["message"] as? [String: Any], let mid = m["id"] as? String {
                messageId = mid
            }
            if let d = obj["delta"] as? [String: Any] {
                text = (d["text"] as? String) ?? (d["partial_json"] as? String)
            }
            if text == nil, let t = obj["text"] as? String { text = t }
            if let e = obj["error"] as? [String: Any] {
                errorMessage = (e["message"] as? String) ?? type
            }
        }
        switch type {
        case "message_start": return .messageStart(id: messageId)
        case "content_block_delta": return .textDelta(text ?? "")
        case "message_stop": return .messageStop
        case "error": return .error(errorMessage ?? "Stream error")
        default: return text.map(StreamEvent.textDelta) ?? .unknown(type)
        }
    }
}
