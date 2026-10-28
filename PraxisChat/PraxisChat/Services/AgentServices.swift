import Foundation
import AgentCore
import AgentProviders
import AgentMCP
import AgentSkills
import AgentRuntime

/// The app's agent stack, created once at launch: provider settings,
/// connectors, skills, the elicitation queue and the one `AgentRuntime`
/// that ties them together. Exists in every engine mode, so Settings can
/// add a provider while the demo is running (the store then goes live).
@MainActor
final class AgentServices {
    let settings: ProviderSettings
    let connectors: ConnectorLibrary
    let skills: SkillLibrary
    let elicitations: ElicitationCenter
    let runtime: AgentRuntime
    let attachments: AttachmentStore
    /// Provider hosts allowed to receive chat data.
    let consent: AIDataConsent

    /// `consent` defaults to an in-memory store with nothing allowed:
    /// live sends ask first unless the caller grants a host.
    init(settings: ProviderSettings, connectors: ConnectorLibrary, skills: SkillLibrary,
         elicitations: ElicitationCenter, providerTransport: any HTTPTransport = URLSessionTransport(),
         attachments: AttachmentStore = .shared, consent: AIDataConsent = AIDataConsent(fileURL: nil),
         scratch: ScratchStore? = nil) {
        self.settings = settings
        self.connectors = connectors
        self.skills = skills
        self.elicitations = elicitations
        self.attachments = attachments
        self.consent = consent
        // The runtime asks for a server's client on every prepare/run, so
        // removing or reconfiguring a connector takes effect immediately.
        // `scratch` keeps spilled tool output and JS `kv` across launches.
        self.runtime = AgentRuntime(skillStore: skills.store, providerTransport: providerTransport, scratch: scratch,
                                    mcpClient: { [weak connectors] id in await connectors?.client(for: id) })
    }

    /// The app's services: files in Application Support, secrets in the
    /// Keychain, sign-in through `ASWebAuthenticationSession`.
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
                                  writingOptions: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]))
        // Model lists cached before they carried image support (or more
        // than a day ago) are read again, so "can it see images?" is
        // answered from the server's current list, not a stale one.
        services.settings.refreshStaleModelListsInBackground()
        return services
    }

    /// The live engine bound to these services.
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

    /// What `look_at_image` may use this run: the reader from Settings,
    /// when its key is there and its host may receive chat data.
    static func imageReaderAccess(settings: ProviderSettings, consent: AIDataConsent) -> ImageReaderAccess {
        guard let reader = settings.imageReaderSelection() else { return .notConfigured }
        let displayName = settings.imageReaderDisplayName ?? reader.model
        // A reader known to be text-only (its list says so, or its provider
        // turned an image down before) would only fail again.
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

    /// The selected provider's host when chat data can't go there yet
    /// (no consent), with the profile name to show; nil when a send may
    /// proceed (allowed, or no provider: that run fails fast and sends
    /// nothing).
    func consentNeeded() -> (host: String, providerName: String)? {
        guard let profile = settings.selectedProfile else { return nil }
        let host = AIDataConsent.host(of: profile.endpoint.baseURL)
        return consent.isGranted(host) ? nil : (host, profile.name)
    }

    /// `-PraxisTestProviderURL <url>` (UI tests): a keyless OpenAI-style
    /// profile at that URL, so live mode can be exercised without a real
    /// provider. Point it at an unroutable host; consent stops the send
    /// before anything goes out.
    func installTestProviderIfRequested() {
        guard let raw = UserDefaults.standard.string(forKey: "PraxisTestProviderURL"), let url = URL(string: raw),
              !settings.profiles.contains(where: { $0.endpoint.baseURL == url }) else { return }
        var profile = ProviderProfile.draft(.customOpenAI)
        profile.name = "Test provider"
        profile.endpoint.baseURL = url
        profile.defaultModel = "test-model"
        try? settings.save(profile, apiKey: nil)
    }

    /// A deleted conversation's runtime state: spilled tool output and
    /// the JS key-value store. Files go right away; the runner drops its
    /// in-memory copy on its own thread.
    func forget(conversationID: UUID) {
        let id = conversationID.uuidString
        runtime.spills.remove(conversationID: id)
        let runtime = runtime
        Task { await runtime.forget(conversationID: id) }
    }

    /// Drops runtime state of conversations that no longer exist (deleted
    /// while a write was in flight, or files lost). Runs off the main actor.
    func pruneRuntimeState(keeping conversationIDs: [UUID]) {
        guard let scratch = runtime.scratch else { return }
        let keep = Set(conversationIDs.map(\.uuidString))
        Task.detached(priority: .utility) { scratch.removeAll(except: keep) }
    }

    /// Whether the web-search toggle means anything for the selected provider.
    var isWebSearchAvailable: Bool {
        guard let profile = settings.selectedProfile else { return false }
        return AgentRuntime.isWebSearchAvailable(on: profile.endpoint)
    }
}
