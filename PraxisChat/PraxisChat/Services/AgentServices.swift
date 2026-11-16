import Foundation
import AgentCore
import AgentProviders
import AgentMCP
import AgentSkills
import AgentRuntime

/// Singleton agent stack; exists in all engine modes so Settings can switch demo to live.
@MainActor
final class AgentServices {
    let settings: ProviderSettings
    let connectors: ConnectorLibrary
    let skills: SkillLibrary
    let elicitations: ElicitationCenter
    let runtime: AgentRuntime
    let attachments: AttachmentStore
    let consent: AIDataConsent
    let voice: GroqVoiceSettings

    /// Default consent is an empty in-memory store; live sends prompt unless caller grants a host.
    init(settings: ProviderSettings, connectors: ConnectorLibrary, skills: SkillLibrary,
         elicitations: ElicitationCenter, providerTransport: any HTTPTransport = URLSessionTransport(),
         attachments: AttachmentStore = .shared, consent: AIDataConsent = AIDataConsent(fileURL: nil),
         scratch: ScratchStore? = nil,
         voice: GroqVoiceSettings = GroqVoiceSettings(fileURL: nil, secrets: InMemorySecretStore())) {
        self.settings = settings
        self.connectors = connectors
        self.skills = skills
        self.elicitations = elicitations
        self.attachments = attachments
        self.consent = consent
        self.voice = voice
        // Runtime fetches connector clients per prepare/run so edits apply immediately.
        self.runtime = AgentRuntime(skillStore: skills.store, providerTransport: providerTransport, scratch: scratch,
                                    mcpClient: { [weak connectors] id in await connectors?.client(for: id) })
    }

    static func live() -> AgentServices {
        let elicitations = ElicitationCenter()
        let services = AgentServices(
            settings: ProviderSettings(fileURL: AppDirectories.providers,
                                       secrets: KeychainSecretStore(service: ProviderSettings.keychainService)),
            connectors: ConnectorLibrary(fileURL: AppDirectories.connectors,
                                         secrets: KeychainSecretStore(service: "PraxisChat.MCP"),
                                         auth: MCPAuthEnvironment(presenter: WebAuthenticationPresenter()),
                                         elicitation: elicitations, listensForChanges: true),
            skills: SkillLibrary(importedDirectory: AppDirectories.importedSkills,
                                 registriesFileURL: AppDirectories.skillRegistries,
                                 registryCache: AppDirectories.skillRegistryCache),
            elicitations: elicitations,
            consent: AIDataConsent(fileURL: AppDirectories.consent),
            scratch: ScratchStore(root: AppDirectories.runtimeScratch,
                                  writingOptions: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]),
            voice: GroqVoiceSettings(fileURL: AppDirectories.voiceSettings,
                                     secrets: KeychainSecretStore(service: GroqVoiceSettings.keychainService)))
        // Refreshes pre-vision or >1d model caches so image support reflects server state.
        services.settings.refreshStaleModelListsInBackground()
        return services
    }

    func makeEngine() -> LiveChatEngine {
        let settings = settings
        var engine = LiveChatEngine(runtime: runtime,
                                    resolve: { model in await settings.selection(model: model) },
                                    attachments: attachments)
        let consent = consent
        engine.mayShare = { url in await consent.isGranted(baseURL: url) }
        engine.imageReader = { await Self.imageReaderAccess(settings: settings, consent: consent) }
        engine.prepareForImages = { model in await settings.refreshForImages(model: model) }
        engine.onImagesRejected = { selection in
            await settings.markImagesUnsupported(profileID: selection.profileID, model: selection.model)
        }
        engine.onToolsRejected = { selection in
            await settings.markToolsUnsupported(profileID: selection.profileID, model: selection.model)
        }
        engine.onEffortRejected = { selection in
            await settings.markEffortUnsupported(profileID: selection.profileID, model: selection.model)
        }
        engine.onEffortValueRejected = { selection, value in
            await settings.markEffortValueUnsupported(profileID: selection.profileID, model: selection.model, value: value)
        }
        return engine
    }

    /// Returns the Settings image reader only if its key exists and host has consent.
    static func imageReaderAccess(settings: ProviderSettings, consent: AIDataConsent) -> ImageReaderAccess {
        guard let reader = settings.imageReaderSelection() else { return .notConfigured }
        let displayName = settings.imageReaderDisplayName ?? reader.model
        // Skip readers known to be text-only (by list or prior rejection) to avoid repeat failures.
        guard settings.imageSupport(profileID: reader.profile.id, model: reader.model) != .unsupported else {
            return .unavailable(ImageReaderAccess.readerCantSeeImagesMessage(displayName))
        }
        let host = AIDataConsent.host(of: reader.endpoint.baseURL)
        guard consent.isGranted(host) else {
            return .unavailable("Sending images to \(host) (the image-reading model's provider) hasn't been allowed yet. Tell the user to open Settings → Image reading model and allow it.")
        }
        let profileID = reader.profile.id
        let model = reader.model
        return .ready(ImageReader(endpoint: reader.endpoint, model: model, displayName: displayName,
                                  maxOutputTokens: reader.info?.maxOutputTokens,
                                  onImagesRejected: { await settings.markImagesUnsupported(profileID: profileID, model: model) }))
    }

    /// Host/name needing consent before sending, or nil if allowed or no provider (fails fast).
    func consentNeeded() -> (host: String, providerName: String)? {
        guard let profile = settings.selectedProfile else { return nil }
        let host = AIDataConsent.host(of: profile.endpoint.baseURL)
        return consent.isGranted(host) ? nil : (host, profile.name)
    }

    /// UI test hook: keyless profile at -PraxisTestProviderURL; consent blocks actual sends.
    func installTestProviderIfRequested() {
        guard let raw = UserDefaults.standard.string(forKey: "PraxisTestProviderURL"), let url = URL(string: raw),
              !settings.profiles.contains(where: { $0.endpoint.baseURL == url }) else { return }
        var profile = ProviderProfile.draft(.customOpenAI)
        profile.name = "Test provider"
        profile.endpoint.baseURL = url
        profile.defaultModel = "test-model"
        try? settings.save(profile, apiKey: nil)
    }

    /// Deletes spilled output and JS kv on disk now; runner drops in-memory state on its thread.
    func forget(conversationID: UUID) {
        let id = conversationID.uuidString
        runtime.spills.remove(conversationID: id)
        let runtime = runtime
        Task { await runtime.forget(conversationID: id) }
    }

    /// Prunes state for deleted conversations (e.g. in-flight writes) off the main actor.
    func pruneRuntimeState(keeping conversationIDs: [UUID]) {
        guard let scratch = runtime.scratch else { return }
        let keep = Set(conversationIDs.map(\.uuidString))
        Task.detached(priority: .utility) { scratch.removeAll(except: keep) }
    }

    var isWebSearchAvailable: Bool {
        guard let profile = settings.selectedProfile else { return false }
        return AgentRuntime.isWebSearchAvailable(on: profile.endpoint)
    }
}
