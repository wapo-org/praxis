import Foundation

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

    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript {
        let transcriber = await MainActor.run { make() }
        return try await transcriber.transcribe(file: file, fileName: fileName, progress: progress)
    }
}
