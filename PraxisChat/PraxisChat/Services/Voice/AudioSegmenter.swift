import AVFoundation
import Foundation

/// Plan for splitting one recording into uploadable parts.
struct SegmentationPlan: Sendable {
    struct Part: Sendable {
        /// Absolute audio range to export (includes the leading overlap).
        var audioRange: Range<TimeInterval>
    }
    var parts: [Part]
    /// Absolute end of each part's leading overlap window (nil for part 0):
    /// stitching drops segments fully inside it.
    var overlapEnds: [TimeInterval?]
    var duration: TimeInterval
}

/// Splits long recordings into Groq-sized parts at silence-preferring
/// boundaries, and stitches part transcripts back together.
///
/// Limits: ≤ ~10 min / ≤ 20 MB per part (20 MB stays under the 25 MB
/// free-tier cap with multipart overhead headroom).
enum AudioSegmenter {
    static let maxPartDuration: TimeInterval = 600
    static let maxPartBytes = 20 << 20
    /// Leading overlap each part (after the first) re-records; the
    /// overlap's tail words are stripped at stitch time via timestamps.
    static let overlap: TimeInterval = 5
    /// 413-halving floor: never split below ~1 min parts.
    static let minSplitDuration: TimeInterval = 60
    /// Silence search around each nominal boundary.
    static let searchRadius: TimeInterval = 30
    static let silenceWindow: TimeInterval = 0.5

    // MARK: Plan

    /// Nominal part length: 10 min, shrunk proportionally when the file is
    /// so dense that 10 min would exceed 20 MB. Pure, unit-tested.
    static func nominalPartDuration(fileBytes: Int, duration: TimeInterval) -> TimeInterval {
        guard duration > 0, fileBytes > 0 else { return maxPartDuration }
        let bytesPerSecond = Double(fileBytes) / duration
        guard bytesPerSecond > 0 else { return maxPartDuration }
        return min(maxPartDuration, max(minSplitDuration, Double(maxPartBytes) / bytesPerSecond))
    }

    static func plan(file: URL) async throws -> SegmentationPlan {
        let values = try file.resourceValues(forKeys: [.fileSizeKey])
        let asset = AVURLAsset(url: file)
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0 else {
            throw NSError(domain: "PraxisChat.Voice", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Couldn't read the recording's length."])
        }
        let nominal = nominalPartDuration(fileBytes: values.fileSize ?? 0, duration: duration)
        guard duration > nominal else {
            return SegmentationPlan(parts: [SegmentationPlan.Part(audioRange: 0..<duration)],
                                    overlapEnds: [nil], duration: duration)
        }
        // Nominal boundaries, adjusted toward silence (falls back to
        // nominal when decoding fails: the scan is an optimization, never
        // a failure).
        let scanned = try? await scanEnergies(file: file)
        var boundaries: [TimeInterval] = []
        var previous = 0.0
        var k = 1
        while Double(k) * nominal < duration {
            let nominalPoint = min(Double(k) * nominal, duration - 1)
            var point = nominalPoint
            if let scanned {
                point = bestBoundary(energies: scanned.energies, windowDuration: scanned.windowDuration,
                                     nominal: nominalPoint, searchRadius: searchRadius,
                                     limits: (previous + minSplitDuration)..<(duration - 1))
            }
            // Keep monotonic with a sane gap even if the scan misbehaves.
            point = min(max(point, previous + minSplitDuration), duration - 1)
            boundaries.append(point)
            previous = point
            k += 1
        }
        var parts: [SegmentationPlan.Part] = []
        var overlapEnds: [TimeInterval?] = []
        var start = 0.0
        for (i, end) in (boundaries + [duration]).enumerated() {
            let from = i == 0 ? 0.0 : max(0, start - overlap)
            parts.append(SegmentationPlan.Part(audioRange: from..<end))
            overlapEnds.append(i == 0 ? nil : start)
            start = end
        }
        return SegmentationPlan(parts: parts, overlapEnds: overlapEnds, duration: duration)
    }

    // MARK: Silence scan

    /// RMS energy per window over mono samples. Pure, unit-tested.
    static func energies(samples: [Float], windowSize: Int) -> [Float] {
        guard windowSize > 0, !samples.isEmpty else { return [] }
        var out: [Float] = []
        out.reserveCapacity(samples.count / windowSize + 1)
        var i = 0
        while i < samples.count {
            let end = min(i + windowSize, samples.count)
            var sum: Float = 0
            for s in samples[i..<end] { sum += s * s }
            out.append(sqrt(sum / Float(end - i)))
            i = end
        }
        return out
    }

    /// Lowest-energy window center within nominal ± searchRadius (clamped to
    /// `limits`); ties go to the window nearest nominal. Falls back to the
    /// clamped nominal when there is nothing to scan. Pure, unit-tested.
    static func bestBoundary(energies: [Float], windowDuration: TimeInterval, nominal: TimeInterval,
                             searchRadius: TimeInterval, limits: Range<TimeInterval>) -> TimeInterval {
        let clampedNominal = min(max(nominal, limits.lowerBound), limits.upperBound - 0.01)
        guard !energies.isEmpty, windowDuration > 0 else { return clampedNominal }
        let lo = max(nominal - searchRadius, limits.lowerBound)
        let hi = min(nominal + searchRadius, limits.upperBound)
        guard lo < hi else { return clampedNominal }
        var best = clampedNominal
        var bestEnergy = Float.infinity
        for (i, energy) in energies.enumerated() {
            let center = (Double(i) + 0.5) * windowDuration
            guard center >= lo, center <= hi else { continue }
            if energy < bestEnergy - 1e-9 || (abs(energy - bestEnergy) <= 1e-9 && abs(center - nominal) < abs(best - nominal)) {
                bestEnergy = energy
                best = center
            }
        }
        return best
    }

    /// Decodes the file to 16 kHz mono and returns RMS energy per 0.5 s
    /// window. Nil when decoding fails (the plan then uses nominal
    /// boundaries).
    static func scanEnergies(file: URL) async throws -> (energies: [Float], windowDuration: TimeInterval)? {
        let asset = AVURLAsset(url: file)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return nil }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMBitDepthKey: 32,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
        ])
        reader.add(output)
        guard reader.startReading() else { return nil }
        let windowSize = Int(16_000 * silenceWindow)
        var pending: [Float] = []
        pending.reserveCapacity(windowSize)
        var energies: [Float] = []
        while let buffer = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var samples = [Float](repeating: 0, count: length / MemoryLayout<Float>.size)
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &samples)
            pending.append(contentsOf: samples)
            while pending.count >= windowSize {
                var sum: Float = 0
                for s in pending[..<windowSize] { sum += s * s }
                energies.append(sqrt(sum / Float(windowSize)))
                pending.removeFirst(windowSize)
            }
            try Task.checkCancellation()
        }
        if !pending.isEmpty {
            var sum: Float = 0
            for s in pending { sum += s * s }
            energies.append(sqrt(sum / Float(pending.count)))
        }
        if reader.status == .failed { return nil }
        return (energies, silenceWindow)
    }

    // MARK: Export

    /// Exports `range` (seconds) to `dest` as `.m4a`, passthrough when
    /// possible, re-encoded when the trim needs it.
    static func exportPart(file: URL, range: Range<TimeInterval>, to dest: URL) async throws {
        try? FileManager.default.removeItem(at: dest)
        let asset = AVURLAsset(url: file)
        for preset in [AVAssetExportPresetPassthrough, AVAssetExportPresetAppleM4A] {
            guard let session = AVAssetExportSession(asset: asset, presetName: preset) else { continue }
            session.outputURL = dest
            session.outputFileType = .m4a
            session.timeRange = CMTimeRange(start: CMTime(seconds: range.lowerBound, preferredTimescale: 1000),
                                            duration: CMTime(seconds: range.upperBound - range.lowerBound,
                                                             preferredTimescale: 1000))
            await session.exportAsynchronously()
            switch session.status {
            case .completed: return
            case .cancelled: throw CancellationError()
            default:
                try? FileManager.default.removeItem(at: dest)
                continue
            }
        }
        throw NSError(domain: "PraxisChat.Voice", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Couldn't split the recording."])
    }

    // MARK: Stitch

    /// Joins part texts with single-space joining (no space before
    /// `.,!?;:%)]}`, no double spaces), dropping each part's leading
    /// segments fully inside its overlap window (`overlaps[i]` is part i's
    /// absolute overlap end, nil for part 0). Pure, unit-tested.
    static func stitch(_ parts: [PartTranscript], overlaps: [TimeInterval?]) ->
        (text: String, language: String?, segments: [(start: TimeInterval, end: TimeInterval, text: String)]) {
        var texts: [String] = []
        var segments: [(start: TimeInterval, end: TimeInterval, text: String)] = []
        var language: String?
        for (i, part) in parts.enumerated() {
            language = language ?? part.language
            let overlapEnd = i < overlaps.count ? overlaps[i] : nil
            let kept: [PartTranscript.Segment]
            if let end = overlapEnd, !part.segments.isEmpty {
                kept = part.segments.filter { $0.end > end }
            } else {
                kept = part.segments
            }
            if part.segments.isEmpty {
                // No timestamps to strip by: keep the whole text (verbose_json
                // normally always returns segments, so this is rare).
                texts.append(part.text)
            } else {
                texts.append(join(kept.map(\.text)))
                segments.append(contentsOf: kept.map { ($0.start, $0.end, $0.text) })
            }
        }
        return (join(texts), language, segments)
    }

    /// Single-space joining with closer punctuation glued. Pure.
    static func join(_ phrases: [String]) -> String {
        let closers: Set<Character> = [".", ",", "!", "?", ";", ":", "%", ")", "]", "}"]
        var result = ""
        for phrase in phrases {
            let trimmed = phrase.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            if result.isEmpty { result = trimmed }
            else if let first = trimmed.first, closers.contains(first) { result += trimmed }
            else { result += " " + trimmed }
        }
        return result
    }

    /// Previous part's tail as the next part's `prompt` (≤ ~200 tokens ≈
    /// 800 chars, cut at a word boundary). Pure.
    static func promptTail(_ text: String, maxChars: Int = 800) -> String {
        guard text.count > maxChars else { return text }
        let tail = text.suffix(maxChars)
        if let space = tail.firstIndex(of: " "), tail.distance(from: space, to: tail.endIndex) > 1 {
            return String(tail[tail.index(after: space)...])
        }
        return String(tail)
    }
}

private extension AVAssetExportSession {
    /// Structured-concurrency wrapper for `exportAsynchronously`.
    func exportAsynchronously() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            exportAsynchronously { continuation.resume() }
        }
    }
}

// MARK: - Resume cache

/// Completed part transcripts on disk, so Retry resumes from the first
/// untranscribed part instead of re-uploading. Keyed by file name; a cached
/// entry is reused only when the fresh plan has the same part count, starts
/// and duration (segmentation is deterministic for one file). Cleared when
/// the full transcript stitches. Best-effort: any I/O failure reads as a
/// cache miss, never as a transcription failure.
struct PartTranscriptCache: Sendable {
    var directory: URL

    init(directory: URL? = nil) {
        self.directory = directory ?? (FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first ??
            FileManager.default.temporaryDirectory).appendingPathComponent("PraxisChat/VoiceParts", isDirectory: true)
    }

    private struct Manifest: Codable {
        var count: Int
        var starts: [TimeInterval]
        var duration: TimeInterval
    }

    private func safeName(_ fileName: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "._-"))
        return fileName.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
    }

    private func manifestURL(_ fileName: String) -> URL {
        directory.appendingPathComponent(safeName(fileName) + ".manifest.json")
    }

    private func partURL(_ fileName: String, index: Int) -> URL {
        directory.appendingPathComponent("\(safeName(fileName)).part\(index).json")
    }

    /// Cached transcripts aligned with `plan.parts` (nil = not done).
    func load(matching plan: SegmentationPlan, fileName: String) -> [PartTranscript?] {
        let empty = [PartTranscript?](repeating: nil, count: plan.parts.count)
        guard let data = try? Data(contentsOf: manifestURL(fileName)),
              let manifest = try? JSONDecoder().decode(Manifest.self, from: data),
              manifest.count == plan.parts.count,
              manifest.starts.count == plan.parts.count,
              abs(manifest.duration - plan.duration) < 0.01,
              zip(manifest.starts, plan.parts).allSatisfy({ abs($0 - $1.audioRange.lowerBound) < 0.01 })
        else { return empty }
        return plan.parts.indices.map { i in
            guard let data = try? Data(contentsOf: partURL(fileName, index: i)) else { return nil }
            return try? JSONDecoder().decode(PartTranscript.self, from: data)
        }
    }

    func store(_ transcript: PartTranscript, plan: SegmentationPlan, fileName: String, index: Int) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [
            .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication,
        ])
        let manifest = Manifest(count: plan.parts.count, starts: plan.parts.map(\.audioRange.lowerBound),
                                duration: plan.duration)
        if let data = try? JSONEncoder().encode(manifest) {
            try? data.write(to: manifestURL(fileName), options: Self.writingOptions)
        }
        if let data = try? JSONEncoder().encode(transcript) {
            try? data.write(to: partURL(fileName, index: index), options: Self.writingOptions)
        }
    }

    /// Matches the app standard (recordings, conversations, attachments):
    /// transcripts are user content, protected like the audio they came from.
    private static let writingOptions: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]

    /// Clears the shared (production-directory) cache for one recording.
    /// Called by `RecordingStore.delete`, so deleting a recording leaves no
    /// transcript behind in Caches. `directory` is test-only.
    static func clearSharedCache(fileName: String, in directory: URL? = nil) {
        PartTranscriptCache(directory: directory).clear(fileName: fileName)
    }

    func clear(fileName: String) {
        try? FileManager.default.removeItem(at: manifestURL(fileName))
        for i in 0..<256 {
            let url = partURL(fileName, index: i)
            guard FileManager.default.fileExists(atPath: url.path) else { break }
            try? FileManager.default.removeItem(at: url)
        }
    }
}
