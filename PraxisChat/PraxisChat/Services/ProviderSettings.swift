import Foundation
import Observation
import AgentCore
import AgentProviders
import AgentMCP

/// Safe to persist: API keys and secret-like headers live in Keychain and are blanked on disk.
struct ProviderProfile: Codable, Identifiable, Hashable, Sendable {
    var id: UUID
    var name: String
    /// Provenance only; nothing downstream branches on preset.
    var preset: ProviderPreset
    /// Endpoint config without secrets (API key is always empty in persisted form).
    var endpoint: ProviderEndpoint
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

    static func draft(_ preset: ProviderPreset) -> ProviderProfile {
        let endpoint = preset.endpoint() ?? ProviderEndpoint(
            flavor: preset.flavor, baseURL: URL(string: "http://localhost:1234/v1")!,
            capabilities: preset.defaultCapabilities, anthropic: preset.defaultAnthropicOptions,
            openAI: preset.defaultOpenAIOptions)
        return ProviderProfile(name: preset.displayName, preset: preset, endpoint: endpoint, defaultModel: "")
    }
}

struct ImageReaderChoice: Codable, Hashable, Sendable {
    var profileID: UUID
    var model: String
}

struct ProviderSelection: Sendable {
    var profileID: UUID
    var profileName: String
    /// Resolved endpoint with API key and header secrets populated.
    var endpoint: ProviderEndpoint
    var model: String
    var maxOutputTokens: Int?
    var contextWindow: Int? = nil
    /// Known image input support; endpoint.vision is already disabled when .unsupported.
    var imageSupport: ImageSupport = .supported
    /// Known tool-use support; endpoint.tools is already disabled when .unsupported.
    var toolSupport: ToolUseSupport = .supported
    var modelName: String = ""
    /// Supported effort values: nil = unknown (send as-is), empty = unsupported (drop parameter).
    var effortLevels: [String]?
}

/// Per-model image support, since multi-model providers (e.g. OpenRouter) mix capabilities.
enum ImageSupport: Sendable, Equatable {
    case supported
    /// Unspecified by server; images are attempted until a rejection confirms unsupported.
    case unknown
    /// Confirmed blind (capability off, listed text-only, or rejected); sends placeholders.
    case unsupported
}

/// Per-model tool support (OpenRouter mixes models); named to avoid colliding with ToolSupport.
enum ToolUseSupport: Sendable, Equatable {
    case supported
    /// Unspecified by server; tools are attempted until a rejection confirms unsupported.
    case unknown
    /// Confirmed no-tools (capability off, listed, or rejected); omits tools and flattens history.
    case unsupported
}

/// Narrowed effort levels learned from a rejection; timestamped so they lapse if updated.
struct LearnedEffortLevels: Sendable, Equatable, Codable {
    /// Supported wire values; empty = the parameter itself was rejected.
    var levels: [String]
    var learnedAt: Date
}

/// Persists profiles as JSON; secrets stay in Keychain (AfterFirstUnlockThisDeviceOnly).
@MainActor
@Observable
final class ProviderSettings {
    private struct File: Codable {
        var version = 1
        var profiles: [ProviderProfile] = []
        var selectedProfileID: UUID?
        var models: [UUID: [ModelInfo]] = [:]
        var imageReader: ImageReaderChoice?
        /// Optional, so files from before these existed still decode.
        var modelsFetchedAt: [UUID: Date]?
        var imageRejections: [UUID: [String: Date]]?
        var toolRejections: [UUID: [String: Date]]?
        var pinnedModels: [UUID: [String]]?
        var learnedEffortLevels: [UUID: [String: LearnedEffortLevels]]?
    }

    private(set) var profiles: [ProviderProfile] = []
    private(set) var selectedProfileID: UUID?
    private(set) var modelCache: [UUID: [ModelInfo]] = [:]
    private(set) var refreshingModels: Set<UUID> = []
    private(set) var modelErrors: [UUID: String] = [:]
    private(set) var imageReader: ImageReaderChoice?
    /// Last model-list fetch time; absent means pre-vision legacy cache (treated as stale).
    private(set) var modelsFetchedAt: [UUID: Date] = [:]
    /// Persisted image-input rejections by model so subsequent sends use placeholders immediately.
    private(set) var imageRejections: [UUID: [String: Date]] = [:]
    /// Persisted tool-use rejections by model so subsequent sends omit tools immediately.
    private(set) var toolRejections: [UUID: [String: Date]] = [:]
    /// Pinned models in pin order; unlisted pins stay until explicitly unpinned or profile deleted.
    private(set) var pinnedModelIDs: [UUID: [String]] = [:]
    /// Persisted effort-level rejections so subsequent sends clamp immediately without failing.
    private(set) var learnedEffortLevels: [UUID: [String: LearnedEffortLevels]] = [:]

    static let modelListLifetime: TimeInterval = 24 * 3600
    /// Lapses learned image rejections after 14d (or sooner if model list flips to image-capable).
    static let imageRejectionLifetime: TimeInterval = 14 * 24 * 3600
    /// Lapses learned tool rejections after 14d (or sooner if model list flips to tool-capable).
    static let toolRejectionLifetime: TimeInterval = 14 * 24 * 3600
    /// Lapses learned effort levels after 14d (or sooner if model list reports changed levels).
    static let effortRejectionLifetime: TimeInterval = 14 * 24 * 3600
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
            pinnedModelIDs = file.pinnedModels ?? [:]
            learnedEffortLevels = file.learnedEffortLevels ?? [:]
            migrateHeaderSecretsToKeychain()
        }
    }

    /// Migrates legacy plaintext secret headers from JSON into Keychain, blanking JSON values.
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

    /// Fixed storage key for demo-mode model pins before any provider is configured.
    static let demoProfileID = UUID(uuidString: "00000000-0000-0000-0000-0000000000a1")!

    static let keychainService = "PraxisChat.Providers"

    static func keychainKey(for id: UUID) -> String { "provider.\(id.uuidString).apiKey" }

    /// Keychain key for a secret header; slugified so case-only variants share one secret.
    static func headerKeychainKey(for id: UUID, header name: String) -> String {
        "provider.\(id.uuidString).header.\(headerSlug(name))"
    }

    static func headerSlug(_ name: String) -> String {
        name.lowercased().trimmingCharacters(in: .whitespaces).unicodeScalars.map {
            CharacterSet.alphanumerics.contains($0) ? String($0) : "-"
        }.joined()
    }

    /// Errs broad on secret-header detection; false positives only move storage to Keychain.
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

    func models(for id: UUID) -> [ModelInfo] { modelCache[id] ?? [] }

    /// Precedence: capability off / fresh rejection -> .unsupported, else list value or .unknown.
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

    func supportsImages(profileID: UUID, model: String) -> Bool {
        imageSupport(profileID: profileID, model: model) != .unsupported
    }

    func listedImageSupport(profileID: UUID, model: String) -> Bool? {
        models(for: profileID).first { $0.id == model }?.supportsImages
    }

    var selectedImageSupport: ImageSupport {
        guard let profile = selectedProfile else { return .supported }
        return imageSupport(profileID: profile.id, model: profile.defaultModel)
    }

    var selectedModelSupportsImages: Bool { selectedImageSupport != .unsupported }

    /// Precedence: capability off / fresh rejection -> .unsupported, else list value or .unknown.
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

    func supportsTools(profileID: UUID, model: String) -> Bool {
        toolSupport(profileID: profileID, model: model) != .unsupported
    }

    func listedToolSupport(profileID: UUID, model: String) -> Bool? {
        models(for: profileID).first { $0.id == model }?.supportsTools
    }

    var selectedToolSupport: ToolUseSupport {
        guard let profile = selectedProfile else { return .supported }
        return toolSupport(profileID: profile.id, model: profile.defaultModel)
    }

    var selectedModelSupportsTools: Bool {
        guard selectedProfile != nil else { return false }
        return selectedToolSupport != .unsupported
    }

    // MARK: Pinned models

    func pinnedModels(for id: UUID) -> [String] { pinnedModelIDs[id] ?? [] }

    func isPinned(profileID: UUID, model: String) -> Bool {
        pinnedModelIDs[profileID]?.contains(model) ?? false
    }

    /// Appends new pins and preserves order on unpin; requires profile except for demoProfileID.
    func setPinned(_ pinned: Bool, profileID: UUID, model: String) {
        guard !model.isEmpty,
              profileID == Self.demoProfileID || profiles.contains(where: { $0.id == profileID }) else { return }
        var ids = pinnedModelIDs[profileID] ?? []
        if pinned {
            guard !ids.contains(model) else { return }
            ids.append(model)
        } else {
            guard ids.contains(model) else { return }
            ids.removeAll { $0 == model }
        }
        pinnedModelIDs[profileID] = ids.isEmpty ? nil : ids
        persist()
    }

    /// Precedence: off/rejected -> [], learned narrowing, listed levels, else nil (send as-is).
    func effortWireValues(profileID: UUID, model: String, now: Date = Date()) -> [String]? {
        guard let profile = profile(profileID), profile.endpoint.capabilities.reasoningEffort else { return [] }
        if let learned = learnedEffortLevels[profileID]?[model],
           now.timeIntervalSince(learned.learnedAt) < Self.effortRejectionLifetime {
            return learned.levels
        }
        return models(for: profileID).first { $0.id == model }?.reasoningEfforts
    }

    /// Selected model's effort wire values: nil = unknown, [] = reasoning unsupported.
    var selectedEffortWireValues: [String]? {
        guard let profile = selectedProfile else { return nil }
        return effortWireValues(profileID: profile.id, model: profile.defaultModel)
    }

    func imageReaderSelection() -> (profile: ProviderProfile, endpoint: ProviderEndpoint, model: String, info: ModelInfo?)? {
        guard let choice = imageReader, let profile = profile(choice.profileID),
              let endpoint = endpoint(for: choice.profileID), !choice.model.isEmpty else { return nil }
        return (profile, endpoint, choice.model, models(for: profile.id).first { $0.id == choice.model })
    }

    var imageReaderDisplayName: String? {
        guard let reader = imageReaderSelection() else { return nil }
        return "\(reader.profile.name) · \(reader.info?.displayName ?? reader.model)"
    }

    func selection(model requested: String? = nil) -> ProviderSelection? {
        guard let profile = selectedProfile, var endpoint = endpoint(for: profile.id) else { return nil }
        let model = (requested?.isEmpty == false ? requested : nil) ?? profile.defaultModel
        guard !model.isEmpty else { return nil }
        let info = models(for: profile.id).first { $0.id == model }
        // Vision is per model: unknown tries images; only confirmed text-only sends placeholders.
        let support = imageSupport(profileID: profile.id, model: model)
        endpoint.capabilities.vision = support != .unsupported
        // Tools are per model: unknown tries tools; only confirmed unsupported sends plain chat.
        let tools = toolSupport(profileID: profile.id, model: model)
        endpoint.capabilities.tools = tools != .unsupported
        return ProviderSelection(profileID: profile.id, profileName: profile.name, endpoint: endpoint, model: model,
                                 maxOutputTokens: info?.maxOutputTokens, contextWindow: info?.contextWindow,
                                 imageSupport: support, toolSupport: tools, modelName: info?.displayName ?? model,
                                 effortLevels: effortWireValues(profileID: profile.id, model: model))
    }

    // MARK: Editing

    /// Saves profile; apiKey nil keeps stored key, empty deletes it; first profile auto-selects.
    func save(_ profile: ProviderProfile, apiKey: String?) throws {
        var profile = profile
        profile.endpoint.apiKey = ""
        if let apiKey {
            let key = Self.keychainKey(for: profile.id)
            let trimmed = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { try secrets.removeSecret(for: key) } else { try secrets.setSecret(trimmed, for: key) }
        }
        // Blanked secret header keeps existing Keychain value; removing the row deletes the secret.
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
                learnedEffortLevels[profile.id] = nil
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
        pinnedModelIDs[id] = nil
        learnedEffortLevels[id] = nil
        refreshesInFlight.removeValue(forKey: id)?.cancel()
        if selectedProfileID == id { selectedProfileID = profiles.first?.id }
        if imageReader?.profileID == id { imageReader = nil }
        persist()
    }

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

    func setModel(_ model: String, for id: UUID) {
        guard let i = profiles.firstIndex(where: { $0.id == id }), profiles[i].defaultModel != model else { return }
        profiles[i].defaultModel = model
        persist()
    }

    // MARK: Network

    /// Coalesces concurrent refreshes per profile; empty cache lets UI fall back to manual entry.
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

    func modelListIsStale(_ id: UUID, now: Date = Date()) -> Bool {
        guard let fetched = modelsFetchedAt[id] else { return true }
        return now.timeIntervalSince(fetched) > Self.modelListLifetime
    }

    private func mayRequestModelList(_ id: UUID, now: Date = Date()) -> Bool {
        guard let last = modelsAttemptedAt[id] else { return true }
        return now.timeIntervalSince(last) > Self.refreshRetryGap
    }

    /// Refreshes stale caches at launch so legacy pre-vision model lists eventually upgrade.
    func refreshStaleModelListsInBackground(now: Date = Date()) {
        for profile in profiles where modelListIsStale(profile.id, now: now) && mayRequestModelList(profile.id, now: now) {
            let id = profile.id
            Task { await refreshModels(for: id) }
        }
    }

    /// Awaits list up to timeout if image support is unknown (refresh continues on timeout).
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

    /// Records image rejection so future sends use placeholders; lapses in 14d or on list upgrade.
    func markImagesUnsupported(profileID: UUID, model: String, now: Date = Date()) {
        guard profiles.contains(where: { $0.id == profileID }), !model.isEmpty else { return }
        imageRejections[profileID, default: [:]][model] = now
        persist()
    }

    /// Records tool rejection so future sends omit tools; lapses in 14d or on list upgrade.
    func markToolsUnsupported(profileID: UUID, model: String, now: Date = Date()) {
        guard profiles.contains(where: { $0.id == profileID }), !model.isEmpty else { return }
        toolRejections[profileID, default: [:]][model] = now
        persist()
    }

    /// Records effort rejection so future sends omit it; lapses in 14d or when list reports levels.
    func markEffortUnsupported(profileID: UUID, model: String, now: Date = Date()) {
        guard profiles.contains(where: { $0.id == profileID }), !model.isEmpty else { return }
        learnedEffortLevels[profileID, default: [:]][model] = LearnedEffortLevels(levels: [], learnedAt: now)
        persist()
    }

    /// Narrows supported effort values around rejected value; lapses in 14d or on list level change.
    func markEffortValueUnsupported(profileID: UUID, model: String, value: String, now: Date = Date()) {
        guard profiles.contains(where: { $0.id == profileID }), !model.isEmpty else { return }
        let current = effortWireValues(profileID: profileID, model: model, now: now) ?? EffortLevels.unknownBaseline
        learnedEffortLevels[profileID, default: [:]][model] =
            LearnedEffortLevels(levels: EffortLevels.narrow(current, rejecting: value), learnedAt: now)
        persist()
    }

    func test(_ endpoint: ProviderEndpoint, model: String?) async -> ProbeReport {
        await ProviderProbe(transport: transport).test(endpoint, model: model?.isEmpty == false ? model : nil)
    }

    func store(_ models: [ModelInfo], for id: UUID, now: Date = Date()) {
        guard profiles.contains(where: { $0.id == id }) else { return }
        // Clear rejection only if list newly gains support; unchanged list means routed endpoints lag.
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
        // Clear learned levels only if list changes them; unchanged list means routed endpoints lag.
        if var learned = learnedEffortLevels[id], !learned.isEmpty {
            let before = Dictionary((modelCache[id] ?? []).map { ($0.id, $0.reasoningEfforts) }, uniquingKeysWith: { a, _ in a })
            for model in models where model.reasoningEfforts != (before[model.id] ?? nil) {
                learned[model.id] = nil
            }
            learnedEffortLevels[id] = learned.isEmpty ? nil : learned
        }
        modelCache[id] = models
        modelsFetchedAt[id] = now
        modelErrors[id] = nil
        persist()
    }

    // MARK: Persistence

    private func persist() {
        let file = File(profiles: profiles, selectedProfileID: selectedProfileID, models: modelCache, imageReader: imageReader,
                       modelsFetchedAt: modelsFetchedAt, imageRejections: imageRejections, toolRejections: toolRejections,
                       pinnedModels: pinnedModelIDs, learnedEffortLevels: learnedEffortLevels)
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
