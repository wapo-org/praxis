import Foundation
import Synchronization

/// Builds a fresh GroqTranscriber on MainActor per call so post-grant retries see updated consent.
struct LiveGroqTranscriber: Transcriber {
    /// Factory invoked per call to read live settings and consent on the main actor.
    var make: @Sendable @MainActor () -> GroqTranscriber
    /// Relays queue events so offline waits and retries update UI instead of appearing stuck.
    var onEvent: (@Sendable (TranscriptionEvent) -> Void)?

    func transcribe(file: URL, fileName: String,
                    progress: @Sendable @escaping (Double, Int, Int) -> Void) async throws -> VoiceTranscript {
        var transcriber = await MainActor.run { make() }
        transcriber.onEvent = onEvent
        return try await transcriber.transcribe(file: file, fileName: fileName, progress: progress)
    }
}

/// Sendable event sink wired before controller init; handler is attached before any transcription.
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
