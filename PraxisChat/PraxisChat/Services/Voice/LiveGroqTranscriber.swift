import Foundation
import Synchronization

/// The production `Transcriber`: builds a FRESH `GroqTranscriber` for every
/// call, so the model, language and consent snapshots are always current.
///
/// A single snapshot wired at controller creation would freeze the consent
/// state from before the user ever saw the sheet: the consent allow-path
/// (grant, then `retryTranscription`) would throw `.consentRequired` again
/// and loop the sheet forever. The factory runs on the main actor because
/// the settings and consent stores live there; the upload itself still runs
/// off it inside `GroqTranscriber.transcribe`.
///
/// Added by `voice` at final integration (VOICE_PLAN §10); both workers'
/// files are untouched by this wiring.
struct LiveGroqTranscriber: Transcriber {
    /// Builds the transcriber for one call. Must read the live settings
    /// (model, language) and the live consent grant.
    var make: @Sendable @MainActor () -> GroqTranscriber
    /// Queue lifecycle events (waiting-for-network, retries). Wired by
    /// `VoiceInputController.production` via a relay (review fix F4): the
    /// offline wait would otherwise look like a stuck "Transcribing…".
    var onEvent: (@Sendable (TranscriptionEvent) -> Void)?

    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript {
        var transcriber = await MainActor.run { make() }
        transcriber.onEvent = onEvent
        return try await transcriber.transcribe(file: file, fileName: fileName, progress: progress)
    }
}

/// Sendable sink for transcription events. Created in `production()` before
/// the controller exists; the handler is set once it does (events only flow
/// during a transcription, strictly later).
final class TranscriptionEventRelay: Sendable {
    private let handler: Mutex<(@Sendable (TranscriptionEvent) -> Void)?> = Mutex(nil)

    func send(_ event: TranscriptionEvent) {
        let current = handler.withLock { $0 }
        current?(event)
    }

    func setHandler(_ newHandler: (@Sendable (TranscriptionEvent) -> Void)?) {
        handler.withLock { $0 = newHandler }
    }
}
