import Foundation
import AgentCore
import AgentMCP

// MARK: - Frozen voice interfaces

/// Transcription result with absolute segment timestamps (offset by part start).
struct VoiceTranscript: Sendable {
    var text: String
    var language: String?
    var segments: [(start: TimeInterval, end: TimeInterval, text: String)]
}

enum VoiceTranscriptionError: Error, Sendable {
    case missingKey
    case consentRequired(host: String)
    case unauthorized
    case tooLarge // Emitted only after part re-split fails; audio is retained for retry.
    case rateLimited(retryAfter: TimeInterval?)
    case offline
    case server(message: String) // 5xx or decode failures; message is sanitized for UI display.
    case cancelled
}

protocol Transcriber: Sendable {
    /// Never logs audio, API keys, or transcripts.
    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript
}

/// Maps HTTP status and capped Retry-After (max 60 s, seconds or HTTP-date) to an error.
func mapGroqError(status: Int, retryAfter: TimeInterval? = nil, message: String? = nil) -> VoiceTranscriptionError {
    switch status {
    case 401: return .unauthorized
    case 408: return .server(message: message ?? "The request timed out.")
    case 413: return .tooLarge
    case 429: return .rateLimited(retryAfter: retryAfter)
    default:
        if (500...599).contains(status) { return .server(message: message ?? "Groq had a problem (HTTP \(status)).") }
        return .server(message: message ?? "Groq rejected the request (HTTP \(status)).")
    }
}

// MARK: - Events

enum TranscriptionEvent: Sendable {
    /// Signals unusable network so the controller persists the recording as .queued.
    case waitingForNetwork
    /// Emitted before a 1-based retry attempt with the backoff delay in seconds.
    case retrying(attempt: Int, after: TimeInterval)
}

struct GroqEndpoints {
    static let host = "api.groq.com"
    static let baseURL = URL(string: "https://api.groq.com/openai/v1")!
    static let transcriptionsURL = URL(string: "https://api.groq.com/openai/v1/audio/transcriptions")!
}

// MARK: - Transcriber

/// Snapshots config at init (build per call); reads SecretStore key per call without storing it.
struct GroqTranscriber: Transcriber {
    var transport: any HTTPTransport
    var secrets: any SecretStore
    var modelID: String
    var language: String?
    /// Snapshot of api.groq.com AI data consent captured on the main actor before calling.
    var consentGranted: Bool
    var queue: TranscriptionQueue
    /// Stores completed part transcripts so retries resume without re-uploading.
    var partCache: PartTranscriptCache
    var onEvent: (@Sendable (TranscriptionEvent) -> Void)?

    init(transport: any HTTPTransport, secrets: any SecretStore, modelID: String, language: String? = nil,
         consentGranted: Bool, queue: TranscriptionQueue? = nil, partCache: PartTranscriptCache? = nil,
         onEvent: (@Sendable (TranscriptionEvent) -> Void)? = nil) {
        self.transport = transport
        self.secrets = secrets
        self.modelID = modelID
        self.language = language
        self.consentGranted = consentGranted
        self.queue = queue ?? TranscriptionQueue()
        self.partCache = partCache ?? PartTranscriptCache()
        self.onEvent = onEvent
    }

    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript {
        guard consentGranted else { throw VoiceTranscriptionError.consentRequired(host: GroqEndpoints.host) }
        let key = (try? secrets.secret(for: GroqVoiceSettings.keychainAccount))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !key.isEmpty else { throw VoiceTranscriptionError.missingKey }
        try Task.checkCancellation()

        let plan: SegmentationPlan
        do {
            plan = try await AudioSegmenter.plan(file: file)
        } catch is CancellationError {
            throw VoiceTranscriptionError.cancelled
        } catch {
            throw VoiceTranscriptionError.server(message: "That recording can't be read.")
        }
        let parts = plan.parts.count
        let cached = partCache.load(matching: plan, fileName: fileName)
        var transcripts = cached
        var prompt: String? = cached.compactMap { $0 }.last.map { AudioSegmenter.promptTail($0.text) }

        for (index, part) in plan.parts.enumerated() {
            try Task.checkCancellation()
            if let done = transcripts[index] {
                progress(Double(index + 1) / Double(parts), index + 1, parts)
                prompt = AudioSegmenter.promptTail(done.text)
                continue
            }
            let partURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("groq-part-\(UUID().uuidString).m4a")
            do {
                try await AudioSegmenter.exportPart(file: file, range: part.audioRange, to: partURL)
            } catch is CancellationError {
                throw VoiceTranscriptionError.cancelled
            } catch {
                throw VoiceTranscriptionError.server(message: "That recording can't be read.")
            }
            defer { try? FileManager.default.removeItem(at: partURL) }
            do {
                let text = try await transcribePart(file: partURL, fileName: fileName, key: key, prompt: prompt,
                                                    range: part.audioRange,
                                                    minDuration: AudioSegmenter.minSplitDuration)
                let absolute = text.shifted(by: part.audioRange.lowerBound)
                transcripts[index] = absolute
                partCache.store(absolute, plan: plan, fileName: fileName, index: index)
                prompt = AudioSegmenter.promptTail(absolute.text)
            } catch {
                try? FileManager.default.removeItem(at: partURL)
                throw error
            }
            progress(Double(index + 1) / Double(parts), index + 1, parts)
        }

        let stitched = AudioSegmenter.stitch(transcripts.compactMap { $0 }, overlaps: plan.overlapEnds)
        partCache.clear(fileName: fileName)
        return VoiceTranscript(text: stitched.text, language: stitched.language, segments: stitched.segments)
    }

    /// Uploads one part with at most one 413 halve-and-retry level.
    private func transcribePart(file partURL: URL, fileName: String, key: String, prompt: String?,
                                range: Range<TimeInterval>, minDuration: TimeInterval) async throws -> PartTranscript {
        do {
            return try await upload(file: partURL, fileName: fileName, key: key, prompt: prompt)
        } catch VoiceTranscriptionError.tooLarge where range.upperBound - range.lowerBound > minDuration * 2 {
            // On 413, halves parts down to 1 min and retries each once, keeping audio on failure.
            let mid = (range.lowerBound + range.upperBound) / 2
            var halves: [PartTranscript] = []
            // Timestamps in partURL are relative to the part start and must be shifted back.
            for half in [range.lowerBound..<mid, mid..<range.upperBound] {
                let relative = (half.lowerBound - range.lowerBound)..<(half.upperBound - range.lowerBound)
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("groq-half-\(UUID().uuidString).m4a")
                try await AudioSegmenter.exportPart(file: partURL, range: relative, to: url)
                defer { try? FileManager.default.removeItem(at: url) }
                let text = try await upload(file: url, fileName: fileName, key: key, prompt: prompt)
                halves.append(text.shifted(by: half.lowerBound))
                try? FileManager.default.removeItem(at: url)
            }
            // Halves are adjacent (no overlap): join with a single space.
            let joined = halves.map(\.text).joined(separator: " ")
            return PartTranscript(text: joined, language: halves.first?.language,
                                  segments: halves.flatMap(\.segments))
        }
    }

    private func upload(file partURL: URL, fileName: String, key: String, prompt: String?) async throws -> PartTranscript {
        let audio: Data
        do {
            audio = try Data(contentsOf: partURL)
        } catch {
            throw VoiceTranscriptionError.server(message: "That recording can't be read.")
        }
        let body = multipartBody(audio: audio, fileName: fileName, model: modelID, language: language, prompt: prompt)
        // Captured as Sendable values so each retry rebuilds the request cleanly.
        let transport = transport
        let key = key
        let payload = body.data
        let contentType = "multipart/form-data; boundary=\(body.boundary)"
        let events = onEvent

        // Map HTTP status inside the queue so 429/5xx trigger backoff instead of escaping it.
        let (data, _): (Data, HTTPResponseHead)
        do {
            (data, _) = try await queue.run {
                var request = URLRequest(url: GroqEndpoints.transcriptionsURL,
                                         cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 600)
                request.httpMethod = "POST"
                request.setValue("Bearer \(key)", forHTTPHeaderField: "authorization")
                request.setValue("application/json", forHTTPHeaderField: "accept")
                request.setValue(contentType, forHTTPHeaderField: "content-type")
                request.httpBody = payload
                let data: Data
                let head: HTTPResponseHead
                do {
                    (data, head) = try await transport.data(request)
                } catch let error as ProviderError {
                    throw Self.mapProviderError(error)
                } catch is CancellationError {
                    throw VoiceTranscriptionError.cancelled
                } catch {
                    throw VoiceTranscriptionError.server(message: "The transcription request failed.")
                }
                guard head.isSuccess else {
                    throw mapGroqError(status: head.status, retryAfter: head.retryAfter?.timeInterval,
                                       message: Self.groqMessage(in: data))
                }
                return (data, head)
            } onEvent: { event in
                switch event {
                case .waitingForNetwork: events?(.waitingForNetwork)
                case .retrying(let attempt, let after): events?(.retrying(attempt: attempt, after: after))
                }
            }
        } catch is CancellationError {
            throw VoiceTranscriptionError.cancelled
        }
        do {
            return try PartTranscript(verboseJSON: data)
        } catch {
            throw VoiceTranscriptionError.server(message: "Groq's answer couldn't be read.")
        }
    }

    private static func mapProviderError(_ error: ProviderError) -> VoiceTranscriptionError {
        switch error {
        case .network: return .offline
        case .http(let status, let message, let retryAfter):
            return mapGroqError(status: status, retryAfter: retryAfter?.timeInterval, message: message)
        case .stream(_, let message), .decoding(let message), .invalidConfiguration(let message):
            return .server(message: message)
        }
    }

    private static func groqMessage(in data: Data) -> String? {
        guard let json = try? JSONDecoder().decode(GroqErrorEnvelope.self, from: data) else { return nil }
        let message = json.error.message.trimmingCharacters(in: .whitespacesAndNewlines)
        return message.isEmpty ? nil : String(message.prefix(300))
    }

    private struct GroqErrorEnvelope: Decodable {
        struct Inner: Decodable { var message: String }
        var error: Inner
    }

    /// Builds Groq STT multipart body; temperature is omitted to keep the default 0.
    func multipartBody(audio: Data, fileName: String, model: String, language: String?,
                       prompt: String?) -> (boundary: String, data: Data) {
        let boundary = "PraxisVoice-\(UUID().uuidString)"
        var data = Data()
        func field(_ name: String, _ value: String) {
            data.append("--\(boundary)\r\n".utf8)
            data.append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n".utf8)
            data.append("\(value)\r\n".utf8)
        }
        data.append("--\(boundary)\r\n".utf8)
        data.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".utf8)
        data.append("Content-Type: audio/mp4\r\n\r\n".utf8)
        data.append(audio)
        data.append("\r\n".utf8)
        field("model", model)
        field("response_format", "verbose_json")
        field("timestamp_granularities[]", "segment")
        if let language, !language.isEmpty { field("language", language) }
        if let prompt, !prompt.isEmpty { field("prompt", prompt) }
        data.append("--\(boundary)--\r\n".utf8)
        return (boundary, data)
    }
}

private extension Data {
    mutating func append(_ string: String.UTF8View) {
        append(contentsOf: string)
    }
}

extension Duration {
    var timeInterval: TimeInterval {
        Double(components.seconds) + Double(components.attoseconds) / 1e18
    }
}

/// One part's verbose_json answer, in part-local times until `shifted`.
struct PartTranscript: Sendable, Codable {
    var text: String
    var language: String?
    var segments: [Segment]

    struct Segment: Sendable, Codable {
        var start: TimeInterval
        var end: TimeInterval
        var text: String
    }

    init(text: String, language: String?, segments: [Segment]) {
        self.text = text
        self.language = language
        self.segments = segments
    }

    init(verboseJSON data: Data) throws {
        struct Wire: Decodable {
            struct WireSegment: Decodable {
                var start: Double
                var end: Double
                var text: String
            }
            var text: String
            var language: String?
            var segments: [WireSegment]?
        }
        let wire = try JSONDecoder().decode(Wire.self, from: data)
        text = wire.text.trimmingCharacters(in: .whitespacesAndNewlines)
        language = wire.language
        segments = (wire.segments ?? []).map { Segment(start: $0.start, end: $0.end, text: $0.text) }
    }

    func shifted(by offset: TimeInterval) -> PartTranscript {
        PartTranscript(text: text, language: language,
                       segments: segments.map { Segment(start: $0.start + offset, end: $0.end + offset, text: $0.text) })
    }
}
