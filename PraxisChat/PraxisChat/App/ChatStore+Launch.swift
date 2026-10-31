import Foundation

// Launch wiring is separate from transcript and run state.
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
                    // Harness credentials are ephemeral; never read a real
                    // Keychain entry or let it override this test session.
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
        // SUNSET(native-loop): only explicit demo/scripted launches or the
        // hidden native developer opt-in reach native service construction.
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
        // Voice input (voice-rec; right after creation — voice-groq's seam
        // sits before `return store`, so these hunks stay separate).
        let voice = VoiceInputController.production(chatStore: store, services: services)
        store.voice = voice
        store.voiceRetryTranscription = { [weak voice] id in
            Task { @MainActor [weak voice] in voice?.retryTranscription(id: id) }
        }
        services.pruneRuntimeState(keeping: store.conversations.map(\.id))
        #if DEBUG
        // `-PraxisVoiceConsentDemo YES` (UI tests): present the voice
        // transcription consent sheet standalone (no controller needed).
        if UserDefaults.standard.bool(forKey: "PraxisVoiceConsentDemo"), let id = store.selectedID {
            store.pendingConsent = ConsentRequest(host: GroqEndpoints.host, providerName: "Groq",
                                                  connectorNames: [], conversationID: id,
                                                  action: .transcribe(recordingID: UUID()))
        }
        #endif
        return store
    }

    /// Injectable construction shared by the launch path and wiring tests.
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

    /// Called by the view that owns this store, not by a transient @State
    /// initializer. Local restoration completes before session reconciliation.
    func prepareCloudSession() async {
        guard let cloudServices, !hasPreparedCloudSession else { return }
        hasPreparedCloudSession = true
        defer { if Task.isCancelled { hasPreparedCloudSession = false } }
        await cloudReplica?.restoreBeforeNetwork()
        guard !Task.isCancelled else { return }
        await cloudServices.loadIfNeeded()
    }

}
