import Foundation

/// Keeps the existing recorder/recovery/segmentation pipeline. Only the upload
/// changes: session-authenticated cloud API, never a device Groq/provider key.
struct CloudVoiceTranscriber: Transcriber {
    var client: CloudAPIClient
    var model: String
    var language: String?
    var queue = TranscriptionQueue()
    var partCache = PartTranscriptCache()
    var onEvent: (@Sendable (TranscriptionEvent) -> Void)?

    func transcribe(file: URL, fileName: String, progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript {
        do {
            try Task.checkCancellation()
            let plan = try await AudioSegmenter.plan(file: file)
            var transcripts = partCache.load(matching: plan, fileName: fileName)
            var prompt: String?
            for (index, part) in plan.parts.enumerated() {
                try Task.checkCancellation()
                if let cached = transcripts[index] {
                    prompt = AudioSegmenter.promptTail(cached.text)
                    progress(Double(index + 1) / Double(plan.parts.count), index + 1, plan.parts.count)
                    continue
                }
                let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("cloud-voice-\(UUID().uuidString).m4a")
                defer { try? FileManager.default.removeItem(at: temporary) }
                try await AudioSegmenter.exportPart(file: file, range: part.audioRange, to: temporary)
                let local = try await uploadWithSplit(file: temporary, fileName: fileName, prompt: prompt, duration: part.audioRange.upperBound - part.audioRange.lowerBound)
                let absolute = local.shifted(by: part.audioRange.lowerBound)
                transcripts[index] = absolute
                partCache.store(absolute, plan: plan, fileName: fileName, index: index)
                prompt = AudioSegmenter.promptTail(absolute.text)
                progress(Double(index + 1) / Double(plan.parts.count), index + 1, plan.parts.count)
            }
            let result = AudioSegmenter.stitch(transcripts.compactMap { $0 }, overlaps: plan.overlapEnds)
            partCache.clear(fileName: fileName)
            return VoiceTranscript(text: result.text, language: result.language, segments: result.segments.map { ($0.start, $0.end, $0.text) })
        } catch is CancellationError { throw VoiceTranscriptionError.cancelled }
        catch let error as VoiceTranscriptionError { throw error }
        catch { throw VoiceTranscriptionError.server(message: "That recording could not be transcribed. Your audio is kept for retry.") }
    }

    private func uploadWithSplit(file: URL, fileName: String, prompt: String?, duration: TimeInterval) async throws -> PartTranscript {
        do { return try await upload(file: file, fileName: fileName, prompt: prompt) }
        catch VoiceTranscriptionError.tooLarge where duration > AudioSegmenter.minSplitDuration * 2 {
            var halves: [PartTranscript] = []
            for range in [0..<(duration / 2), (duration / 2)..<duration] {
                try Task.checkCancellation()
                let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("cloud-voice-half-\(UUID().uuidString).m4a")
                defer { try? FileManager.default.removeItem(at: temporary) }
                try await AudioSegmenter.exportPart(file: file, range: range, to: temporary)
                let result = try await upload(file: temporary, fileName: fileName, prompt: prompt)
                halves.append(result.shifted(by: range.lowerBound))
            }
            return PartTranscript(text: halves.map(\.text).joined(separator: " "), language: halves.first?.language, segments: halves.flatMap(\.segments))
        }
    }

    private func upload(file: URL, fileName: String, prompt: String?) async throws -> PartTranscript {
        let audio = try Data(contentsOf: file)
        let body = Self.multipart(audio: audio, fileName: fileName, model: model, language: language, prompt: prompt)
        let client = client
        let events = onEvent
        let result: CloudCatalogTranscription = try await queue.run {
            do {
                return try await client.send("/v1/transcribe", method: "POST", body: body.data, contentType: body.contentType)
            } catch { throw Self.mapError(error) }
        } onEvent: { event in
            switch event {
            case .waitingForNetwork: events?(.waitingForNetwork)
            case .retrying(let attempt, let after): events?(.retrying(attempt: attempt, after: after))
            }
        }
        return PartTranscript(text: result.text.trimmingCharacters(in: .whitespacesAndNewlines), language: result.language,
                              segments: result.segments.map { .init(start: $0.start, end: $0.end, text: $0.text) })
    }

    static func mapError(_ error: Error) -> VoiceTranscriptionError {
        if error is CancellationError { return .cancelled }
        if let error = error as? URLError {
            if error.code == .cancelled { return .cancelled }
            if [.notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed].contains(error.code) { return .offline }
        }
        if let error = error as? CloudAPIError {
            switch error.statusCode {
            case 401: return .unauthorized
            case 403: return .consentRequired(host: GroqEndpoints.host)
            case 413: return .tooLarge
            case 429: return .rateLimited(retryAfter: nil)
            default: return .server(message: error.localizedDescription)
            }
        }
        return .server(message: "The cloud transcription request failed. Your audio is kept for retry.")
    }

    static func multipart(audio: Data, fileName: String, model: String, language: String?, prompt: String?) -> (data: Data, contentType: String) {
        let boundary = "PraxisCloudVoice-\(UUID().uuidString)"
        var data = Data()
        func append(_ value: String) { data.append(contentsOf: value.utf8) }
        func field(_ name: String, _ value: String) {
            append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
        }
        let safeName = URL(fileURLWithPath: fileName).lastPathComponent
            .components(separatedBy: CharacterSet(charactersIn: "\r\n\"\\")).joined()
        append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(safeName.isEmpty ? "recording.m4a" : safeName)\"\r\nContent-Type: audio/mp4\r\n\r\n")
        data.append(audio); append("\r\n")
        if !model.isEmpty { field("model", model) }
        if let language, !language.isEmpty { field("language", language) }
        if let prompt, !prompt.isEmpty { field("prompt", prompt) }
        append("--\(boundary)--\r\n")
        return (data, "multipart/form-data; boundary=\(boundary)")
    }
}

struct LiveCloudVoiceTranscriber: Transcriber {
    var make: @Sendable @MainActor () -> CloudVoiceTranscriber
    func transcribe(file: URL, fileName: String, progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript {
        let transcriber = await make()
        return try await transcriber.transcribe(file: file, fileName: fileName, progress: progress)
    }
}
