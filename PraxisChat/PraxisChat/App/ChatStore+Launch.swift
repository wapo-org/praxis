import Foundation

extension ChatStore {
    /// Cloud is the default; native execution requires the hidden opt-in.
    static func forLaunch() -> ChatStore {
        if UserDefaults.standard.bool(forKey: "PraxisResetData") { AppDirectories.reset() }
        let override = EngineKind.launchOverride
        if EngineKind.resolve(override: override, hasProvider: false) == .cloud {
            do {
                let configuration = try CloudServerConfiguration.forLaunch()
                var session = URLSession.shared
                var tokens = CloudSessionStore()
                #if DEBUG
                if let stub = CloudTestBackend.makeLaunchSessionIfEnabled() {
                    session = stub
                    // Ephemeral harness credentials must never read real Keychain entries.
                    tokens = CloudSessionStore(inMemory: true)
                }
                #endif
                let client = CloudAPIClient(configuration: configuration, session: session, tokens: tokens)
                let store = makeCloudStore(client: client)
                store.background.installNotificationDelegate()
                store.background.appDidLaunch()
                return store
            } catch {
                return ChatStore(engine: CloudConfigurationErrorEngine(message: error.localizedDescription), conversations: [])
            }
        }
        // Hidden opt-in keeps native services out of default cloud builds.
        let services = AgentServices.live()
        services.installTestProviderIfRequested()
        services.connectors.installMockConnectorIfRequested()
        let kind = EngineKind.resolve(override: override, hasProvider: services.settings.hasProfiles)
        let engine: any ChatEngine = switch kind {
        case .demo: DemoAgentEngine()
        case .scripted:
            UserDefaults.standard.bool(forKey: "PraxisLongRun") ? ScriptedChatEngine.longRun() : ScriptedChatEngine.echo()
        case .live: services.makeEngine()
        case .cloud: CloudChatEngine(client: CloudAPIClient(configuration: try! .forLaunch()))
        }
        Task { await services.skills.reload() }
        let store = ChatStore(engine: engine, persistence: ConversationStore(directory: AppDirectories.conversations),
                              services: services, picksEngineAutomatically: override == nil)
        store.background.installNotificationDelegate()
        store.background.appDidLaunch()
        let voice = VoiceInputController.production(chatStore: store, services: services)
        store.voice = voice
        store.voiceRetryTranscription = { [weak voice] id in
            Task { @MainActor [weak voice] in voice?.retryTranscription(id: id) }
        }
        services.pruneRuntimeState(keeping: store.conversations.map(\.id))
        #if DEBUG
        // UI test flag presenting standalone voice consent sheet.
        if UserDefaults.standard.bool(forKey: "PraxisVoiceConsentDemo"), let id = store.selectedID {
            store.pendingConsent = ConsentRequest(host: GroqEndpoints.host, providerName: "Groq",
                                                  connectorNames: [], conversationID: id,
                                                  action: .transcribe(recordingID: UUID()))
        }
        #endif
        return store
    }

    static func makeCloudStore(client: CloudAPIClient, persistence: ConversationStore? = nil,
                               conversations: [Conversation]? = nil, replicaRoot: URL = AppDirectories.root) -> ChatStore {
        let cloud = CloudServices(client: client)
        let store = ChatStore(engine: CloudChatEngine(client: client), conversations: conversations ?? [],
                              persistence: persistence, cloudServices: cloud)
        store.use(CloudChatEngine(client: client, elicitations: store.cloudElicitations))
        let replica = CloudAccountReplica(store: store, client: client, root: replicaRoot)
        store.cloudReplica = replica
        cloud.onSessionChanged = { [weak replica] user in replica?.sessionChanged(user) }
        store.voice = VoiceInputController.production(chatStore: store, cloudServices: cloud)
        store.voiceRetryTranscription = { [weak store] id in store?.voice?.retryTranscription(id: id) }
        return store
    }

    /// Owned by caller instead of transient @State; loads local state before cloud.
    func prepareCloudSession() async {
        guard let cloudServices, !hasPreparedCloudSession else { return }
        hasPreparedCloudSession = true
        defer { if Task.isCancelled { hasPreparedCloudSession = false } }
        await cloudReplica?.restoreBeforeNetwork()
        guard !Task.isCancelled else { return }
        await cloudServices.loadIfNeeded()
    }

}
