import Foundation
import AgentCore

/// Incremental decoder from SSE events to `ProviderEvent`s for one response.
/// Fresh per request; never shared.
protocol StreamAccumulator: Sendable {
    /// Saw the wire's terminal marker — stop reading the body.
    var isDone: Bool { get }
    /// Throws `ProviderError.stream` for errors delivered inside the stream.
    mutating func consume(_ event: SSEEvent) throws -> [ProviderEvent]
    /// Body ended: emits the closing events ending in `.completed`, or throws
    /// when the response was cut short.
    mutating func finish() throws -> [ProviderEvent]
}

enum HTTPSupport {
    /// Reasoning and server tools can pause a stream for minutes.
    static let streamTimeout: TimeInterval = 300
    static let jsonTimeout: TimeInterval = 60

    static func request(_ url: URL, method: String = "POST", headers: [String: String], body: Data? = nil,
                        timeout: TimeInterval) -> URLRequest {
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpMethod = method
        for (k, v) in headers { r.setValue(v, forHTTPHeaderField: k) }
        r.httpBody = body
        return r
    }

    /// Builds a request up front so configuration errors surface through
    /// the stream as `ProviderError`s.
    static func prepare(_ make: () throws -> URLRequest) -> Result<URLRequest, ProviderError> {
        do {
            return .success(try make())
        } catch let e as ProviderError {
            return .failure(e)
        } catch {
            return .failure(.invalidConfiguration(error.localizedDescription))
        }
    }

    /// Redirect policy for provider transports: a redirected request keeps
    /// its `authorization` / `x-api-key` headers, so redirects must stay on
    /// the endpoint's host and must never downgrade https to http. Same-host
    /// http stays allowed when the endpoint itself is http, so local servers
    /// (Ollama, LM Studio, llama.cpp) keep working.
    static func redirectGuard(for baseURL: URL) -> @Sendable (URL) -> Bool {
        let baseHost = baseURL.host?.lowercased()
        let baseScheme = baseURL.scheme?.lowercased()
        return { url in
            guard url.host?.lowercased() == baseHost else { return false }
            switch (baseScheme, url.scheme?.lowercased()) {
            case ("https", "https"), ("http", "http"), ("http", "https"): return true
            default: return false
            }
        }
    }

    /// Adapter headers first, then the user's extras (which win).
    static func merged(_ base: [String: String], extra: [String: String]) -> [String: String] {
        var out = base
        for (k, v) in extra {
            // Header names are case-insensitive: drop a differently-cased default.
            if let existing = out.keys.first(where: { $0.caseInsensitiveCompare(k) == .orderedSame }) {
                out.removeValue(forKey: existing)
            }
            out[k] = v
        }
        return out
    }

    /// Maps a non-2xx reply. Understands `{"error":{"type","message"}}`
    /// (both flavors), `{"error":"…"}`, `{"message":"…"}`, `{"detail":"…"}`
    /// and plain-text bodies from proxies.
    static func error(head: HTTPResponseHead, body: Data) -> ProviderError {
        let message = errorMessage(in: body) ?? HTTPURLResponse.localizedString(forStatusCode: head.status).capitalizedFirst
        return .http(status: head.status, message: message, retryAfter: head.retryAfter)
    }

    static func errorMessage(in body: Data) -> String? {
        if let json = try? JSONValue(parsing: body), let details = errorDetails(json) {
            return details.message
        }
        let text = String(decoding: body.prefix(600), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        if text.isEmpty || text.hasPrefix("<") { return nil } // empty or an HTML error page
        return String(text.prefix(300))
    }

    /// `(type, message)` from an error object, or nil when `json` isn't one.
    static func errorDetails(_ json: JSONValue) -> (type: String, message: String)? {
        if let err = json["error"] {
            switch err {
            case .string(let s):
                return ("error", s)
            case .object:
                let message = err["message"]?.stringValue ?? err["msg"]?.stringValue ?? err.encodedString()
                let type = err["type"]?.stringValue ?? errorType(code: err["code"]) ?? "error"
                return (type, message)
            default:
                break
            }
        }
        if let m = json["message"]?.stringValue ?? json["detail"]?.stringValue {
            return (json["type"]?.stringValue ?? "error", m)
        }
        return nil
    }

    /// Maps vendor codes (OpenRouter sends numeric HTTP-like codes inside
    /// streams) onto type names `ProviderError.isRetryable` understands.
    static func errorType(code: JSONValue?) -> String? {
        switch code {
        case .number(let n):
            // `Int(exactly:)`: a plain `Int(n)` traps on out-of-range
            // doubles, and the code is server-controlled.
            guard let status = Int(exactly: n) else { return "error" }
            if status == 429 { return "rate_limit_error" }
            if status == 408 { return "timeout" }
            if (500...599).contains(status) { return "server_error" }
            return "error_\(status)"
        case .string(let s):
            return s
        default:
            return nil
        }
    }

    /// Runs one streaming request through `accumulator`.
    static func eventStream<A: StreamAccumulator>(transport: any HTTPTransport, request: Result<URLRequest, ProviderError>,
                                                  accumulator: A) -> AsyncThrowingStream<ProviderEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let urlRequest = try request.get()
                    let response = try await transport.stream(urlRequest)
                    guard response.head.isSuccess else {
                        let body = try await response.collect(limit: 1 << 20)
                        throw error(head: response.head, body: body)
                    }
                    let contentType = response.head.header("content-type")?.lowercased() ?? ""
                    if contentType.contains("application/json") {
                        // Some servers answer a streaming request with a JSON error and 200.
                        let body = try await response.collect(limit: 1 << 20)
                        if let json = try? JSONValue(parsing: body), let d = errorDetails(json) {
                            throw ProviderError.stream(type: d.type, message: d.message)
                        }
                        throw ProviderError.decoding("Expected an event stream but got JSON. Does this server support streaming?")
                    }
                    var parser = SSEParser()
                    var acc = accumulator
                    reading: for try await chunk in response.body {
                        for event in parser.feed(chunk) {
                            for e in try acc.consume(event) { continuation.yield(e) }
                            if acc.isDone { break reading }
                        }
                    }
                    try Task.checkCancellation()
                    if !acc.isDone {
                        for event in parser.finish() {
                            for e in try acc.consume(event) { continuation.yield(e) }
                        }
                    }
                    for e in try acc.finish() { continuation.yield(e) }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish(throwing: CancellationError())
                } catch let e as ProviderError {
                    continuation.finish(throwing: Task.isCancelled ? CancellationError() : e)
                } catch {
                    continuation.finish(throwing: Task.isCancelled ? CancellationError() : ProviderError.network(error.localizedDescription))
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// GET returning parsed JSON; non-2xx mapped to `ProviderError.http`.
    static func getJSON(transport: any HTTPTransport, url: URL, headers: [String: String]) async throws -> JSONValue {
        let request = Self.request(url, method: "GET", headers: headers, timeout: jsonTimeout)
        let (data, head): (Data, HTTPResponseHead)
        do {
            (data, head) = try await transport.data(request)
        } catch let e as ProviderError {
            throw e
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            throw ProviderError.network(error.localizedDescription)
        }
        guard head.isSuccess else { throw Self.error(head: head, body: data) }
        do {
            return try JSONValue(parsing: data)
        } catch {
            throw ProviderError.decoding("The server's reply isn't valid JSON.")
        }
    }

    static func json(_ event: SSEEvent) -> JSONValue? {
        try? JSONValue(parsing: Data(event.data.utf8))
    }

    static func dataURL(_ media: MediaData) -> String {
        "data:\(media.mediaType);base64,\(media.data.base64EncodedString())"
    }

    /// Text-like documents are inlined as text on servers without document
    /// support (and sent as `text` sources to Anthropic).
    static func isTextLike(_ mediaType: String) -> Bool {
        let t = mediaType.lowercased()
        if t.hasPrefix("text/") { return true }
        return ["application/json", "application/xml", "application/x-yaml", "application/yaml",
                "application/javascript", "application/csv"].contains(t)
    }

    static func wrappedNote(_ text: String) -> String {
        "<system-reminder>\n\(text)\n</system-reminder>"
    }

    static func wrappedDocument(_ media: MediaData) -> String {
        let name = media.name ?? "document"
        return "<document name=\"\(name)\">\n\(String(decoding: media.data, as: UTF8.self))\n</document>"
    }

    /// Image input support from a model-list entry, when it says.
    /// Understands OpenRouter (`architecture.input_modalities`), plain
    /// `input_modalities` / `modalities` arrays, Anthropic-style
    /// `capabilities.image_input.supported`, a `capabilities.vision` flag
    /// and capability-name lists (`["vision", "tools"]`, LM Studio /
    /// Ollama style). Nil when the entry has none of these.
    static func imageSupport(in model: JSONValue) -> Bool? {
        func modalities(_ v: JSONValue?) -> Bool? {
            guard let list = v?.arrayValue else {
                // "text+image->text" (OpenRouter's `architecture.modality`).
                if let s = v?.stringValue, s.contains("->") {
                    return s.split(separator: "-").first.map { $0.contains("image") }
                }
                return nil
            }
            return list.contains { $0.stringValue?.lowercased() == "image" }
        }
        if let r = modalities(model["architecture"]?["input_modalities"]) { return r }
        if let r = modalities(model["input_modalities"]) { return r }
        if let r = modalities(model["architecture"]?["modality"]) { return r }
        if let caps = model["capabilities"] {
            if let list = caps.arrayValue {
                return list.contains { ["vision", "image", "image_input"].contains($0.stringValue?.lowercased() ?? "") }
            }
            if let supported = caps["image_input"]?["supported"]?.boolValue { return supported }
            if let flag = caps["image_input"]?.boolValue ?? caps["vision"]?.boolValue { return flag }
        }
        if let r = modalities(model["modalities"]?["input"] ?? model["modalities"]) { return r }
        return nil
    }

    /// Tool-use support from a model-list entry, when it says.
    /// Understands OpenRouter (`supported_parameters` containing "tools"),
    /// Anthropic-style `capabilities.tool_use` / `capabilities.tools` (a
    /// flag or a `{"supported": …}` object) and capability-name lists
    /// (`["tools", "vision"]`, LM Studio / Ollama style). Nil when the entry
    /// has none of these.
    static func toolSupport(in model: JSONValue) -> Bool? {
        if let params = model["supported_parameters"]?.arrayValue {
            return params.contains { $0.stringValue?.lowercased() == "tools" }
        }
        if let caps = model["capabilities"] {
            if let list = caps.arrayValue {
                return list.contains { ["tools", "tool_use"].contains($0.stringValue?.lowercased() ?? "") }
            }
            let keys = [caps["tool_use"], caps["tools"]]
            for key in keys {
                if let supported = key?["supported"]?.boolValue { return supported }
                if let flag = key?.boolValue { return flag }
            }
            // A tools key in some other shape still names the capability.
            if keys.contains(where: { $0 != nil && !($0?.isNull ?? true) }) { return true }
        }
        return nil
    }

    static func omittedStub(_ kind: String, _ media: MediaData) -> String {
        let name = media.name.map { " \"\($0)\"" } ?? ""
        return "[\(kind)\(name) (\(media.mediaType)) omitted: this model can't read it]"
    }
}

extension String {
    var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
    var nilIfEmpty: String? { isEmpty ? nil : self }
    var isBlank: Bool { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}

extension Usage {
    var isEmpty: Bool { inputTokens == 0 && outputTokens == 0 && cacheReadTokens == 0 && cacheWriteTokens == 0 }
}
