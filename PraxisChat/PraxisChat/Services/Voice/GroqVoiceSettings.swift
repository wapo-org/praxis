import Foundation
import Observation
import AgentCore
import AgentProviders
import AgentMCP

// MARK: - FROZEN voice interface (VOICE_PLAN §7; voice-rec reads isConfigured)

// Note: the frozen decl is `@MainActor protocol VoiceSettingsReader`.
// `GroqVoiceSettings` below conforms; voice-rec consumes the protocol.
@MainActor
protocol VoiceSettingsReader {
    /// Key present (the model may still be the default).
    var isConfigured: Bool { get }
}

/// Groq voice settings: API key (Keychain only), speech-model list cache +
/// selection, and language. Persisted in its OWN JSON file
/// (`Application Support/PraxisChat/voice-settings.json`) — deliberately NOT
/// in `ProviderSettings.swift`, which effort/picker share (conflict map).
///
/// `fileURL == nil` keeps everything in memory (tests, previews).
@MainActor
@Observable
final class GroqVoiceSettings: VoiceSettingsReader {
    nonisolated static let keychainService = "PraxisChat.Voice"
    nonisolated static let keychainAccount = "groq.apiKey"
    /// Sensible default when listed (fastest/cheapest per the Groq STT docs).
    nonisolated static let defaultModelID = "whisper-large-v3-turbo"
    /// A model list older than this is read again on opening the screen,
    /// mirroring `ProviderSettings.modelListLifetime`.
    nonisolated static let modelListLifetime: TimeInterval = 24 * 3600

    private struct File: Codable {
        var version = 1
        var selectedModelID: String
        var language: String?
        var cachedModels: [String] = []
        var modelsFetchedAt: Date?
    }

    /// The model id uploads use. Always non-empty (defaults, then persists).
    var selectedModelID: String
    /// ISO-639-1 code for the `language` param; nil = Auto.
    var language: String?
    /// Last fetched speech-model ids (filtered to STT), newest fetch last.
    private(set) var cachedModels: [String]
    private(set) var modelsFetchedAt: Date?
    private(set) var hasKey = false
    private(set) var refreshing = false
    /// Last refresh failure, safe to show; cleared on success.
    private(set) var lastRefreshError: String?

    /// Rows for the picker: cached STT ids, plus the selected id when it
    /// isn't listed (manual-entry fallback: unknown future STT ids and
    /// typed ids stay selectable).
    var displayModels: [String] {
        var ids = cachedModels
        if !selectedModelID.isEmpty, !ids.contains(selectedModelID) {
            ids.append(selectedModelID)
        }
        return ids
    }

    var isConfigured: Bool { hasKey }

    var modelListIsStale: Bool {
        guard let fetched = modelsFetchedAt else { return true }
        return Date().timeIntervalSince(fetched) > Self.modelListLifetime
    }

    @ObservationIgnored let fileURL: URL?
    @ObservationIgnored private let secrets: any SecretStore
    @ObservationIgnored private let transport: any HTTPTransport

    init(fileURL: URL?, secrets: any SecretStore, transport: any HTTPTransport = URLSessionTransport()) {
        self.fileURL = fileURL
        self.secrets = secrets
        self.transport = transport
        if let fileURL, let data = try? Data(contentsOf: fileURL),
           let file = try? JSONDecoder().decode(File.self, from: data) {
            selectedModelID = file.selectedModelID.isEmpty ? Self.defaultModelID : file.selectedModelID
            language = file.language
            cachedModels = file.cachedModels
            modelsFetchedAt = file.modelsFetchedAt
        } else {
            selectedModelID = Self.defaultModelID
            language = nil
            cachedModels = []
            modelsFetchedAt = nil
        }
        hasKey = ((try? secrets.secret(for: Self.keychainAccount)) ?? nil)?.isEmpty == false
    }

    // MARK: Key (Keychain only; never logged, never in the JSON)

    /// Trims on save; empty removes.
    func saveKey(_ raw: String) {
        let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            if key.isEmpty {
                try secrets.removeSecret(for: Self.keychainAccount)
            } else {
                try secrets.setSecret(key, for: Self.keychainAccount)
            }
            hasKey = !key.isEmpty
        } catch {
            // Keychain failures leave the old state; the UI re-reads hasKey.
            hasKey = ((try? secrets.secret(for: Self.keychainAccount)) ?? nil)?.isEmpty == false
        }
    }

    func removeKey() { saveKey("") }

    // MARK: Models

    /// Groq's model list carries NO speech capability flag (models doc), so
    /// speech models are filtered by id: contains `whisper`
    /// (case-insensitive). Pure, unit-tested.
    nonisolated static func speechModels(from models: [ModelInfo]) -> [ModelInfo] {
        models.filter { $0.id.lowercased().contains("whisper") }
    }

    /// `whisper-large-v3-turbo` when listed, else the first listed STT id,
    /// else nil (the UI then shows the manual-entry row). Pure.
    nonisolated static func defaultModel(from ids: [String]) -> String? {
        if ids.contains(defaultModelID) { return defaultModelID }
        return ids.first
    }

    /// `GET /models` with the stored key, filtered to STT ids. A 401 keeps
    /// the key (it may be a paste away from correct) and reports "Check
    /// your Groq API key". `-PraxisFakeGroqModels YES` (UI tests) answers
    /// with a canned list instead of the network.
    func refreshModels() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "PraxisFakeGroqModels") {
            storeModels([ModelInfo(id: "whisper-large-v3-turbo"), ModelInfo(id: "whisper-large-v3"),
                         ModelInfo(id: "llama-3.3-70b-versatile")], at: Date())
            lastRefreshError = nil
            return
        }
        #endif
        guard let key = (try? secrets.secret(for: Self.keychainAccount))?.trimmingCharacters(in: .whitespacesAndNewlines),
              !key.isEmpty else {
            lastRefreshError = "Add your Groq API key first."
            return
        }
        do {
            let endpoint = ProviderEndpoint(flavor: .openAIChat, baseURL: GroqEndpoints.baseURL, apiKey: key)
            let models = try await OpenAIChatProvider(endpoint: endpoint, transport: transport).listModels()
            storeModels(models, at: Date())
            lastRefreshError = nil
        } catch let error as ProviderError {
            lastRefreshError = Self.refreshErrorMessage(error)
        } catch is CancellationError {
            lastRefreshError = nil
        } catch {
            lastRefreshError = "Couldn't load the model list."
        }
    }

    private func storeModels(_ models: [ModelInfo], at date: Date) {
        cachedModels = Self.speechModels(from: models).map(\.id).sorted()
        modelsFetchedAt = date
        if selectedModelID.isEmpty, let first = Self.defaultModel(from: cachedModels) {
            selectedModelID = first
        }
        persist()
    }

    /// User-safe refresh failure. Never includes the key or wire details.
    nonisolated static func refreshErrorMessage(_ error: ProviderError) -> String {
        switch error {
        case .http(let status, _, _):
            if status == 401 { return "Check your Groq API key." }
            if status == 429 { return "Groq is rate-limiting requests. Try again in a bit." }
            return "Groq couldn't list models (HTTP \(status))."
        case .network: return "No connection. The saved list stays until you're back."
        case .decoding, .stream, .invalidConfiguration: return "Couldn't load the model list."
        }
    }

    func selectModel(_ id: String) {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        selectedModelID = trimmed
        persist()
    }

    func setLanguage(_ code: String?) {
        language = code?.isEmpty == true ? nil : code
        persist()
    }

    // MARK: Languages

    /// Common ISO-639-1 codes for the language row (nil = Auto).
    nonisolated static let supportedLanguages: [(code: String?, name: String)] = [
        (nil, "Auto"),
        ("en", "English"), ("es", "Spanish"), ("fr", "French"), ("de", "German"),
        ("it", "Italian"), ("pt", "Portuguese"), ("nl", "Dutch"), ("pl", "Polish"),
        ("ru", "Russian"), ("uk", "Ukrainian"), ("tr", "Turkish"), ("ar", "Arabic"),
        ("hi", "Hindi"), ("zh", "Chinese"), ("ja", "Japanese"), ("ko", "Korean"),
    ]

    nonisolated static func languageName(for code: String?) -> String {
        supportedLanguages.first { $0.code == code }?.name ?? code ?? "Auto"
    }

    // MARK: Transcriber (final voice integration wiring)

    /// Builds a transcriber snapshotting the CURRENT model and language.
    /// Build one per transcription call: the model, language and consent
    /// may all have changed since the controller was created (in particular
    /// the consent allow-path retries after a grant). The key itself is read
    /// per call inside `transcribe`, never held here.
    func makeTranscriber(consentGranted: Bool,
                         onEvent: (@Sendable (TranscriptionEvent) -> Void)? = nil) -> GroqTranscriber {
        GroqTranscriber(transport: transport, secrets: secrets, modelID: selectedModelID,
                       language: language, consentGranted: consentGranted, onEvent: onEvent)
    }

    // MARK: Persistence (no secrets in the JSON, ever)

    private func persist() {
        guard let fileURL else { return }
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(File(selectedModelID: selectedModelID, language: language,
                                    cachedModels: cachedModels, modelsFetchedAt: modelsFetchedAt))
                .write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            assertionFailure("GroqVoiceSettings write failed: \(error)")
        }
    }
}
