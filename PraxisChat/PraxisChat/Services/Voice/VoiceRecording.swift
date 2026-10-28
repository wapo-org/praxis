import Foundation

// VoiceRecording.swift (voice-rec owns the file; both workers use it).
// FROZEN per VOICE_PLAN.md §7: do not change the structs/enums below
// without the orchestrator + both workers agreeing.

// MARK: - Recording model (FROZEN §7, voice-rec owns)

struct VoiceRecording: Codable, Identifiable, Sendable {
    var id: UUID
    var conversationID: UUID
    var state: VoiceRecordingState
    var createdAt: Date
    var duration: TimeInterval          // seconds of recorded audio
    var fileName: String                // "<uuid>.m4a" in the recordings folder
    var transcriptPreview: String?      // first ~120 chars once transcribed
}

enum VoiceRecordingState: String, Codable, Sendable {
    case recording, paused, stopped, queued, transcribing, transcribed, failed
}

extension VoiceRecording {
    /// A fresh recording that is about to start in `conversation`.
    init(conversationID: UUID, createdAt: Date = Date()) {
        let id = UUID()
        self.init(id: id, conversationID: conversationID, state: .recording,
                  createdAt: createdAt, duration: 0,
                  fileName: id.uuidString + ".m4a", transcriptPreview: nil)
    }

    /// Sidecar filename next to the audio: "<uuid>.json".
    var sidecarName: String {
        (fileName as NSString).deletingPathExtension + ".json"
    }

    /// Listed in the recovery UI (banner + recordings list). Transcribed
    /// recordings are done — their audio deletes on send — so they stay
    /// out of the banner even though the files still exist.
    var needsAttention: Bool {
        switch state {
        case .recording, .paused, .stopped, .queued, .transcribing, .failed:
            return true
        case .transcribed:
            return false
        }
    }
}

// NOTE: the frozen §7 consumer declarations (VoiceTranscript,
// VoiceTranscriptionError, Transcriber) live in voice-groq's
// GroqTranscriber.swift, VoiceSettingsReader in GroqVoiceSettings.swift,
// and VoiceSendObserver in VoiceInputController.swift. A TEMPORARY copy
// stood here until voice-groq integrated first (ddbdae0); the second
// integrator (voice-rec) deleted it at merge.
