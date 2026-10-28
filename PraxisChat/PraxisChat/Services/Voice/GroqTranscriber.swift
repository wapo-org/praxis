import Foundation
import AgentCore
import AgentMCP

// MARK: - FROZEN voice interfaces (VOICE_PLAN §7, voice-groq owns this file)

/// One transcription result. Segment times are absolute (offset by part
/// start for multi-part recordings).
struct VoiceTranscript: Sendable {
    var text: String
    var language: String?
    /// (absoluteStart, absoluteEnd, text) per verbose_json segment.
    var segments: [(start: TimeInterval, end: TimeInterval, text: String)]
}

enum VoiceTranscriptionError: Error, Sendable {
    case missingKey
    case consentRequired(host: String)
    case unauthorized // 401: "Check your Groq API key"
    case tooLarge // 413 after re-split: keep audio + Retry
    case rateLimited(retryAfter: TimeInterval?)
    case offline
    case server(message: String) // 5xx / decode failures, safe to show
    case cancelled
}

protocol Transcriber: Sendable {
    /// Transcribes `file` (a complete .m4a). Progress: (fraction, part, parts).
    /// Throws `VoiceTranscriptionError`. Never logs audio, keys, or transcripts.
    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript
}

/// Map a Groq HTTP failure to a `VoiceTranscriptionError`. Pure: no I/O,
/// safe to unit test. `retryAfter` comes from `HTTPResponseHead.retryAfter`
/// (seconds or HTTP-date, capped at 60 s).
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

/// Lifecycle callbacks for the controller (drives sidecar state + Retry UI).
enum TranscriptionEvent: Sendable {
    /// No usable network: the controller should mark the recording `.queued`.
    case waitingForNetwork
    /// Backoff before attempt `attempt` (1-based); `after` seconds.
    case retrying(attempt: Int, after: TimeInterval)
}

struct GroqEndpoints {
    static let host = "api.groq.com"
    static let baseURL = URL(string: "https://api.groq.com/openai/v1")!
    static let transcriptionsURL = URL(string: "https://api.groq.com/openai/v1/audio/transcriptions")!
}

// MARK: - Transcriber

/// Groq speech-to-text over an injected `HTTPTransport`. One call runs the
/// whole pipeline: consent/key check → segment → sequential part uploads
/// (tail-as-prompt, resume from cache) → stitch. Retries/backoff/offline
/// come from the injected `TranscriptionQueue`.
///
/// All configuration is a snapshot taken at `init`: the controller builds a
/// fresh transcriber per call from the current settings. The key itself is
/// read per call from the `SecretStore`, never held or logged.
struct GroqTranscriber: Transcriber {
    var transport: any HTTPTransport
    var secrets: any SecretStore
    var modelID: String
    var language: String?
    /// Snapshot of `AIDataConsent.isGranted("api.groq.com")`, taken by the
    /// controller on the main actor before this call.
    var consentGranted: Bool
    var queue: TranscriptionQueue
    /// Completed part transcripts, so Retry resumes instead of re-uploading.
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
            // Export to a temp file (removed right after its upload).
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

    /// One part upload with 413 halve-and-retry (one halving level per part).
    private func transcribePart(file partURL: URL, fileName: String, key: String, prompt: String?,
                                range: Range<TimeInterval>, minDuration: TimeInterval) async throws -> PartTranscript {
        do {
            return try await upload(file: partURL, fileName: fileName, key: key, prompt: prompt)
        } catch VoiceTranscriptionError.tooLarge where range.upperBound - range.lowerBound > minDuration * 2 {
            // Re-split the failing part smaller (halve, min 1 min) and retry
            // each half once. A half that still fails keeps the audio + Retry.
            let mid = (range.lowerBound + range.upperBound) / 2
            var halves: [PartTranscript] = []
            // NB: `partURL` holds the already-exported part, so the halves
            // are relative to the part start; shift back afterwards.
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

    /// Single multipart upload through the retry queue.
    private func upload(file partURL: URL, fileName: String, key: String, prompt: String?) async throws -> PartTranscript {
        let audio: Data
        do {
            audio = try Data(contentsOf: partURL)
        } catch {
            throw VoiceTranscriptionError.server(message: "That recording can't be read.")
        }
        let body = multipartBody(audio: audio, fileName: fileName, model: modelID, language: language, prompt: prompt)
        // Built inside the retry closure (retries rebuild it): only Sendable
        // values cross into the operation.
        let transport = transport
        let key = key
        let payload = body.data
        let contentType = "multipart/form-data; boundary=\(body.boundary)"
        let events = onEvent

        // The HTTP mapping lives INSIDE the queue: the transport returns a
        // head for any status and throws only below HTTP, so mapping past
        // the queue would let 429/5xx skip the backoff policy entirely.
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

    /// Provider/transport failures below HTTP: offline vs transient server.
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

    /// Multipart body per the Groq STT docs: `file`, `model`,
    /// `response_format=verbose_json`, `timestamp_granularities[]=segment`,
    /// optional `language` + `prompt`. Temperature stays 0 (omitted).
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

    /// Offset every segment by the part's absolute start.
    func shifted(by offset: TimeInterval) -> PartTranscript {
        PartTranscript(text: text, language: language,
                       segments: segments.map { Segment(start: $0.start + offset, end: $0.end + offset, text: $0.text) })
    }
}
