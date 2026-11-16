import Foundation

// Frozen shared data contract; update dependents if changing these Codable types.

// MARK: - Recording model (FROZEN §7, voice-rec owns)

struct VoiceRecording: Codable, Identifiable, Sendable {
    var id: UUID
    var conversationID: UUID
    var state: VoiceRecordingState
    var createdAt: Date
    var duration: TimeInterval
    var fileName: String                // Relative '<uuid>.m4a' filename within the recordings directory.
    var transcriptPreview: String?      // Truncated preview (~120 chars) populated once transcription finishes.
}

enum VoiceRecordingState: String, Codable, Sendable {
    case recording, paused, stopped, queued, transcribing, transcribed, failed
}

extension VoiceRecording {
    init(conversationID: UUID, createdAt: Date = Date()) {
        let id = UUID()
        self.init(id: id, conversationID: conversationID, state: .recording,
                  createdAt: createdAt, duration: 0,
                  fileName: id.uuidString + ".m4a", transcriptPreview: nil)
    }

    var sidecarName: String {
        (fileName as NSString).deletingPathExtension + ".json"
    }

    /// True for recordings needing banner recovery; transcribed items await send deletion elsewhere.
    var needsAttention: Bool {
        switch state {
        case .recording, .paused, .stopped, .queued, .transcribing, .failed:
            return true
        case .transcribed:
            return false
        }
    }
}

