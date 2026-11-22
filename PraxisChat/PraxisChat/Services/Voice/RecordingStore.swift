import Foundation
import AVFoundation

/// Stores <uuid>.m4a audio as crash-safe truth with atomic .json sidecars; MainActor-only caller.
struct RecordingStore: Sendable {
    let directory: URL

    /// Applies complete-until-first-unlock protection so background recording writes while locked.
    static func production() -> RecordingStore {
        let dir = AppDirectories.root.appendingPathComponent("Recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: dir.path)
        return RecordingStore(directory: dir)
    }

    // MARK: URLs

    func audioURL(for recording: VoiceRecording) -> URL {
        directory.appendingPathComponent(recording.fileName)
    }

    func audioURL(fileName: String) -> URL {
        directory.appendingPathComponent(fileName)
    }

    func sidecarURL(for recording: VoiceRecording) -> URL {
        directory.appendingPathComponent(recording.sidecarName)
    }

    // MARK: CRUD

    /// Atomically rewrites the sidecar; returns success so the controller can surface write errors.
    @discardableResult
    func save(_ recording: VoiceRecording) -> Bool {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(recording)
            try data.write(to: sidecarURL(for: recording), options: [.atomic])
            return true
        } catch {
            return false
        }
    }

    func load(id: UUID) -> VoiceRecording? {
        let url = directory.appendingPathComponent(id.uuidString + ".json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return Self.decode(data)
    }

    /// Only explicit user deletion or post-send cleanup may delete recordings, never logout.
    func delete(id: UUID) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(id.uuidString + ".m4a"))
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(id.uuidString + ".json"))
        PartTranscriptCache.clearSharedCache(fileName: id.uuidString + ".m4a")
    }

    func audioExists(for recording: VoiceRecording) -> Bool {
        FileManager.default.fileExists(atPath: audioURL(for: recording).path)
    }

    // MARK: Recovery scan

    /// Recovers sidecars and orphans newest-first; excluding shields active controller-owned IDs.
    func scan(excluding: Set<UUID> = [], includeTranscribed: Bool = false) -> [VoiceRecording] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: [.creationDateKey],
            options: [.skipsHiddenFiles])) ?? []
        var out: [VoiceRecording] = []
        var sidecarIDs = Set<String>()

        for url in files where url.pathExtension == "json" {
            sidecarIDs.insert(url.deletingPathExtension().lastPathComponent)
            guard let data = try? Data(contentsOf: url),
                  var recording = Self.decode(data) else { continue }
            guard !excluding.contains(recording.id) else { continue }
            guard recording.needsAttention || includeTranscribed else { continue }
            switch recording.state {
            case .recording:
                // AVAudioRecorder cannot append across launches, so killed recordings recover as paused.
                recording.state = .paused
                save(recording)
            case .transcribing:
                recording.state = .stopped
                save(recording)
            case .paused, .stopped, .queued, .failed, .transcribed:
                break
            }
            guard audioExists(for: recording) else { continue }
            out.append(recording)
        }

        // Adopts orphan .m4a files left by a crash before the first sidecar write.
        for url in files where url.pathExtension == "m4a" {
            let stem = url.deletingPathExtension().lastPathComponent
            guard !sidecarIDs.contains(stem), let id = UUID(uuidString: stem) else { continue }
            let created = (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? Date()
            var recording = VoiceRecording(id: id, conversationID: UUID(), state: .stopped,
                                           createdAt: created, duration: audioDuration(of: url),
                                           fileName: url.lastPathComponent, transcriptPreview: nil)
            recording.duration = audioDuration(of: url)
            save(recording)
            out.append(recording)
        }

        return out.sorted { $0.createdAt > $1.createdAt }
    }

    // MARK: Decoding

    static func decode(_ data: Data) -> VoiceRecording? {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(VoiceRecording.self, from: data)
    }

    private func audioDuration(of url: URL) -> TimeInterval {
        let asset = AVURLAsset(url: url)
        let seconds = CMTimeGetSeconds(asset.duration)
        return seconds.isFinite && seconds > 0 ? seconds : 0
    }
}
