import Foundation
import Observation
import AgentCore
import AgentProviders
import AgentMCP

/// One configured model endpoint. Everything here is safe to write to
/// disk: `ProviderEndpoint`'s Codable form never carries the API key,
/// which lives in the Keychain under `ProviderSettings.keychainKey(for:)`,
/// and secret-like extra header values are blanked on save into the
/// Keychain the same way (`headerKeychainKey(for:header:)`).
struct ProviderProfile: Codable, Identifiable, Hashable, Sendable {
    var id: UUID
    var name: String
    /// Where the defaults came from; nothing downstream checks it.
    var preset: ProviderPreset
    /// Base URL, headers, capability overrides, wire options. Key always empty.
    var endpoint: ProviderEndpoint
    /// The model new turns use (the tray's model picker writes it).
    var defaultModel: String

    init(id: UUID = UUID(), name: String, preset: ProviderPreset, endpoint: ProviderEndpoint, defaultModel: String) {
        self.id = id
        self.name = name
        self.preset = preset
        var endpoint = endpoint
        endpoint.apiKey = ""
        self.endpoint = endpoint
        self.defaultModel = defaultModel
    }

    /// A new profile with the preset's defaults; custom presets still
    /// need a base URL before they can be saved.
    static func draft(_ preset: ProviderPreset) -> ProviderProfile {
        let endpoint = preset.endpoint() ?? ProviderEndpoint(
            flavor: preset.flavor, baseURL: URL(string: "http://localhost:1234/v1")!,
            capabilities: preset.defaultCapabilities, anthropic: preset.defaultAnthropicOptions,
            openAI: preset.defaultOpenAIOptions)
        return ProviderProfile(name: preset.displayName, preset: preset, endpoint: endpoint, defaultModel: "")
    }
}

/// Settings → Image reading model: the profile + model that looks at
/// images for chat models without image input (`look_at_image`).
struct ImageReaderChoice: Codable, Hashable, Sendable {
    var profileID: UUID
    var model: String
}

/// What a live run needs from settings, resolved at send time.
struct ProviderSelection: Sendable {
    var profileID: UUID
    var profileName: String
    /// With the API key filled in.
    var endpoint: ProviderEndpoint
    var model: String
    var maxOutputTokens: Int?
    /// The model's context window when the server lists it.
    var contextWindow: Int? = nil
    /// What the app knows about the model's image input. `endpoint`'s
    /// `vision` capability already follows it (off only when `.unsupported`).
    var imageSupport: ImageSupport = .supported
    /// What the app knows about the model's tool use. `endpoint`'s `tools`
    /// capability already follows it (off only when `.unsupported`).
    var toolSupport: ToolUseSupport = .supported
    /// The model's display name (its id when the list has none).
    var modelName: String = ""
}

/// Whether a chat model takes image input, as far as the app knows. Per
/// model, because one provider (OpenRouter) mixes both kinds.
enum ImageSupport: Sendable, Equatable {
    /// The model list says it takes images.
    case supported
    /// Nothing says either way: the list is missing, predates the flag, or
    /// the server doesn't report modalities. Images are tried (a model is
    /// only treated as blind once that's confirmed); the first rejection
    /// settles it (`ProviderSettings.markImagesUnsupported`).
    case unknown
    /// Confirmed: the profile's vision capability is off, the list says
    /// text-only, or the provider turned images down. Images go out as
    /// placeholders.
    case unsupported
}

/// Whether a chat model takes tool use, as far as the app knows. Per
/// model, because one provider (OpenRouter) mixes both kinds. Named for
/// the capability, since `ToolSupport` is the package's rejection matcher.
enum ToolUseSupport: Sendable, Equatable {
    /// The model list says it takes tools.
    case supported
    /// Nothing says either way: the list is missing, predates the flag, or
    /// the server doesn't report parameters. Tools are tried (a model is
    /// only treated as plain-chat once that's confirmed); the first
    /// rejection settles it (`ProviderSettings.markToolsUnsupported`).
    case unknown
    /// Confirmed: the profile's tools capability is off, the list says
    /// no tools, or the provider turned tool use down. Requests go out
    /// without tools, with past calls flattened to text.
    case unsupported
}

/// Provider profiles, the selected one, and each profile's model list.
/// Non-secret parts are one JSON file in Application Support; API keys
/// are Keychain items (`AfterFirstUnlockThisDeviceOnly`, via
/// `KeychainSecretStore`) and never touch the JSON, logs or descriptions.
///
/// UI binds to `profiles`, `selectedProfileID`, `models(for:)` and
/// `refreshingModels`; edits go through `save(_:apiKey:)`.
@MainActor
@Observable
final class ProviderSettings {
    private struct File: Codable {
        var version = 1
        var profiles: [ProviderProfile] = []
        var selectedProfileID: UUID?
        /// Last `listModels()` result per profile.
        var models: [UUID: [ModelInfo]] = [:]
        var imageReader: ImageReaderChoice?
        /// Optional, so files from before these existed still decode.
        var modelsFetchedAt: [UUID: Date]?
        var imageRejections: [UUID: [String: Date]]?
        var toolRejections: [UUID: [String: Date]]?
    }

    private(set) var profiles: [ProviderProfile] = []
    private(set) var selectedProfileID: UUID?
    private(set) var modelCache: [UUID: [ModelInfo]] = [:]
    /// Profiles whose model list is loading.
    private(set) var refreshingModels: Set<UUID> = []
    /// Last model-list error per profile (cleared by a successful refresh).
    private(set) var modelErrors: [UUID: String] = [:]
    /// The image-reading model, if the user picked one.
    private(set) var imageReader: ImageReaderChoice?
    /// When each profile's model list was last read successfully. Absent =
    /// a list cached before this was recorded (it predates the image flag
    /// too): stale.
    private(set) var modelsFetchedAt: [UUID: Date] = [:]
    /// Models a provider turned image input down for, by profile and when
    /// (`markImagesUnsupported`). Persisted: the next send already uses
    /// placeholders instead of failing once more.
    private(set) var imageRejections: [UUID: [String: Date]] = [:]
    /// Models a provider turned tool use down for, by profile and when
    /// (`markToolsUnsupported`). Persisted: the next send already goes
    /// without tools instead of failing once more.
    private(set) var toolRejections: [UUID: [String: Date]] = [:]

    /// A model list older than this is read again in the background.
    static let modelListLifetime: TimeInterval = 24 * 3600
    /// A learned "no images" lapses after this, so a provider that adds
    /// image support later is noticed (the list flipping to image-capable
    /// clears it sooner, `store(_:for:)`).
    static let imageRejectionLifetime: TimeInterval = 14 * 24 * 3600
    /// A learned "no tools" lapses after this, so a provider that adds
    /// tool support later is noticed (the list flipping to tool-capable
    /// clears it sooner, `store(_:for:)`).
    static let toolRejectionLifetime: TimeInterval = 14 * 24 * 3600
    /// Minimum gap between two list requests to one profile in a session.
    static let refreshRetryGap: TimeInterval = 600

    @ObservationIgnored private var modelsAttemptedAt: [UUID: Date] = [:]
    @ObservationIgnored private var refreshesInFlight: [UUID: Task<[ModelInfo], Never>] = [:]
    @ObservationIgnored let fileURL: URL
    @ObservationIgnored private let secrets: any SecretStore
    @ObservationIgnored let transport: any HTTPTransport

    init(fileURL: URL, secrets: any SecretStore, transport: any HTTPTransport = URLSessionTransport()) {
        self.fileURL = fileURL
        self.secrets = secrets
        self.transport = transport
        if let data = try? Data(contentsOf: fileURL), let file = try? JSONDecoder().decode(File.self, from: data) {
            profiles = file.profiles
            selectedProfileID = file.selectedProfileID.flatMap { id in file.profiles.contains { $0.id == id } ? id : nil }
                ?? file.profiles.first?.id
            modelCache = file.models
            imageReader = file.imageReader.flatMap { choice in file.profiles.contains { $0.id == choice.profileID } ? choice : nil }
            modelsFetchedAt = file.modelsFetchedAt ?? [:]
            imageRejections = file.imageRejections ?? [:]
            toolRejections = file.toolRejections ?? [:]
            migrateHeaderSecretsToKeychain()
        }
    }

    /// Moves secret-like extra-header values left in the JSON by older
    /// builds into the Keychain, blanking them in the file (R3-L4).
    private func migrateHeaderSecretsToKeychain() {
        var moved = false
        for i in profiles.indices {
            for name in profiles[i].endpoint.extraHeaders.keys where Self.isSecretHeaderName(name) {
                guard let value = profiles[i].endpoint.extraHeaders[name], !value.isEmpty else { continue }
                try? secrets.setSecret(value, for: Self.headerKeychainKey(for: profiles[i].id, header: name))
                profiles[i].endpoint.extraHeaders[name] = ""
                moved = true
            }
        }
        if moved { persist() }
    }

    static let keychainService = "PraxisChat.Providers"

    static func keychainKey(for id: UUID) -> String { "provider.\(id.uuidString).apiKey" }

    /// Keychain account for one secret-like extra header value (R3-L4).
    /// The name is slugified (header names are case-insensitive), so two
    /// rows differing only by case share one secret.
    static func headerKeychainKey(for id: UUID, header name: String) -> String {
        "provider.\(id.uuidString).header.\(headerSlug(name))"
    }

    static func headerSlug(_ name: String) -> String {
        name.lowercased().trimmingCharacters(in: .whitespaces).unicodeScalars.map {
            CharacterSet.alphanumerics.contains($0) ? String($0) : "-"
        }.joined()
    }

    /// Header names whose values are secrets: exact well-known names plus
    /// anything naming a credential. False positives only cost Keychain
    /// storage (sends are unchanged), so this errs broad.
    static func isSecretHeaderName(_ name: String) -> Bool {
        let lower = name.lowercased().trimmingCharacters(in: .whitespaces)
        if ["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"].contains(lower) { return true }
        let markers = ["api-key", "apikey", "api_key", "secret", "token", "password", "passwd", "auth",
                       "credential", "private-key", "access-key"]
        return markers.contains { lower.contains($0) }
    }

    // MARK: Reading

    var hasProfiles: Bool { !profiles.isEmpty }

    var selectedProfile: ProviderProfile? {
        profiles.first { $0.id == selectedProfileID }
    }

    func profile(_ id: UUID) -> ProviderProfile? { profiles.first { $0.id == id } }

    func hasAPIKey(_ id: UUID) -> Bool { !(apiKey(for: id) ?? "").isEmpty }

    func apiKey(for id: UUID) -> String? { try? secrets.secret(for: Self.keychainKey(for: id)) }

    /// The profile's endpoint with its key and header secrets, ready
    /// for `ProviderFactory`.
    func endpoint(for id: UUID) -> ProviderEndpoint? {
        guard var endpoint = profile(id)?.endpoint else { return nil }
        endpoint.apiKey = apiKey(for: id) ?? ""
        for name in endpoint.extraHeaders.keys where Self.isSecretHeaderName(name) {
            if let secret = try? secrets.secret(for: Self.headerKeychainKey(for: id, header: name)), !secret.isEmpty {
                endpoint.extraHeaders[name] = secret
            }
        }
        return endpoint
    }

    /// Cached models, sorted as the server listed them.
    func models(for id: UUID) -> [ModelInfo] { modelCache[id] ?? [] }

    /// What the app knows about a model's image input: off when the
    /// profile's vision capability is off or the provider turned images
    /// down (`markImagesUnsupported`), otherwise what the model list says;
    /// `.unknown` when the list doesn't (nil `ModelInfo.supportsImages`).
    func imageSupport(profileID: UUID, model: String, now: Date = Date()) -> ImageSupport {
        guard let profile = profile(profileID), profile.endpoint.capabilities.vision else { return .unsupported }
        if let learned = imageRejections[profileID]?[model], now.timeIntervalSince(learned) < Self.imageRejectionLifetime {
            return .unsupported
        }
        switch listedImageSupport(profileID: profileID, model: model) {
        case true?: return .supported
        case false?: return .unsupported
        case nil: return .unknown
        }
    }

    /// Whether images should be sent to the model: everything but a
    /// confirmed "no".
    func supportsImages(profileID: UUID, model: String) -> Bool {
        imageSupport(profileID: profileID, model: model) != .unsupported
    }

    /// The model list's own answer (nil = it doesn't say).
    func listedImageSupport(profileID: UUID, model: String) -> Bool? {
        models(for: profileID).first { $0.id == model }?.supportsImages
    }

    /// The selected chat model's image support.
    var selectedImageSupport: ImageSupport {
        guard let profile = selectedProfile else { return .supported }
        return imageSupport(profileID: profile.id, model: profile.defaultModel)
    }

    /// The selected chat model can take images (or might: it isn't ruled out).
    var selectedModelSupportsImages: Bool { selectedImageSupport != .unsupported }

    /// What the app knows about a model's tool use: off when the
    /// profile's tools capability is off or the provider turned tool use
    /// down (`markToolsUnsupported`), otherwise what the model list says;
    /// `.unknown` when the list doesn't (nil `ModelInfo.supportsTools`).
    func toolSupport(profileID: UUID, model: String, now: Date = Date()) -> ToolUseSupport {
        guard let profile = profile(profileID), profile.endpoint.capabilities.tools else { return .unsupported }
        if let learned = toolRejections[profileID]?[model], now.timeIntervalSince(learned) < Self.toolRejectionLifetime {
            return .unsupported
        }
        switch listedToolSupport(profileID: profileID, model: model) {
        case true?: return .supported
        case false?: return .unsupported
        case nil: return .unknown
        }
    }

    /// Whether tools should be offered to the model: everything but a
    /// confirmed "no".
    func supportsTools(profileID: UUID, model: String) -> Bool {
        toolSupport(profileID: profileID, model: model) != .unsupported
    }

    /// The model list's own answer (nil = it doesn't say).
    func listedToolSupport(profileID: UUID, model: String) -> Bool? {
        models(for: profileID).first { $0.id == model }?.supportsTools
    }

    /// The selected chat model's tool support.
    var selectedToolSupport: ToolUseSupport {
        guard let profile = selectedProfile else { return .supported }
        return toolSupport(profileID: profile.id, model: profile.defaultModel)
    }

    /// The selected chat model can call tools (needed for `look_at_image`).
    /// Per model, like images: a model the list (or a past rejection) rules
    /// out counts as no-tools even when the endpoint allows them.
    var selectedModelSupportsTools: Bool {
        guard selectedProfile != nil else { return false }
        return selectedToolSupport != .unsupported
    }

    /// The image reader's profile, endpoint (with key) and model, when set
    /// and still valid.
    func imageReaderSelection() -> (profile: ProviderProfile, endpoint: ProviderEndpoint, model: String, info: ModelInfo?)? {
        guard let choice = imageReader, let profile = profile(choice.profileID),
              let endpoint = endpoint(for: choice.profileID), !choice.model.isEmpty else { return nil }
        return (profile, endpoint, choice.model, models(for: profile.id).first { $0.id == choice.model })
    }

    /// "OpenRouter · GPT-5 mini" for the composer and Settings.
    var imageReaderDisplayName: String? {
        guard let reader = imageReaderSelection() else { return nil }
        return "\(reader.profile.name) · \(reader.info?.displayName ?? reader.model)"
    }

    /// The selected profile and model, or nil when nothing is configured
    /// (live runs then fail fast and point to Settings).
    func selection(model requested: String? = nil) -> ProviderSelection? {
        guard let profile = selectedProfile, var endpoint = endpoint(for: profile.id) else { return nil }
        let model = (requested?.isEmpty == false ? requested : nil) ?? profile.defaultModel
        guard !model.isEmpty else { return nil }
        let info = models(for: profile.id).first { $0.id == model }
        // Vision is per model: a model known to be text-only gets
        // placeholders instead of image bytes (no "no endpoints support
        // image input" failures). Unknown is tried, not assumed blind.
        let support = imageSupport(profileID: profile.id, model: model)
        endpoint.capabilities.vision = support != .unsupported
        // Tools are per model too: a model known not to take them gets a
        // plain request (no "no endpoints support tool use" failures).
        // Unknown tries with tools; the first rejection settles it.
        let tools = toolSupport(profileID: profile.id, model: model)
        endpoint.capabilities.tools = tools != .unsupported
        return ProviderSelection(profileID: profile.id, profileName: profile.name, endpoint: endpoint, model: model,
                                 maxOutputTokens: info?.maxOutputTokens, contextWindow: info?.contextWindow,
                                 imageSupport: support, toolSupport: tools, modelName: info?.displayName ?? model)
    }

    // MARK: Editing

    /// Adds or replaces a profile. `apiKey`: nil keeps the stored key,
    /// empty removes it. The first profile becomes the selected one.
    func save(_ profile: ProviderProfile, apiKey: String?) throws {
        var profile = profile
        profile.endpoint.apiKey = ""
        if let apiKey {
            let key = Self.keychainKey(for: profile.id)
            let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { try secrets.removeSecret(for: key) } else { try secrets.setSecret(trimmed, for: key) }
        }
        // Secret-like header values live in the Keychain like the API key;
        // the file keeps only their names (blanked). A blanked row coming
        // back keeps its secret (the editor never shows the value); a
        // removed row forgets it.
        let incomingSlugs = Set(profile.endpoint.extraHeaders.keys.filter { Self.isSecretHeaderName($0) }
            .map(Self.headerSlug(_:)))
        if let old = profiles.first(where: { $0.id == profile.id }) {
            for name in old.endpoint.extraHeaders.keys
                where Self.isSecretHeaderName(name) && !incomingSlugs.contains(Self.headerSlug(name)) {
                try? secrets.removeSecret(for: Self.headerKeychainKey(for: profile.id, header: name))
            }
        }
        for name in profile.endpoint.extraHeaders.keys where Self.isSecretHeaderName(name) {
            if let value = profile.endpoint.extraHeaders[name], !value.isEmpty {
                try secrets.setSecret(value, for: Self.headerKeychainKey(for: profile.id, header: name))
            }
            profile.endpoint.extraHeaders[name] = ""
        }
        if let i = profiles.firstIndex(where: { $0.id == profile.id }) {
            // A different server means the cached list belongs to the old one.
            if profiles[i].endpoint.baseURL != profile.endpoint.baseURL || profiles[i].endpoint.flavor != profile.endpoint.flavor {
                modelCache[profile.id] = nil
                modelsFetchedAt[profile.id] = nil
                imageRejections[profile.id] = nil
                toolRejections[profile.id] = nil
            }
            profiles[i] = profile
        } else {
            profiles.append(profile)
        }
        if selectedProfileID == nil { selectedProfileID = profile.id }
        persist()
    }

    func delete(_ id: UUID) {
        try? secrets.removeSecret(for: Self.keychainKey(for: id))
        if let doomed = profiles.first(where: { $0.id == id }) {
            for name in doomed.endpoint.extraHeaders.keys where Self.isSecretHeaderName(name) {
                try? secrets.removeSecret(for: Self.headerKeychainKey(for: id, header: name))
            }
        }
        profiles.removeAll { $0.id == id }
        modelCache[id] = nil
        modelErrors[id] = nil
        modelsFetchedAt[id] = nil
        imageRejections[id] = nil
        toolRejections[id] = nil
        refreshesInFlight.removeValue(forKey: id)?.cancel()
        if selectedProfileID == id { selectedProfileID = profiles.first?.id }
        if imageReader?.profileID == id { imageReader = nil }
        persist()
    }

    /// Settings → Image reading model. Nil turns it off.
    func setImageReader(_ choice: ImageReaderChoice?) {
        guard choice != imageReader else { return }
        if let choice, !profiles.contains(where: { $0.id == choice.profileID }) { return }
        imageReader = choice
        persist()
    }

    func select(_ id: UUID) {
        guard profiles.contains(where: { $0.id == id }) else { return }
        selectedProfileID = id
        persist()
    }

    /// The model new turns use for this profile.
    func setModel(_ model: String, for id: UUID) {
        guard let i = profiles.firstIndex(where: { $0.id == id }), profiles[i].defaultModel != model else { return }
        profiles[i].defaultModel = model
        persist()
    }

    // MARK: Network

    /// Lists the profile's models and caches them. Servers without a model
    /// list leave the cache empty: the UI falls back to manual entry. A
    /// refresh already under way is joined, not repeated.
    @discardableResult
    func refreshModels(for id: UUID) async -> [ModelInfo] {
        if let running = refreshesInFlight[id] { return await running.value }
        guard let endpoint = endpoint(for: id) else { return models(for: id) }
        modelsAttemptedAt[id] = Date()
        refreshingModels.insert(id)
        let transport = transport
        let task = Task { @MainActor [self] () -> [ModelInfo] in
            defer {
                refreshingModels.remove(id)
                refreshesInFlight[id] = nil
            }
            do {
                let listed = try await ProviderFactory.make(endpoint, transport: transport).listModels()
                store(listed, for: id)
                return listed
            } catch {
                modelErrors[id] = (error as? ProviderError)?.description ?? error.localizedDescription
                return models(for: id)
            }
        }
        refreshesInFlight[id] = task
        return await task.value
    }

    /// The profile's list is missing, older than a day, or from before
    /// lists carried image support (no read time recorded).
    func modelListIsStale(_ id: UUID, now: Date = Date()) -> Bool {
        guard let fetched = modelsFetchedAt[id] else { return true }
        return now.timeIntervalSince(fetched) > Self.modelListLifetime
    }

    private func mayRequestModelList(_ id: UUID, now: Date = Date()) -> Bool {
        guard let last = modelsAttemptedAt[id] else { return true }
        return now.timeIntervalSince(last) > Self.refreshRetryGap
    }

    /// Reads, in the background, every profile's model list that's stale
    /// (see `modelListIsStale`). Call at launch: it's what keeps cached
    /// lists from predating the image flag forever.
    func refreshStaleModelListsInBackground(now: Date = Date()) {
        for profile in profiles where modelListIsStale(profile.id, now: now) && mayRequestModelList(profile.id, now: now) {
            let id = profile.id
            Task { await refreshModels(for: id) }
        }
    }

    /// Before a send with images: when the selected model's image support
    /// isn't known, waits (up to `timeout`; the read goes on after that) for
    /// a current model list, so a text-only model is recognized before
    /// anything is sent. A no-op when the answer is already known, or the
    /// list was just asked for.
    func refreshForImages(model requested: String?, timeout: Duration = .seconds(4)) async {
        guard let profile = selectedProfile else { return }
        let model = (requested?.isEmpty == false ? requested : nil) ?? profile.defaultModel
        guard !model.isEmpty, imageSupport(profileID: profile.id, model: model) == .unknown else { return }
        let id = profile.id
        guard refreshesInFlight[id] != nil || mayRequestModelList(id) else { return }
        let work = Task { await refreshModels(for: id) }
        let (finished, signal) = AsyncStream<Void>.makeStream()
        let waiter = Task {
            _ = await work.value
            signal.yield()
            signal.finish()
        }
        let timer = Task {
            try? await Task.sleep(for: timeout)
            signal.yield()
            signal.finish()
        }
        for await _ in finished { break }
        waiter.cancel()
        timer.cancel()
    }

    /// The provider turned image input down for this model (a "no endpoints
    /// support image input" style error): remember it, so this and later
    /// chats send placeholders from the start. Lapses on its own after
    /// `imageRejectionLifetime`, or when the model list says the model
    /// gained image input.
    func markImagesUnsupported(profileID: UUID, model: String, now: Date = Date()) {
        guard profiles.contains(where: { $0.id == profileID }), !model.isEmpty else { return }
        imageRejections[profileID, default: [:]][model] = now
        persist()
    }

    /// The provider turned tool use down for this model (a "no endpoints
    /// support tool use" style error): remember it, so this and later
    /// chats send plain requests from the start. Lapses on its own after
    /// `toolRejectionLifetime`, or when the model list says the model
    /// gained tool support.
    func markToolsUnsupported(profileID: UUID, model: String, now: Date = Date()) {
        guard profiles.contains(where: { $0.id == profileID }), !model.isEmpty else { return }
        toolRejections[profileID, default: [:]][model] = now
        persist()
    }

    /// "Test connection" for a draft that may not be saved yet.
    func test(_ endpoint: ProviderEndpoint, model: String?) async -> ProbeReport {
        await ProviderProbe(transport: transport).test(endpoint, model: model?.isEmpty == false ? model : nil)
    }

    /// Caches a model list for a saved profile.
    func store(_ models: [ModelInfo], for id: UUID, now: Date = Date()) {
        guard profiles.contains(where: { $0.id == id }) else { return }
        // A learned rejection is forgotten when the list newly says the
        // model takes images (it went from text-only to image-capable). One
        // that merely disagrees with an unchanged list stays: that's a
        // provider whose routed endpoints lack what the list advertises.
        if var learned = imageRejections[id], !learned.isEmpty {
            let before = Dictionary((modelCache[id] ?? []).map { ($0.id, $0.supportsImages) }, uniquingKeysWith: { a, _ in a })
            for model in models where model.supportsImages == true && (before[model.id] ?? nil) == false {
                learned[model.id] = nil
            }
            imageRejections[id] = learned.isEmpty ? nil : learned
        }
        if var learned = toolRejections[id], !learned.isEmpty {
            let before = Dictionary((modelCache[id] ?? []).map { ($0.id, $0.supportsTools) }, uniquingKeysWith: { a, _ in a })
            for model in models where model.supportsTools == true && (before[model.id] ?? nil) == false {
                learned[model.id] = nil
            }
            toolRejections[id] = learned.isEmpty ? nil : learned
        }
        modelCache[id] = models
        modelsFetchedAt[id] = now
        modelErrors[id] = nil
        persist()
    }

    // MARK: Persistence

    private func persist() {
        let file = File(profiles: profiles, selectedProfileID: selectedProfileID, models: modelCache, imageReader: imageReader,
                       modelsFetchedAt: modelsFetchedAt, imageRejections: imageRejections, toolRejections: toolRejections)
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys]
            try encoder.encode(file).write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            assertionFailure("ProviderSettings write failed: \(error)")
        }
    }
}
