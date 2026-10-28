import Foundation
import SwiftUI
import AgentCore
import AgentMCP
import AgentRuntime

/// Single source of truth (spec §2): `@Observable @MainActor`.
///
/// Runs are per conversation: sending in one chat never stops another,
/// and the stop button reflects the selected chat. Engine events arrive
/// coalesced (≤ 30 flushes/s) and are folded in batches by each run's
/// `TurnReducer`; streamed text goes to the block's `LiveText` without
/// touching the turn. Conversations are written to disk at commit points.
@MainActor
@Observable
final class ChatStore {
    var conversations: [Conversation]
    var selectedID: UUID?
    var mode: ChatMode = .auto
    var effort: Effort = .high
    /// The demo catalogue's pick; when live, `model` is the provider's.
    private var demoModel: AIModel = MockData.models[1]
    var webSearch = true
    var memory = true
    /// Demo connectors; live mode lists installed servers (`trayConnectors`).
    var connectors: [Connector] = MockData.connectors
    var connectorDiscovery = true
    var attachments: [Attachment] = []
    var draft: String = ""
    /// Unsent drafts stashed per conversation (`switchSelection`): the
    /// composer's text + attachments belong to the selected chat. Not
    /// observed — every stash/restore already touches observed state.
    @ObservationIgnored private var drafts: [UUID: ChatDraft] = [:]
    /// The model picker's search text. The composer binds to this (not the
    /// draft) while the tray's Model page is open; cleared when the page
    /// closes or a model is picked. The draft is never touched.
    var modelQuery: String = ""
    /// Id the draft's turn will get when sent. The composer tags the draft
    /// with it, so the new bubble can fly in from where the text was typed.
    private(set) var nextTurnID = UUID()
    /// Runs in flight, keyed by conversation.
    private(set) var runs: [UUID: RunHandle] = [:]
    /// Engine the next run uses. Changes to live when the first provider
    /// is added (unless `-PraxisEngine` pinned it).
    private(set) var engineKind: EngineKind
    /// Settings were asked for from elsewhere (a "needs provider" note).
    var isSettingsPresented = false
    /// Where Settings opens when presented from elsewhere (the tray's
    /// "Manage connectors"); Settings consumes it on appear.
    var settingsPage: SettingsPage = .root
    /// A live send waiting on the AI-data consent sheet. Nothing has
    /// been sent or added to the thread while this is set.
    var pendingConsent: ConsentRequest?
    /// Voice consent allow-path: the controller sets this; allowing retries
    /// the held transcription, declining is a no-op (audio stays queued).
    @ObservationIgnored var voiceRetryTranscription: ((UUID) -> Void)?
    /// Whether the selected conversation is running.
    var isRunning: Bool { selectedID.map(isRunning(_:)) ?? false }

    let approvals = ApprovalCenter()
    let haptics = HapticCenter()
    /// Background execution for runs in flight (continued tasks, fallback
    /// grace, pause/resume, notifications). Never touches request building.
    @ObservationIgnored let background: BackgroundRuntime
    /// Voice input state (nil in previews and store-only tests). Set by
    /// `forLaunch`; the composer and banners read it from here.
    @ObservationIgnored var voice: VoiceInputController?
    /// Trust and "always allow" grants (persisted with the index).
    private(set) var policy = ToolPolicy()

    @ObservationIgnored private var engine: any ChatEngine
    /// Providers, connectors, skills and the runtime (nil in previews and
    /// most tests: demo data only).
    @ObservationIgnored let services: AgentServices?
    @ObservationIgnored private let picksEngineAutomatically: Bool
    @ObservationIgnored private let persistence: ConversationStore?
    @ObservationIgnored private let attachmentStore: AttachmentStore
    /// Streaming blocks' text, by block id. Not observed: the turn change
    /// that adds a block already re-renders its turn, which looks it up.
    @ObservationIgnored private var liveTexts: [UUID: LiveText] = [:]
    @ObservationIgnored private var collapseTasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored var coalesceInterval: Duration = .milliseconds(33)

    /// - Parameters:
    ///   - conversations: start from these (previews, tests); otherwise
    ///     load from `persistence`, seeding the demo threads on first launch.
    ///   - picksEngineAutomatically: switch to live once a provider
    ///     profile is added (no `-PraxisEngine` override).
    init(engine: any ChatEngine = DemoAgentEngine(), conversations: [Conversation]? = nil,
         persistence: ConversationStore? = nil, attachments: AttachmentStore = .shared,
         services: AgentServices? = nil, picksEngineAutomatically: Bool = false,
         background: BackgroundRuntime? = nil) {
        // Integration wiring (BACKGROUND_PLAN.md §6): the live ActivityKit
        // reporter; tests inject fakes via the `background` parameter.
        self.background = background ?? BackgroundRuntime(reporter: LiveRunActivityReporter())
        self.engine = engine
        self.engineKind = engine.kind
        self.services = services
        self.picksEngineAutomatically = picksEngineAutomatically
        self.persistence = persistence
        self.attachmentStore = attachments
        if let conversations {
            self.conversations = conversations
        } else if let snapshot = persistence?.load() {
            self.conversations = snapshot.conversations.map { Conversation(record: $0.settledAfterRelaunch()) }
            self.policy = snapshot.policy
        } else {
            self.conversations = Scenarios.seededConversations()
            if persistence != nil {
                self.conversations.forEach(save)
                saveIndex()
            }
        }
        selectedID = self.conversations.first?.id
        self.background.store = self
    }

    /// The app's store: conversations from Application Support
    /// (`-PraxisResetData YES` starts from the seed). The engine is
    /// `-PraxisEngine demo|scripted|live` when given, else live once a
    /// provider profile exists and the demo before that.
    static func forLaunch() -> ChatStore {
        if UserDefaults.standard.bool(forKey: "PraxisResetData") { AppDirectories.reset() }
        let services = AgentServices.live()
        services.installTestProviderIfRequested()
        services.connectors.installMockConnectorIfRequested()
        let override = EngineKind.launchOverride
        let kind = EngineKind.resolve(override: override, hasProvider: services.settings.hasProfiles)
        let engine: any ChatEngine = switch kind {
        case .demo: DemoAgentEngine()
        case .scripted:
            UserDefaults.standard.bool(forKey: "PraxisLongRun") ? ScriptedChatEngine.longRun() : ScriptedChatEngine.echo()
        case .live: services.makeEngine()
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

    /// Call after provider profiles change: the first profile switches the
    /// demo to live. Once live it stays live — with no provider left, runs
    /// point to Settings instead of quietly answering with demo scripts.
    func providersChanged() {
        guard picksEngineAutomatically, let services, engineKind != .live,
              EngineKind.resolve(override: nil, hasProvider: services.settings.hasProfiles) == .live else { return }
        use(services.makeEngine())
    }

    /// Swaps the engine for future runs; runs in flight keep theirs.
    func use(_ engine: any ChatEngine) {
        self.engine = engine
        engineKind = engine.kind
    }

    var selected: Conversation? {
        conversations.first { $0.id == selectedID }
    }

    func isRunning(_ conversationID: UUID) -> Bool { runs[conversationID] != nil }

    func liveText(for blockID: UUID) -> LiveText? { liveTexts[blockID] }

    // MARK: Conversation management

    func newChat() {
        let c = Conversation(title: ConversationTitle.placeholder)
        conversations.insert(c, at: 0)
        switchSelection(to: c.id)
        saveIndex()
    }

    func select(_ id: UUID) {
        guard id != selectedID else { return }
        switchSelection(to: id)
    }

    /// Moves the selection, stashing the composer's draft under the old
    /// chat and restoring the new chat's (a fresh chat starts empty).
    private func switchSelection(to id: UUID?) {
        if let current = selectedID, current != id {
            drafts[current] = ChatDraft(text: draft, attachments: attachments)
        }
        selectedID = id
        if let id, let stashed = drafts[id] {
            draft = stashed.text
            attachments = stashed.attachments
        } else {
            draft = ""
            attachments = []
        }
    }

    func togglePinned(_ id: UUID) {
        guard let conv = conversations.first(where: { $0.id == id }) else { return }
        conv.isPinned.toggle()
        save(conv)
        saveIndex()
    }

    /// Deletes chats, stopping their runs and dropping their files.
    func deleteConversations(_ ids: Set<UUID>) {
        let removed = conversations.filter { ids.contains($0.id) }
        for conv in removed {
            cancelRun(conv.id)
            forget(conv.turns)
            services?.forget(conversationID: conv.id)
        }
        conversations.removeAll { ids.contains($0.id) }
        if let selectedID, !conversations.contains(where: { $0.id == selectedID }) {
            switchSelection(to: conversations.first?.id)
        }
        // After the switch: it may have stashed the old draft under a
        // deleted chat, which must not linger.
        for id in ids { drafts.removeValue(forKey: id) }
        // Index first: a crash between the two then leaves orphan files
        // (ignored at load), not ghost chats (index entries whose files
        // are gone get synthesized back as empty conversations).
        saveIndex()
        persistence?.delete(Array(ids))
    }

    // MARK: Sending / running

    func send(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        guard let conv = selected else { return }
        // First live send to this provider host: ask before anything
        // leaves the device. The composer keeps its text meanwhile.
        if let needed = consentNeeded() {
            pendingConsent = ConsentRequest(host: needed.host, providerName: needed.providerName,
                                            connectorNames: connectorNames(for: conv),
                                            conversationID: conv.id,
                                            action: .send(text: text, attachments: attachments))
            return
        }
        var turn = Turn(id: nextTurnID, userText: trimmed, attachments: attachments, modelID: model.id)
        turn.engine = engine.kind
        // A live engine builds the user message itself (the runtime picks
        // its notes) and commits it as the run's first message.
        if !engine.buildsUserMessage {
            turn.transcript = [userMessage(trimmed, in: conv, before: conv.turns.count)]
        }
        nextTurnID = UUID()
        attachmentStore.persist(attachments.map(\.id))
        // Named by its first message: the words, or what it carries when
        // there are none ("Photo", "2 photos", a file's name).
        let retitle = conv.wantsTitle(for: trimmed)
        conv.turns.append(turn)
        if retitle, let title = ConversationTitle.make(text: trimmed, attachments: turn.attachments) {
            conv.title = title
        }
        conv.updatedAt = Date()
        attachments = []
        draft = ""
        // A sent draft is gone for good: switching away and back must
        // not resurrect it from the stash.
        drafts.removeValue(forKey: conv.id)
        haptics.fire(.light)
        save(conv)
        saveIndex()
        startRun(in: conv, turnID: turn.id)
        voice?.noteDidSend(text: trimmed)
    }

    func retry(turnID: UUID) {
        guard let conv = selected, let i = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        if let needed = consentNeeded() {
            pendingConsent = ConsentRequest(host: needed.host, providerName: needed.providerName,
                                            connectorNames: connectorNames(for: conv),
                                            conversationID: conv.id, action: .retry(turnID))
            return
        }
        // Retrying rewinds the thread: everything below goes away,
        // the retried turn itself re-runs from scratch.
        cancelRun(conv.id)
        forget(Array(conv.turns[(i + 1)...]))
        forgetBlocks(of: conv.turns[i])
        conv.turns.removeSubrange((i + 1)..<conv.turns.count)
        conv.turns[i].blocks = []
        conv.turns[i].isFinished = false
        conv.turns[i].outcome = nil
        conv.turns[i].feedback = .none
        conv.turns[i].modelID = model.id
        conv.turns[i].engine = engine.kind
        conv.turns[i].transcript = engine.buildsUserMessage ? [] : [userMessage(conv.turns[i].userText, in: conv, before: i)]
        save(conv)
        startRun(in: conv, turnID: turnID)
    }

    /// Edit puts the text back in the composer and re-runs from that point (§8).
    func edit(turnID: UUID) {
        guard let conv = selected, let idx = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        draft = conv.turns[idx].userText
        if let run = runs[conv.id], conv.turns[idx...].contains(where: { $0.id == run.turnID }) {
            cancelRun(conv.id)
        }
        forget(Array(conv.turns[idx...]))
        conv.turns.removeSubrange(idx..<conv.turns.count)
        // The first message is going to be rewritten: its title goes
        // with it, and the resend names the chat again.
        if idx == 0 { conv.title = ConversationTitle.placeholder }
        save(conv)
        saveIndex()
    }

    func resend(turnID: UUID) {
        guard let conv = selected, let turn = conv.turns.first(where: { $0.id == turnID }) else { return }
        send(text: turn.userText)
    }

    /// Stops the selected conversation's run.
    func stop() {
        guard let selectedID else { return }
        stop(conversationID: selectedID)
    }

    /// Stops one conversation's run: whatever already arrived is applied,
    /// then the turn settles as stopped and is saved.
    func stop(conversationID: UUID) {
        guard let handle = runs.removeValue(forKey: conversationID) else { return }
        background.runStopped(conversationID: conversationID)
        handle.task?.cancel()
        handle.cancelled.cancel()
        services?.elicitations.cancel(scope: handle.elicitationScope)
        // Drain first: an approval event may have arrived without a
        // main-actor drain yet, and its waiter must be released too —
        // denying before the drain would miss it and hang the engine.
        let (events, _) = handle.inbox.drain()
        guard let conv = conversation(conversationID), let ti = locate(handle, in: conv) else {
            approvals.denyAll(handle.approvalIDs.union(approvalIDs(in: events)))
            return
        }
        var turn = conv.turns[ti]
        let now = Date()
        var change = TurnReducer.Change()
        for event in events {
            change.merge(handle.reducer.reduce(event, into: &turn, at: now))
        }
        if turn.isRunning || !turn.isFinished {
            change.merge(handle.reducer.finish(&turn, outcome: .stopped, at: now))
        }
        handle.approvalIDs.formUnion(change.approvalIDs)
        handle.approvalIDs.subtract(change.resolvedApprovalIDs)
        approvals.denyAll(handle.approvalIDs)
        if !change.alwaysAllowKeys.isEmpty {
            policy.alwaysAllow.formUnion(change.alwaysAllowKeys)
            saveIndex()
        }
        applyLiveText(change)
        conv.turns[ti] = turn
        save(conv)
    }

    /// Approval ids asked in `events` but not resolved there.
    private func approvalIDs(in events: [AgentEvent]) -> Set<String> {
        var ids = Set<String>()
        for event in events {
            switch event {
            case .toolAwaitingApproval(let request): ids.insert(request.id)
            case .toolApprovalResolved(let id, _): ids.remove(id)
            default: break
            }
        }
        return ids
    }

    func resolveApproval(_ requestID: String, decision: ApprovalDecision) {
        haptics.fire(decision == .deny ? .soft : .light)
        approvals.resolve(requestID, with: decision)
    }

    // MARK: Background

    /// Resumes a background-paused turn as a NEW turn: its replayed
    /// history includes the paused turn's committed transcript, so the
    /// run continues from the last completed step without re-executing
    /// finished tools (BACKGROUND_PLAN.md §2.7). Partial (uncommitted)
    /// stream text stays visible on the old turn and is not replayed.
    func continueRun(conversationID: UUID) {
        guard let conv = conversation(conversationID),
              conv.turns.last?.outcome == .pausedBackground,
              runs[conversationID] == nil else { return }
        selectedID = conversationID
        send(text: "Continue")
    }

    /// Expiry path (the continued task or the fallback grace ran out):
    /// settles exactly like `stop()` — drain, deny approvals, keep
    /// partial blocks and the committed transcript — then marks the
    /// turn paused-in-background and saves again.
    func pauseRunForBackground(conversationID: UUID) {
        guard let handle = runs[conversationID] else { return }
        let turnID = handle.turnID
        background.beginPause(conversationID: conversationID)
        stop(conversationID: conversationID)
        if let conv = conversation(conversationID),
           let ti = conv.turns.firstIndex(where: { $0.id == turnID }) {
            conv.turns[ti].outcome = .pausedBackground
            save(conv)
        }
        background.runPaused(conversationID: conversationID)
    }

    func appDidEnterBackground() {
        background.appDidEnterBackground(running: Set(runs.keys))
    }

    func appDidBecomeActive() {
        background.appDidBecomeActive(running: Set(runs.keys))
    }

    // MARK: AI-data consent

    /// The consent sheet's answer. Allowing records the host and performs
    /// the held send; declining drops it and leaves the draft (text and
    /// attachments) as it was, so nothing is lost.
    func resolveConsent(allow: Bool) {
        guard let request = pendingConsent else { return }
        pendingConsent = nil
        // The answer belongs to the chat the send started in, not
        // necessarily the selected one.
        guard conversation(request.conversationID) != nil else { return }
        // Stash the current chat's draft first; the held send's own
        // text + attachments overwrite the restored draft below.
        switchSelection(to: request.conversationID)
        guard allow else {
            haptics.fire(.soft)
            if case .send(let text, let held) = request.action {
                draft = text
                attachments = held
            }
            return
        }
        services?.consent.grant(request.host, providerName: request.providerName)
        switch request.action {
        case .send(let text, let held):
            attachments = held
            send(text: text)
        case .retry(let turnID):
            retry(turnID: turnID)
        case .transcribe(let recordingID):
            // Voice (voice-groq): the host is granted above; the controller
            // retries the held transcription. Set by VoiceInputController.
            voiceRetryTranscription?(recordingID)
        }
    }

    /// Only live runs send anything off the device.
    private func consentNeeded() -> (host: String, providerName: String)? {
        guard engine.kind == .live else { return nil }
        return services?.consentNeeded()
    }

    /// Connectors whose data the agent may read in this chat (named on
    /// the consent sheet).
    private func connectorNames(for conv: Conversation) -> [String] {
        guard let library = services?.connectors else { return [] }
        let ids = frozenServerIDs(of: conv).map { Array($0) } ?? enabledConnectorIDs(for: conv)
        return ids.filter { !conv.disabledServerIDs.contains($0) }.compactMap { library.server($0)?.name }.sorted()
    }

    private func startRun(in conv: Conversation, turnID: UUID) {
        // Settle-then-supersede: replacing a run without settling it would
        // abandon its turn as running forever (resend while streaming).
        stop(conversationID: conv.id)
        collapseTasks.removeValue(forKey: turnID)?.cancel()
        evictRevealedLiveTexts(in: conv)
        guard let ti = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        conv.turns[ti].isRunning = true
        conv.turns[ti].isFinished = false
        conv.turns[ti].outcome = nil

        let handle = RunHandle(conversationID: conv.id, turnID: turnID, turnIndex: ti)
        var request = makeRequest(conv, turnIndex: ti)
        let flag = handle.cancelled
        request.isCancelled = { flag.isCancelled }
        request.elicitationScope = handle.elicitationScope
        runs[conv.id] = handle
        background.runStarted(conversationID: conv.id, turnID: turnID, title: conv.displayTitle, modelName: model.name)
        let stream = AgentEventCoalescer.coalesce(engine.run(request), interval: coalesceInterval)
        let inbox = handle.inbox
        let store = WeakStore(value: self)
        // Read off the main actor; the main actor only sees batches.
        handle.task = Task.detached(priority: .userInitiated) {
            await EventInbox.pump(stream, into: inbox) {
                Task { @MainActor in store.value?.drain(handle) }
            }
        }
    }

    /// Cancels a run without settling its turn (the turn is going away
    /// or about to re-run). Waiters are still released: denying covers the
    /// collected ids plus approvals whose events never reached a drain.
    private func cancelRun(_ conversationID: UUID) {
        guard let handle = runs.removeValue(forKey: conversationID) else { return }
        background.runStopped(conversationID: conversationID)
        handle.task?.cancel()
        handle.cancelled.cancel()
        services?.elicitations.cancel(scope: handle.elicitationScope)
        approvals.denyAll(handle.approvalIDs.union(approvalIDs(in: handle.inbox.drain().events)))
    }

    private func drain(_ handle: RunHandle) {
        // A stopped or replaced run's leftovers are dropped.
        guard runs[handle.conversationID] === handle else { return }
        let (events, ended) = handle.inbox.drain()
        guard let conv = conversation(handle.conversationID), let ti = locate(handle, in: conv) else {
            cancelRun(handle.conversationID)
            return
        }
        var turn = conv.turns[ti]
        let now = Date()
        var change = TurnReducer.Change()
        for event in events {
            change.merge(handle.reducer.reduce(event, into: &turn, at: now))
        }
        if ended, !change.effects.contains(.finished), turn.isRunning {
            // The engine closed its stream without a verdict.
            change.merge(handle.reducer.finish(&turn, outcome: .completed, at: now))
        }

        // Live text before the turn: views for blocks this batch opens
        // must find their LiveText when the turn re-renders.
        applyLiveText(change)
        // Text-only batches leave the turn alone, so the transcript
        // doesn't re-render per token.
        if change.effects.contains(.turn) { conv.turns[ti] = turn }
        background.reportBatch(conversationID: conv.id, title: conv.displayTitle, events: events)

        handle.approvalIDs.formUnion(change.approvalIDs)
        handle.approvalIDs.subtract(change.resolvedApprovalIDs)
        if change.effects.contains(.approvalRequested), selectedID == conv.id { haptics.fire(.light) }
        if change.effects.contains(.commandFailed) { haptics.fire(.warning) }
        if !change.alwaysAllowKeys.isEmpty {
            policy.alwaysAllow.formUnion(change.alwaysAllowKeys)
            saveIndex()
        }

        if change.effects.contains(.finished) || (ended && !turn.isRunning) {
            runs.removeValue(forKey: conv.id)
            background.runFinished(conversationID: conv.id, title: conv.displayTitle, turn: turn)
            approvals.denyAll(handle.approvalIDs)
            switch turn.outcome {
            case .completed?, nil: haptics.fire(.success)
            case .failed?, .refused?: haptics.fire(.warning)
            default: break
            }
            autoCollapseActivities(turnID: handle.turnID)
        }
        if change.effects.contains(.commit) || change.effects.contains(.finished) { save(conv) }
    }

    private func applyLiveText(_ change: TurnReducer.Change) {
        for id in change.openedText where liveTexts[id] == nil { liveTexts[id] = LiveText(id: id) }
        // One append (one incremental parse) per block per batch.
        var order: [UUID] = []
        var appended: [UUID: String] = [:]
        for (id, text) in change.appendedText {
            if appended[id] == nil { order.append(id) }
            appended[id, default: ""] += text
        }
        for id in order { liveTexts[id]?.append(appended[id] ?? "") }
        for (id, source) in change.closedText { liveTexts[id]?.finish(source) }
        for id in change.discardedText { liveTexts.removeValue(forKey: id) }
    }

    /// Finished activity folds away once the whole run is done — not
    /// mid-answer. Collapsing while text still streamed meant two layout
    /// changes fighting each other (the shrinking block animating, every
    /// chunk re-pinning the bottom instantly), and the thread jiggled.
    /// Blocks the user opened or closed themselves are left alone.
    private func autoCollapseActivities(turnID: UUID) {
        collapseTasks[turnID]?.cancel()
        collapseTasks[turnID] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(450))
            guard let self, !Task.isCancelled else { return }
            self.collapseTasks[turnID] = nil
            withAnimation(Motion.reflow) {
                self.updateTurn(turnID) { t in
                    for i in t.blocks.indices {
                        t.updateActivity(at: i) { act in
                            // Waiting on the user: never fold that away.
                            let waiting = act.steps.contains(where: \.isWaitingOnUser)
                            if act.userExpanded == nil, act.isExpanded, !waiting { act.isExpanded = false }
                        }
                    }
                }
            }
        }
    }

    // MARK: Requests

    private func makeRequest(_ conv: Conversation, turnIndex: Int) -> ChatRunRequest {
        let turn = conv.turns[turnIndex]
        let earlier = conv.turns[..<turnIndex]
        // Live runs replay only live turns: demo answers are scripts.
        let replayed = engine.kind == .live ? earlier.filter { $0.engine == .live } : Array(earlier)
        let user = engine.buildsUserMessage ? nil
            : turn.transcript.first ?? userMessage(turn.userText, in: conv, before: turnIndex)
        let conversationID = conv.id
        let store = WeakStore(value: self)
        return ChatRunRequest(
            conversationID: conv.id, history: replayed.flatMap(\.transcript), userMessage: user,
            userText: turn.userText, mode: mode, effort: effort,
            modelID: model.id, webSearch: webSearch, attachments: turn.attachments,
            conversationAttachments: conv.turns[...turnIndex].flatMap(\.attachments),
            hiddenFromCode: { await MainActor.run { store.value?.hiddenFromCode(in: conversationID) ?? [] } },
            policy: policy, approvals: approvals, setup: conv.setup,
            // The freeze always takes the full enabled set: per-chat "off"
            // is a refusal (`disabledServerIDs`), not an exclusion —
            // excluding it would drop the connector from the frozen setup
            // for good on every re-freeze (retry of the first turn).
            connectorIDs: enabledConnectorIDs(for: conv),
            // Unknown ids are ignored by the runtime, so the full set is
            // safe even when the setup is about to be (re-)frozen.
            disabledServerIDs: conv.disabledServerIDs,
            // Read live: toggling a tool applies to existing chats'
            // next run (their calls refuse) and to new chats' freeze.
            disabledTools: services?.connectors.disabledTools ?? [:],
            onSetup: { setup, failures in
                await MainActor.run { store.value?.adopt(setup, failures: failures, conversationID: conversationID) }
            },
            compaction: conv.compaction,
            onCompaction: { record in
                await MainActor.run { store.value?.adopt(record, conversationID: conversationID) }
            },
            contextMeasurement: conv.contextMeasurement,
            onContextMeasured: { measurement in
                await MainActor.run { store.value?.conversation(conversationID)?.contextMeasurement = measurement }
            })
    }

    // MARK: Code access

    /// "Hide from code" / "Available to code" on an attachment, in the
    /// composer or a sent turn. Sent turns are saved; a run in flight
    /// sees the change at its next `fs` call (`ChatRunRequest.hiddenFromCode`).
    func setHiddenFromCode(_ hidden: Bool, attachmentID: UUID) {
        if let i = attachments.firstIndex(where: { $0.id == attachmentID }) { attachments[i].isHiddenFromCode = hidden }
        for conv in conversations {
            var changed = false
            for t in conv.turns.indices {
                guard let a = conv.turns[t].attachments.firstIndex(where: { $0.id == attachmentID }),
                      conv.turns[t].attachments[a].isHiddenFromCode != hidden else { continue }
                conv.turns[t].attachments[a].isHiddenFromCode = hidden
                changed = true
            }
            if changed { save(conv) }
        }
    }

    /// Attachments of a conversation the user hid from code.
    func hiddenFromCode(in conversationID: UUID) -> Set<UUID> {
        guard let conv = conversation(conversationID) else { return [] }
        return Set(conv.turns.flatMap(\.attachments).filter(\.isHiddenFromCode).map(\.id))
    }

    /// Persists a context compaction; the turns keep the full transcript.
    private func adopt(_ compaction: ContextCompaction, conversationID: UUID) {
        guard let conv = conversation(conversationID) else { return }
        conv.compaction = compaction
        save(conv)
    }

    /// Persists a freshly frozen setup with its conversation, before the
    /// run sends anything.
    private func adopt(_ setup: ConversationSetup, failures: [MCPToolset.Failure], conversationID: UUID) {
        services?.connectors.record(failures)
        guard let conv = conversation(conversationID) else { return }
        conv.setup = setup
        // The freeze keeps the full enabled set, so per-chat toggles
        // survive a re-freeze; only ids that left the setup go.
        conv.disabledServerIDs = conv.disabledServerIDs.intersection(setup.mcpServers.map(\.id))
        save(conv)
    }

    /// The user message for a turn. Mode and effort changes ride along as
    /// a note — appended, never edited into earlier history.
    private func userMessage(_ text: String, in conv: Conversation, before index: Int) -> Message {
        let note = SystemPrompt.modeNote(mode: mode.agentMode, effort: effort)
        var parts: [Part] = []
        if lastModeNote(in: conv, before: index) != note { parts.append(.note(note)) }
        if !text.isEmpty { parts.append(.text(text)) }
        return Message(role: .user, parts: parts)
    }

    private func lastModeNote(in conv: Conversation, before index: Int) -> String? {
        for turn in conv.turns[..<min(index, conv.turns.count)].reversed() {
            for message in turn.transcript.reversed() where message.role == .user {
                for part in message.parts.reversed() {
                    if case .note(let note) = part, note.hasPrefix("Current mode:") { return note }
                }
            }
        }
        return nil
    }

    // MARK: Live settings (model, connectors, toggles)

    var isLive: Bool { engineKind == .live }

    /// The model new turns use: the demo pick, or the selected provider's.
    var model: AIModel {
        get { isLive ? liveModel : demoModel }
        set {
            if isLive { selectModel(id: newValue.id) } else { demoModel = newValue; snapEffortToSupportedLevels() }
        }
    }

    /// Reasoning levels the tray offers for the current model. Nil = unknown
    /// (all four); empty = no reasoning (the control hides). Live models
    /// resolve this from the provider's list or a learned rejection.
    var supportedEfforts: [Effort]? {
        if isLive {
            guard let wire = services?.settings.selectedEffortWireValues else { return nil }
            return EffortLevels.map(wire)
        }
        return demoModel.effortLevels
    }

    /// After a model change, moves the effort to the nearest level the new
    /// model takes; unknown or unreasoning models keep it. The tray's
    /// control animates to the new selection, which is the subtle show.
    private func snapEffortToSupportedLevels() {
        guard let levels = supportedEfforts, !levels.isEmpty, !levels.contains(effort),
              let snapped = EffortLevels.nearest(to: effort, in: levels) else { return }
        effort = snapped
    }

    /// What the tray's model page lists.
    var availableModels: [AIModel] {
        guard isLive else { return MockData.models }
        guard let settings = services?.settings, let profile = settings.selectedProfile else { return [] }
        var models = settings.models(for: profile.id).map { Self.aiModel($0, profile: profile) }
        // A manually entered id the server doesn't list still shows.
        if !profile.defaultModel.isEmpty, !models.contains(where: { $0.id == profile.defaultModel }) {
            models.insert(Self.aiModel(ModelInfo(id: profile.defaultModel), profile: profile), at: 0)
        }
        return models
    }

    private var liveModel: AIModel {
        guard let profile = services?.settings.selectedProfile else {
            return AIModel(id: "", name: "No model", tagline: "Add a provider in Settings",
                           speed: 0, intelligence: 0, streamMultiplier: 1)
        }
        let info = services?.settings.models(for: profile.id).first { $0.id == profile.defaultModel }
        guard !profile.defaultModel.isEmpty else {
            return AIModel(id: "", name: "Choose a model", tagline: profile.name, speed: 0, intelligence: 0, streamMultiplier: 1)
        }
        return Self.aiModel(info ?? ModelInfo(id: profile.defaultModel), profile: profile)
    }

    private func selectModel(id: String) {
        guard let settings = services?.settings, let profile = settings.selectedProfile else { return }
        settings.setModel(id, for: profile.id)
        snapEffortToSupportedLevels()
    }

    private static func aiModel(_ info: ModelInfo, profile: ProviderProfile) -> AIModel {
        let window = info.contextWindow.map { " · \($0 / 1000)K context" } ?? ""
        return AIModel(id: info.id, name: info.displayName, tagline: profile.name + window,
                       speed: 0, intelligence: 0, streamMultiplier: 1)
    }

    /// Demo-only toggles (Memory, connector discovery) hide when live.
    var showsDemoToggles: Bool { !isLive }

    /// The web-search toggle only shows where the provider can search.
    var showsWebSearch: Bool { !isLive || services?.isWebSearchAvailable == true }

    /// The tray's connector list: demo data, or the installed servers with
    /// this conversation's enablement when live. Once the chat has frozen
    /// its tools, the frozen connectors still toggle (off = refused in
    /// this chat only); servers outside the frozen setup are listed
    /// separately (`newChatOnlyConnectors`).
    var trayConnectors: [Connector] {
        guard isLive else { return connectors }
        guard let library = services?.connectors else { return [] }
        let conv = selected
        let off = conv?.disabledServerIDs ?? []
        if let conv, let frozen = frozenServerIDs(of: conv) {
            return library.servers.filter { frozen.contains($0.id) }.map { server in
                Connector(id: server.id, name: server.name, monogram: Self.monogram(server.name),
                          isOn: server.enabled && !off.contains(server.id),
                          lockedReason: server.enabled ? nil : "Off in Settings")
            }
        }
        let enabled = Set(conv.map(enabledConnectorIDs(for:)) ?? library.defaultConversationServerIDs)
        return library.servers.map { server in
            Connector(id: server.id, name: server.name, monogram: Self.monogram(server.name),
                      isOn: enabled.contains(server.id) && !off.contains(server.id))
        }
    }

    /// Installed servers the selected chat can't use: added (or not
    /// picked) after it froze its tools. They're available in new chats.
    var newChatOnlyConnectors: [Connector] {
        guard isLive, let library = services?.connectors, let conv = selected,
              let frozen = frozenServerIDs(of: conv) else { return [] }
        return library.servers.filter { !frozen.contains($0.id) }.map { server in
            Connector(id: server.id, name: server.name, monogram: Self.monogram(server.name), isOn: false,
                      lockedReason: "Available in new chats")
        }
    }

    /// True once the selected conversation froze its tools: only those
    /// connectors can be switched on or off here.
    var connectorsFrozen: Bool {
        isLive && selected.flatMap(frozenServerIDs(of:)) != nil
    }

    func setConnector(_ id: String, isOn: Bool) {
        guard isLive else {
            if let i = connectors.firstIndex(where: { $0.id == id }) { connectors[i].isOn = isOn }
            return
        }
        guard let conv = selected else { return }
        if let frozen = frozenServerIDs(of: conv) {
            // Frozen: the tool list can't change, so "off" is a refusal the
            // runtime applies on every run of this chat.
            guard frozen.contains(id) else { return }
            if isOn { conv.disabledServerIDs.remove(id) } else { conv.disabledServerIDs.insert(id) }
        } else {
            var ids = enabledConnectorIDs(for: conv).filter { $0 != id }
            if isOn { ids.append(id) }
            conv.connectorIDs = ids
            conv.disabledServerIDs.remove(id)
        }
        save(conv)
    }

    private static func monogram(_ name: String) -> String { String(name.prefix(1)).uppercased() }

    /// Connectors to freeze into the conversation's setup.
    private func enabledConnectorIDs(for conv: Conversation) -> [String] {
        let installed = services?.connectors.servers.map(\.id) ?? []
        let ids = conv.connectorIDs ?? services?.connectors.defaultConversationServerIDs ?? []
        return ids.filter(installed.contains)
    }

    /// The frozen servers, once the setup can no longer be re-prepared
    /// (a live message has been sent).
    private func frozenServerIDs(of conv: Conversation) -> Set<String>? {
        guard let setup = conv.setup, conv.turns.contains(where: { $0.engine == .live && !$0.transcript.isEmpty }) else { return nil }
        return Set(setup.mcpServers.map(\.id))
    }

    // MARK: UI mutations

    func setActivityExpanded(turnID: UUID, blockID: UUID, expanded: Bool) {
        collapseTasks.removeValue(forKey: turnID)?.cancel()
        updateTurn(turnID) { turn in
            for i in turn.blocks.indices where turn.blocks[i].id == blockID {
                turn.updateActivity(at: i) { a in
                    a.isExpanded = expanded
                    a.userExpanded = expanded
                }
            }
        }
    }

    /// Opens or closes one line's details (a command's card, a call's
    /// parameters and result). Kept in the model: rows are recreated as
    /// the transcript scrolls.
    func setCommandExpanded(turnID: UUID, stepID: UUID, expanded: Bool) {
        updateTurn(turnID) { turn in
            for i in turn.blocks.indices {
                turn.updateActivity(at: i) { a in
                    if let si = a.steps.firstIndex(where: { $0.id == stepID }) {
                        a.steps[si].command?.isExpanded = expanded
                        a.steps[si].detailsOpen = expanded
                    }
                }
            }
        }
    }

    func setFeedback(turnID: UUID, feedback: Turn.Feedback) {
        updateTurn(turnID) { $0.feedback = feedback }
        if let conv = owner(of: turnID) { save(conv) }
    }

    /// Mutates the turn in place inside whichever conversation owns it —
    /// a run keeps landing in its own thread after the user switches chats.
    private func updateTurn(_ turnID: UUID, _ mutate: (inout Turn) -> Void) {
        guard let conv = owner(of: turnID), let ti = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        mutate(&conv.turns[ti])
    }

    private func owner(of turnID: UUID) -> Conversation? {
        selected.flatMap { $0.turns.contains { $0.id == turnID } ? $0 : nil }
            ?? conversations.first { $0.turns.contains { $0.id == turnID } }
    }

    private func conversation(_ id: UUID) -> Conversation? {
        conversations.first { $0.id == id }
    }

    private func locate(_ handle: RunHandle, in conv: Conversation) -> Int? {
        if conv.turns.indices.contains(handle.turnIndex), conv.turns[handle.turnIndex].id == handle.turnID {
            return handle.turnIndex
        }
        guard let index = conv.turns.firstIndex(where: { $0.id == handle.turnID }) else { return nil }
        handle.turnIndex = index
        return index
    }

    // MARK: Cleanup

    /// Turns leaving the thread: their timers, live text and attachments go.
    private func forget(_ turns: [Turn]) {
        for turn in turns {
            collapseTasks.removeValue(forKey: turn.id)?.cancel()
            forgetBlocks(of: turn)
        }
        attachmentStore.remove(turns.flatMap(\.attachments).map(\.id))
    }

    private func forgetBlocks(of turn: Turn) {
        for block in turn.blocks { liveTexts.removeValue(forKey: block.id) }
    }

    /// A new run in a thread retires the previous answers' live text once
    /// their reveal has finished; those blocks render from the cache.
    private func evictRevealedLiveTexts(in conv: Conversation) {
        for turn in conv.turns {
            for block in turn.blocks {
                guard let live = liveTexts[block.id], !live.isStreaming,
                      live.revealed >= live.document.revealLength else { continue }
                liveTexts.removeValue(forKey: block.id)
            }
        }
    }

    // MARK: Persistence

    private func save(_ conv: Conversation) {
        persistence?.save(conv.record)
    }

    private func saveIndex() {
        persistence?.saveIndex(ConversationStore.Index(
            conversations: conversations.map {
                .init(id: $0.id, title: $0.title, updatedAt: $0.updatedAt, isPinned: $0.isPinned)
            },
            policy: policy))
    }

    /// Waits until queued writes have landed (tests).
    func flushPersistence() async {
        await persistence?.flush()
    }
}

/// Pages Settings can open on directly.
enum SettingsPage: Hashable {
    case root, connectors, skills
    /// One connector's detail (e.g. "Sign in to Gmail" from a chat step).
    case connector(String)
    /// Voice input (Groq key + model): 401s and missing-key hints link here.
    case voice
}

/// A weak store reference the off-main reader can carry.
private struct WeakStore: Sendable {
    weak var value: ChatStore?
}
