import Foundation
import Observation
import AgentCore
import AgentMCP

/// Queues MCP elicitations and resolves every waiter once so tools never hang.
@MainActor
@Observable
final class ElicitationCenter: MCPElicitationHandler, RunScopedElicitationHandler {
    struct Pending: Identifiable, Equatable {
        let id: UUID
        let request: MCPElicitation
        /// Nil scope leaves request untouched when a run cancels.
        let scope: UUID?
    }

    private(set) var queue: [Pending] = []
    @ObservationIgnored private var waiters: [UUID: CheckedContinuation<MCPElicitationResult, Never>] = [:]

    nonisolated init() {}

    var current: Pending? { queue.first }

    /// Callers enqueue in MainActor arrival order, not creation order.
    nonisolated func elicit(_ request: MCPElicitation) async -> MCPElicitationResult {
        await elicit(request, scope: nil)
    }

    nonisolated func elicit(_ request: MCPElicitation, scope: UUID?) async -> MCPElicitationResult {
        let id = UUID()
        return await withTaskCancellationHandler {
            await self.wait(id, request, scope: scope)
        } onCancel: {
            Task { @MainActor in self.respond(id, with: .cancel) }
        }
    }

    private func wait(_ id: UUID, _ request: MCPElicitation, scope: UUID?) async -> MCPElicitationResult {
        if Task.isCancelled { return .cancel }
        return await withCheckedContinuation { continuation in
            waiters[id] = continuation
            queue.append(Pending(id: id, request: request, scope: scope))
        }
    }

    func respond(_ id: UUID, with result: MCPElicitationResult) {
        queue.removeAll { $0.id == id }
        waiters.removeValue(forKey: id)?.resume(returning: result)
    }

    /// Cancels only matching scoped waiters; leaves other chats and unscoped intact.
    func cancel(scope: UUID) {
        for pending in queue where pending.scope == scope {
            respond(pending.id, with: .cancel)
        }
    }
}

/// Parsed once per spec (flat primitive object); server re-validates unknown keywords.
struct ElicitationField: Identifiable, Equatable {
    enum Kind: Equatable {
        case text, number, integer, boolean
        case choice([String])
    }

    enum Format: String, Equatable {
        case email, uri, date
        case dateTime = "date-time"
    }

    var id: String { key }
    let key: String
    let title: String
    let detail: String?
    let kind: Kind
    let isRequired: Bool
    let defaultValue: JSONValue?
    var format: Format? = nil
    var minLength: Int? = nil
    var maxLength: Int? = nil
    var minimum: Double? = nil
    var maximum: Double? = nil
    /// Fallback titles match choice values when schema omits them.
    var choiceTitles: [String] = []

    static func fields(in schema: JSONValue) -> [ElicitationField] {
        let required = Set(schema["required"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        guard let properties = schema["properties"]?.objectValue else { return [] }
        // JSON objects lose key order, so sort keys to keep the form stable.
        return properties.keys.sorted().compactMap { key in
            guard let property = properties[key] else { return nil }
            let kind: Kind
            var titles: [String] = []
            if let options = property["enum"]?.arrayValue?.compactMap(\.stringValue), !options.isEmpty {
                kind = .choice(options)
                let names = property["enumNames"]?.arrayValue?.compactMap(\.stringValue) ?? []
                titles = names.count == options.count ? names : options
            } else if let oneOf = property["oneOf"]?.arrayValue ?? property["anyOf"]?.arrayValue,
                      case let pairs = oneOf.compactMap({ o -> (String, String)? in
                          guard let value = o["const"]?.stringValue else { return nil }
                          return (value, o["title"]?.stringValue ?? value)
                      }), !pairs.isEmpty {
                kind = .choice(pairs.map(\.0))
                titles = pairs.map(\.1)
            } else {
                switch property["type"]?.stringValue {
                case "number": kind = .number
                case "integer": kind = .integer
                case "boolean": kind = .boolean
                default: kind = .text
                }
            }
            return ElicitationField(
                key: key, title: property["title"]?.stringValue ?? key,
                detail: property["description"]?.stringValue, kind: kind,
                isRequired: required.contains(key), defaultValue: property["default"],
                format: kind == .text ? property["format"]?.stringValue.flatMap(Format.init(rawValue:)) : nil,
                minLength: property["minLength"]?.doubleValue.map { Int($0) },
                maxLength: property["maxLength"]?.doubleValue.map { Int($0) },
                minimum: property["minimum"]?.doubleValue, maximum: property["maximum"]?.doubleValue,
                choiceTitles: titles)
        }
    }

    func problem(with raw: String) -> String? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty { return isRequired && kind != .boolean ? "Required" : nil }
        switch kind {
        case .boolean:
            return nil
        case .choice(let options):
            return options.contains(text) ? nil : "Choose one of the options"
        case .number, .integer:
            guard let n = Self.number(text) else { return kind == .integer ? "Enter a whole number" : "Enter a number" }
            if kind == .integer, n.rounded() != n { return "Enter a whole number" }
            if let minimum, n < minimum { return "Must be at least \(Self.format(minimum))" }
            if let maximum, n > maximum { return "Must be at most \(Self.format(maximum))" }
            return nil
        case .text:
            if let minLength, text.count < minLength { return "At least \(minLength) characters" }
            if let maxLength, text.count > maxLength { return "At most \(maxLength) characters" }
            switch format {
            case .email?:
                return text.wholeMatch(of: /[^@\s]+@[^@\s]+\.[^@\s]+/) != nil ? nil : "Enter an email address"
            case .uri?:
                guard let url = URL(string: text), url.scheme != nil, url.host() != nil || url.scheme == "mailto" else {
                    return "Enter a full link, like https://example.com"
                }
                return nil
            case .date?:
                return Self.dateFormatter.date(from: text) != nil ? nil : "Use the format YYYY-MM-DD"
            case .dateTime?:
                return Self.dateTime(text) != nil ? nil : "Enter a date and time"
            case nil:
                return nil
            }
        }
    }

    func value(from raw: String) -> JSONValue? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        switch kind {
        case .number: return Self.number(text).map(JSONValue.number)
        case .integer: return Self.number(text).map { .number($0.rounded()) }
        case .boolean: return .bool(text == "true")
        case .text, .choice: return .string(text)
        }
    }

    var defaultText: String? {
        switch defaultValue {
        case .string(let s)?: return s
        case .number(let n)?: return Self.format(n)
        default: return nil
        }
    }

    /// Accepts a decimal comma (number pads in many locales type one).
    static func number(_ text: String) -> Double? {
        Double(text.replacingOccurrences(of: ",", with: "."))
    }

    static func format(_ n: Double) -> String {
        n.rounded() == n && abs(n) < 1e15 ? String(Int(n)) : String(n)
    }

    static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .iso8601)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static func dateTime(_ text: String) -> Date? {
        let f = ISO8601DateFormatter()
        if let d = f.date(from: text) { return d }
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: text)
    }

    static func dateTimeString(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }
}

/// Holds form state and validation out of the view for testability.
struct ElicitationForm: Equatable {
    let fields: [ElicitationField]
    var values: [String: String] = [:]
    var flags: [String: Bool] = [:]

    init(schema: JSONValue) {
        fields = ElicitationField.fields(in: schema)
        for field in fields {
            if field.kind == .boolean {
                if case .bool(let b)? = field.defaultValue { flags[field.key] = b }
            } else if let text = field.defaultText {
                values[field.key] = text
            }
        }
    }

    func problem(for field: ElicitationField) -> String? {
        field.kind == .boolean ? nil : field.problem(with: values[field.key] ?? "")
    }

    var problems: [String: String] {
        var out: [String: String] = [:]
        for field in fields { if let p = problem(for: field) { out[field.key] = p } }
        return out
    }

    var isValid: Bool { problems.isEmpty }

    /// Always includes booleans since untouched switches mean false.
    func content() -> JSONValue? {
        guard isValid else { return nil }
        var content: [String: JSONValue] = [:]
        for field in fields {
            if field.kind == .boolean {
                content[field.key] = .bool(flags[field.key] ?? false)
            } else if let value = field.value(from: values[field.key] ?? "") {
                content[field.key] = value
            }
        }
        return .object(content)
    }
}
