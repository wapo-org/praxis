import Foundation
import Observation
import AgentCore
import AgentProviders
import AgentMCP

// MARK: - Frozen voice interface

// Frozen contract consumed by VoiceInputController.
@MainActor
protocol VoiceSettingsReader {
    /// True whenever a key is present, even if the model is still the default.
    var isConfigured: Bool { get }
}

/// Persists voice settings in voice-settings.json (key in Keychain); nil fileURL is in-memory.
@MainActor
@Observable
final class GroqVoiceSettings: VoiceSettingsReader {
    nonisolated static let keychainService = "PraxisChat.Voice"
    nonisolated static let keychainAccount = "groq.apiKey"
    /// Default STT model chosen as fastest and cheapest per Groq STT docs.
    nonisolated static let defaultModelID = "whisper-large-v3-turbo"
    /// Model lists older than 24 h refresh on screen open, matching ProviderSettings.
    nonisolated static let modelListLifetime: TimeInterval = 24 * 3600

    private struct File: Codable {
        var version = 1
        var selectedModelID: String
        var language: String?
        var cachedModels: [String] = []
        var modelsFetchedAt: Date?
    }

    /// Active upload model ID; always non-empty (falls back to default).
    var selectedModelID: String
    /// ISO-639-1 code for the Groq language parameter, or nil for auto-detect.
    var language: String?
    /// Cached STT-filtered model IDs from the last fetch.
    private(set) var cachedModels: [String]
    private(set) var modelsFetchedAt: Date?
    private(set) var hasKey = false
    private(set) var refreshing = false
    /// User-safe message from the last refresh failure, cleared on success.
    private(set) var lastRefreshError: String?

    /// Includes selectedModelID even if unlisted so manually entered or new STT IDs stay selectable.
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

    /// Trims whitespace before saving and deletes the key when empty.
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
            // Re-reads Keychain state so a save failure never leaves hasKey out of sync.
            hasKey = ((try? secrets.secret(for: Self.keychainAccount)) ?? nil)?.isEmpty == false
        }
    }

    func removeKey() { saveKey("") }

    // MARK: Models

    /// Groq omits speech flags, so STT models are filtered by case-insensitive 'whisper' ID.
    nonisolated static func speechModels(from models: [ModelInfo]) -> [ModelInfo] {
        models.filter { $0.id.lowercased().contains("whisper") }
    }

    /// Returns whisper-large-v3-turbo, else first STT ID; nil shows manual-entry UI.
    nonisolated static func defaultModel(from ids: [String]) -> String? {
        if ids.contains(defaultModelID) { return defaultModelID }
        return ids.first
    }

    /// Preserves the stored key on 401; -PraxisFakeGroqModels YES returns a canned UI-test list.
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

    /// Formats a user-safe refresh error without exposing the API key or wire details.
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

    /// Must be called per transcription so mid-session setting or consent changes take effect.
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
