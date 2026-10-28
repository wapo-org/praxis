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

// MARK: - TEMPORARY-VOICE-GROQ-DUP (delete when GroqTranscriber.swift lands)
//
// The declarations below are owned by voice-groq's GroqTranscriber.swift
// (VOICE_PLAN.md §7, FROZEN). They are duplicated here EXACTLY as frozen
// so voice-rec compiles and tests before that file integrates. The voice
// orchestrator deletes this whole block at final merge; if voice-groq
// integrates first, voice-rec drops it on rebase. Either way the two
// copies must never coexist in one build (duplicate definitions).

// GroqTranscriber.swift (voice-groq owns the file; voice-rec consumes it)
struct VoiceTranscript: Sendable {
    var text: String
    var language: String?
    /// (absoluteStart, absoluteEnd, text) per verbose_json segment.
    var segments: [(start: TimeInterval, end: TimeInterval, text: String)]
}

enum VoiceTranscriptionError: Error, Sendable {
    case missingKey
    case consentRequired(host: String)
    case unauthorized            // 401: "Check your Groq API key"
    case tooLarge                // 413 after re-split: keep audio + Retry
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

// GroqVoiceSettings.swift (voice-groq owns; voice-rec reads isConfigured only)
@MainActor
protocol VoiceSettingsReader {
    var isConfigured: Bool { get }   // key present (model may still default)
}

// NOTE: VoiceSendObserver's frozen home is VoiceInputController.swift
// (voice-rec owns it permanently) — it lives there, not in this block.

// END TEMPORARY-VOICE-GROQ-DUP
