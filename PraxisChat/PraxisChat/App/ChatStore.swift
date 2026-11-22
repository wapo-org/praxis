import Foundation
import SwiftUI
import AgentCore
import AgentMCP
import AgentRuntime

/// Single @Observable store; coalesced per-conversation runs persist at commits.
@MainActor
@Observable
final class ChatStore {
    var conversations: [Conversation]
    var selectedID: UUID?
    var mode: ChatMode = .auto
    var effort: Effort = .high
    var demoModel: AIModel = MockData.models[1]
    var webSearch = true
    var memory = true
    var connectors: [Connector] = MockData.connectors
    var connectorDiscovery = true
    var attachments: [Attachment] = []
    var draft: String = ""
    /// Unobserved since every stash and restore already updates observed state.
    @ObservationIgnored private var drafts: [UUID: ChatDraft] = [:]
    /// Model search binding while tray is open; keeps draft untouched.
    var modelQuery: String = ""
    private(set) var nextTurnID = UUID()
    private(set) var runs: [UUID: RunHandle] = [:]
    /// Auto-switches from demo to live on first provider unless -PraxisEngine pinned.
    private(set) var engineKind: EngineKind
    var isSettingsPresented = false
    /// Consumed by Settings on appear.
    var settingsPage: SettingsPage = .root
    /// Holds send and transcript update until AI-data consent completes.
    var pendingConsent: ConsentRequest?
    /// Voice consent callback retries transcription; decline keeps queued audio.
    @ObservationIgnored var voiceRetryTranscription: ((UUID) -> Void)?
    var isRunning: Bool { selectedID.map(isRunning(_:)) ?? false }

    let approvals = ApprovalCenter()
    let cloudElicitations = ElicitationCenter()
    @ObservationIgnored var cloudReplica: CloudAccountReplica?
    @ObservationIgnored var hasPreparedCloudSession = false
    var cloudModelID = ""
    var elicitationCenter: ElicitationCenter? { engineKind == .cloud ? cloudElicitations : services?.elicitations }
    let haptics = HapticCenter()
    @ObservationIgnored let background: BackgroundRuntime
    @ObservationIgnored var voice: VoiceInputController?
    private(set) var policy = ToolPolicy()

    @ObservationIgnored private(set) var engine: any ChatEngine
    @ObservationIgnored let services: AgentServices?
    @ObservationIgnored let cloudServices: CloudServices?
    @ObservationIgnored private let picksEngineAutomatically: Bool
    @ObservationIgnored private var persistence: ConversationStore?
    @ObservationIgnored let attachmentStore: AttachmentStore
    /// Unobserved since inserting the block already re-renders the turn.
    @ObservationIgnored private var liveTexts: [UUID: LiveText] = [:]
    @ObservationIgnored private var collapseTasks: [UUID: Task<Void, Never>] = [:]
    @ObservationIgnored var coalesceInterval: Duration = .milliseconds(33)

    init(engine: any ChatEngine = DemoAgentEngine(), conversations: [Conversation]? = nil,
         persistence: ConversationStore? = nil, attachments: AttachmentStore = .shared,
         services: AgentServices? = nil, picksEngineAutomatically: Bool = false,
         cloudServices: CloudServices? = nil,
         background: BackgroundRuntime? = nil) {
        // Default LiveRunActivityReporter in production; injectable for tests.
        self.background = background ?? BackgroundRuntime(reporter: LiveRunActivityReporter())
        self.engine = engine
        self.engineKind = engine.kind
        self.services = services
        self.cloudServices = cloudServices
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

    func clearCloudDrafts() {
        drafts.removeAll(); draft = ""; attachments = []; pendingConsent = nil; cloudModelID = ""
        liveTexts.removeAll()
        for task in collapseTasks.values { task.cancel() }
        collapseTasks.removeAll()
    }

    /// One-way switch from demo to live on first provider.
    func providersChanged() {
        guard picksEngineAutomatically, let services, engineKind != .live,
              EngineKind.resolve(override: nil, hasProvider: services.settings.hasProfiles) == .live else { return }
        use(services.makeEngine())
    }

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

    /// Routes transcripts to target conversation even after a chat switch.
    func depositToDraft(text: String, conversationID: UUID) {
        guard conversations.contains(where: { $0.id == conversationID }) else { return }
        if conversationID == selectedID {
            draft = draft.isEmpty ? text : draft + "\n" + text
        } else if var stashed = drafts[conversationID] {
            stashed.text = stashed.text.isEmpty ? text : stashed.text + "\n" + text
            drafts[conversationID] = stashed
        } else {
            drafts[conversationID] = ChatDraft(text: text, attachments: [])
        }
    }

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

    /// Uses captured target chat ID so slow picks never land in a switched chat.
    @discardableResult
    func deposit(_ attachments: [Attachment], for conversationID: UUID) -> Bool {
        guard conversations.contains(where: { $0.id == conversationID }) else { return false }
        guard !attachments.isEmpty else { return selectedID == conversationID }
        if selectedID == conversationID {
            self.attachments.append(contentsOf: attachments)
            return true
        }
        var stashed = drafts[conversationID] ?? ChatDraft()
        stashed.attachments.append(contentsOf: attachments)
        drafts[conversationID] = stashed
        return false
    }

    func togglePinned(_ id: UUID) {
        guard let conv = conversations.first(where: { $0.id == id }) else { return }
        conv.isPinned.toggle()
        save(conv)
        saveIndex()
    }

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
        // Purge after switch in case selection stashed old draft under deleted ID.
        for id in ids { drafts.removeValue(forKey: id) }
        // Save index first so a crash leaves orphan files rather than ghost chats.
        saveIndex()
        persistence?.delete(Array(ids))
    }

    // MARK: Sending / running

    func send(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        guard let conv = selected else { return }
        // Require consent before first live send; keeps draft intact meanwhile.
        if let needed = consentNeeded() {
            pendingConsent = ConsentRequest(host: needed.host, providerName: needed.providerName,
                                            connectorNames: connectorNames(for: conv),
                                            conversationID: conv.id,
                                            action: .send(text: text, attachments: attachments))
            return
        }
        var turn = Turn(id: nextTurnID, userText: trimmed, attachments: attachments, modelID: model.id)
        turn.engine = engine.kind
        if !engine.buildsUserMessage {
            turn.transcript = [userMessage(trimmed, in: conv, before: conv.turns.count)]
        }
        nextTurnID = UUID()
        attachmentStore.persist(attachments.map(\.id))
        let retitle = conv.wantsTitle(for: trimmed)
        conv.turns.append(turn)
        if retitle, let title = ConversationTitle.make(text: trimmed, attachments: turn.attachments) {
            conv.title = title
        }
        conv.updatedAt = Date()
        attachments = []
        draft = ""
        // Clear sent draft so switching chats cannot resurrect it.
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

    func edit(turnID: UUID) {
        guard let conv = selected, let idx = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        draft = conv.turns[idx].userText
        if let run = runs[conv.id], conv.turns[idx...].contains(where: { $0.id == run.turnID }) {
            cancelRun(conv.id)
        }
        forget(Array(conv.turns[idx...]))
        conv.turns.removeSubrange(idx..<conv.turns.count)
        // Reset title when editing first message so resend re-titles it.
        if idx == 0 { conv.title = ConversationTitle.placeholder }
        save(conv)
        saveIndex()
    }

    func resend(turnID: UUID) {
        guard let conv = selected, let turn = conv.turns.first(where: { $0.id == turnID }) else { return }
        send(text: turn.userText)
    }

    func stop() {
        guard let selectedID else { return }
        stop(conversationID: selectedID)
    }

    func stop(conversationID: UUID) {
        guard let handle = runs.removeValue(forKey: conversationID) else { return }
        background.runStopped(conversationID: conversationID)
        handle.cancelled.cancel()
        handle.task?.cancel()
        elicitationCenter?.cancel(scope: handle.elicitationScope)
        // Drain before denying approvals so undrained waiters still resolve.
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

    /// Resumes as new turn from committed transcript; omits partial stream text.
    func continueRun(conversationID: UUID) {
        guard let conv = conversation(conversationID),
              conv.turns.last?.outcome == .pausedBackground,
              runs[conversationID] == nil else { return }
        selectedID = conversationID
        send(text: "Continue")
    }

    /// Settles like stop() on background expiry, then marks turn paused.
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
        cloudReplica?.background()
        background.appDidEnterBackground(running: Set(runs.keys))
    }

    func appDidBecomeActive() {
        cloudReplica?.foreground()
        background.appDidBecomeActive(running: Set(runs.keys))
    }

    // MARK: AI-data consent

    /// Allow records consent and sends; decline keeps draft and attachments.
    func resolveConsent(allow: Bool) {
        guard let request = pendingConsent else { return }
        pendingConsent = nil
        guard conversation(request.conversationID) != nil else { return }
        // Stash current draft before overwriting with held send.
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
            voiceRetryTranscription?(recordingID)
        }
    }

    private func consentNeeded() -> (host: String, providerName: String)? {
        guard engine.kind == .live else { return nil }
        return services?.consentNeeded()
    }

    private func connectorNames(for conv: Conversation) -> [String] {
        guard let library = services?.connectors else { return [] }
        let ids = frozenServerIDs(of: conv).map { Array($0) } ?? enabledConnectorIDs(for: conv)
        return ids.filter { !conv.disabledServerIDs.contains($0) }.compactMap { library.server($0)?.name }.sorted()
    }

    // Narrow hook so replica adapters never mutate handles or policies.
    var cloudPersistenceForCleanup: ConversationStore? { persistence }
    func persistConversation(_ conv: Conversation) { save(conv) }
    func detachCloudRun(_ id: UUID) {
        guard let handle = runs.removeValue(forKey: id) else { return }
        handle.task?.cancel()
        approvals.denyAll(handle.approvalIDs.union(approvalIDs(in: handle.inbox.drain().events)))
        cloudElicitations.cancel(scope: handle.elicitationScope)
        background.runStopped(conversationID: id)
    }
    func resetCloudStorage() { persistence = nil; policy = ToolPolicy() }
    func installCloudStorage(_ disk: ConversationStore, policy: ToolPolicy?) {
        persistence = disk
        if let policy { self.policy = policy }
    }
    func persistCloudProjection(_ changed: [Conversation], indexChanged: Bool) {
        guard !changed.isEmpty || indexChanged else { return }
        let index = ConversationStore.Index(conversations: conversations.map {
            .init(id: $0.id, title: $0.title, updatedAt: $0.updatedAt, isPinned: $0.isPinned)
        }, policy: policy)
        persistence?.saveBatch(changed.map(\.record), index: index)
    }
    func restoreCloudTurn(_ id: UUID, in conv: Conversation) {
        guard let index = conv.turns.firstIndex(where: { $0.id == id }) else { return }
        conv.turns[index].blocks = []; conv.turns[index].transcript = []
        startRun(in: conv, turnID: id)
    }

    private func startRun(in conv: Conversation, turnID: UUID) {
        // Settle active run before replacing so its turn never hangs as running.
        stop(conversationID: conv.id)
        collapseTasks.removeValue(forKey: turnID)?.cancel()
        evictRevealedLiveTexts(in: conv)
        guard let ti = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        conv.turns[ti].isRunning = true
        conv.turns[ti].isFinished = false
        conv.turns[ti].outcome = nil

        let handle = RunHandle(conversationID: conv.id, turnID: turnID, turnIndex: ti)
        var request = makeRequest(conv, turnIndex: ti)
        request.cloudChatID = conv.cloudChatID
        request.cloudRunID = conv.turns[ti].cloudRunID
        request.cloudClientTurnID = conv.turns[ti].cloudClientTurnID
        request.cloudMayStart = conv.turns[ti].cloudRemoteOrigin != true
        let flag = handle.cancelled
        request.isCancelled = { flag.isCancelled }
        request.elicitationScope = handle.elicitationScope
        runs[conv.id] = handle
        background.runStarted(conversationID: conv.id, turnID: turnID, title: conv.displayTitle, modelName: model.name,
                              continuesOnServer: engine.kind == .cloud)
        let stream = AgentEventCoalescer.coalesce(engine.run(request), interval: coalesceInterval)
        let inbox = handle.inbox
        let store = WeakStore(value: self)
        handle.task = Task.detached(priority: .userInitiated) {
            await EventInbox.pump(stream, into: inbox) {
                Task { @MainActor in store.value?.drain(handle) }
            }
        }
    }

    private func cancelRun(_ conversationID: UUID) {
        guard let handle = runs.removeValue(forKey: conversationID) else { return }
        background.runStopped(conversationID: conversationID)
        handle.cancelled.cancel()
        handle.task?.cancel()
        elicitationCenter?.cancel(scope: handle.elicitationScope)
        approvals.denyAll(handle.approvalIDs.union(approvalIDs(in: handle.inbox.drain().events)))
    }

    private func drain(_ handle: RunHandle) {
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
            change.merge(handle.reducer.finish(&turn, outcome: .completed, at: now))
        }

        // Apply live text before mutating turn so new blocks find their state.
        applyLiveText(change)
        // Skip turn update on text-only batches to avoid per-token re-renders.
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
        if change.effects.contains(.finished), let lifecycle = cloudReplica?.lifecycle, let persistence, let runID = turn.cloudRunID {
            Task {
                await persistence.flush()
                await lifecycle.projectionCommitted(runID: runID)
            }
        }
    }

    private func applyLiveText(_ change: TurnReducer.Change) {
        for id in change.openedText where liveTexts[id] == nil { liveTexts[id] = LiveText(id: id) }
        // Coalesce to one incremental parse per block per batch.
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

    /// Folds on run completion so layout shifts never fight active streaming.
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
                            let waiting = act.steps.contains(where: \.isWaitingOnUser)
                            if act.userExpanded == nil, act.isExpanded, !waiting { act.isExpanded = false }
                        }
                    }
                }
            }
        }
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

    /// Stored on model since scroll recycling recreates rows.
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

    /// Updates owning conversation directly across chat switches.
    private func updateTurn(_ turnID: UUID, _ mutate: (inout Turn) -> Void) {
        guard let conv = owner(of: turnID), let ti = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        mutate(&conv.turns[ti])
    }

    private func owner(of turnID: UUID) -> Conversation? {
        selected.flatMap { $0.turns.contains { $0.id == turnID } ? $0 : nil }
            ?? conversations.first { $0.turns.contains { $0.id == turnID } }
    }

    func conversation(_ id: UUID) -> Conversation? {
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

    /// Retire finished live text before next run so rows read from cache.
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

    func flushPersistence() async {
        await persistence?.flush()
    }
}

enum SettingsPage: Hashable {
    case root, connectors, skills
    case connector(String)
    case voice
}

struct WeakStore: Sendable {
    weak var value: ChatStore?
}
