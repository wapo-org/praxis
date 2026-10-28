import Foundation
import AVFoundation

/// Recordings on disk (VOICE_PLAN.md §2).
///
/// Layout: `Application Support/PraxisChat/Recordings/<uuid>.m4a` (the
/// audio — the recorder streams it straight to disk, so it is the crash-
/// safe truth) plus an atomic JSON sidecar `<uuid>.json` (the
/// `VoiceRecording` itself: state, chat, dates, duration). A kill can lose
/// at most seconds of sidecar metadata, never audio.
///
/// `scan()` is the launch recovery: every sidecar not `.transcribed`, plus
/// every orphan `.m4a` without a sidecar, becomes a recoverable recording.
/// Stale in-flight states are normalized (`.recording` → `.paused`, a dead
/// `.transcribing` → `.stopped`: its audio is intact and re-transcribes
/// whole), so `.recording` always means a live recorder.
///
/// Threading: plain struct over a directory; the `@MainActor` controller
/// is the only caller. No secrets ever pass through here.
struct RecordingStore: Sendable {
    let directory: URL

    /// Production store. Best-effort: creates the folder and asks for
    /// first-unlock file protection, so background recording keeps
    /// writing while the screen is locked.
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

    /// Rewrites the sidecar atomically. Called on every state change and
    /// every ~5 s while recording; failures are swallowed (the audio is
    /// safe regardless) but reported so the controller can surface them.
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

    /// Deletes the audio + sidecar. Only the user (explicit delete) or the
    /// sent-message rule may call this — never cleanup, never logout.
    func delete(id: UUID) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(id.uuidString + ".m4a"))
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(id.uuidString + ".json"))
    }

    func audioExists(for recording: VoiceRecording) -> Bool {
        FileManager.default.fileExists(atPath: audioURL(for: recording).path)
    }

    // MARK: Recovery scan

    /// All recoverable recordings, newest first. Normalizes stale states
    /// back to disk and adopts orphans (persisting a synthesized sidecar
    /// so the scan is stable across launches).
    ///
    /// `excluding` skips live/transcribing/under-review ids: their states
    /// are owned by the controller right now, and scan's stale-state
    /// normalization must not rewrite them. `includeTranscribed` adds
    /// finished-but-unsent recordings (the Settings list; never the banner).
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
            // Stale in-flight states: no recorder is alive at scan time.
            switch recording.state {
            case .recording:
                // Killed mid-recording: audio on disk is complete as far
                // as it got. It can't resume (AVAudioRecorder can't append
                // across launches), but it transcribes and plays.
                recording.state = .paused
                save(recording)
            case .transcribing:
                // Killed mid-upload: re-transcribe whole on retry.
                recording.state = .stopped
                save(recording)
            case .paused, .stopped, .queued, .failed, .transcribed:
                break
            }
            // A sidecar whose audio is gone is nothing to recover.
            guard audioExists(for: recording) else { continue }
            out.append(recording)
        }

        // Orphans: audio without a sidecar (a crash between the recorder
        // creating the file and the first sidecar write, or a stray copy).
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

    /// Best-effort duration probe for adopted orphans (0 when unreadable).
    private func audioDuration(of url: URL) -> TimeInterval {
        let asset = AVURLAsset(url: url)
        let seconds = CMTimeGetSeconds(asset.duration)
        return seconds.isFinite && seconds > 0 ? seconds : 0
    }
}
