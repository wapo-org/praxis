import Foundation
import AgentCore

/// Keeps the presentation stream open across transport detaches. Only an
/// explicit cancellation flag sends cancel; backgrounding cancels the reader.
actor CloudLifecycleEngine: ChatEngine {
    nonisolated let kind: EngineKind = .cloud
    nonisolated let buildsUserMessage = true
    private let client: CloudAPIClient
    private let journal: CloudRunJournal
    private let elicitations: ElicitationCenter
    private let onRunStarted: @Sendable (UUID, UUID, String) async -> Void
    private var backgrounded = false
    private var transition = UUID()
    private var detachedReaders: [CloudReaderShutdown] = []
    private struct Active {
        let identity: UUID
        var request: ChatRunRequest
        var output: AsyncStream<AgentEvent>.Continuation
        var worker: Task<Void, Never>?
        var generation = UUID()
        var runID: String?
        var terminalPublished = false
        var uiReplayed = false
        var shutdown: CloudReaderShutdown?
    }
    private var active: [UUID: Active] = [:]

    init(client: CloudAPIClient, journal: CloudRunJournal, elicitations: ElicitationCenter, backgrounded: Bool = false,
         onRunStarted: @escaping @Sendable (UUID, UUID, String) async -> Void = { _, _, _ in }) {
        self.onRunStarted = onRunStarted
        self.backgrounded = backgrounded
        self.client = client; self.journal = journal; self.elicitations = elicitations
    }
    nonisolated func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent> {
        AsyncStream { output in
            let identity = UUID()
            let start = Task { await self.begin(request, output: output, identity: identity) }
            output.onTermination = { _ in Task { await start.value; await self.end(request.turnID, identity: identity) } }
        }
    }
    func registerRemoteRun(conversationID: UUID, turnID: UUID, runID: String) async throws {
        try await journal.register(.init(conversationID: conversationID, turnID: turnID, runID: runID))
    }
    func projectionCommitted(runID: String) async { try? await journal.remove(runID: runID) }
    private func begin(_ request: ChatRunRequest, output: AsyncStream<AgentEvent>.Continuation, identity: UUID) {
        active[request.turnID] = Active(identity: identity, request: request, output: output)
        if !backgrounded { attach(request.turnID) }
    }
    private func end(_ key: UUID, identity: UUID) async {
        guard active[key]?.identity == identity, let state = active.removeValue(forKey: key) else { return }
        state.worker?.cancel()
        if state.request.isCancelled() {
            let records = await journal.records()
            let runID = state.runID ?? records.first(where: { $0.turnID == key })?.runID
            if let runID { try? await CloudChatEngine(client: client).cancel(runID: runID) }
            else {
                // A background detach can interrupt the POST response after
                // the server created the run. Retry the same persisted turn
                // key, obtain its id and let the flagged engine cancel it.
                for await _ in CloudChatEngine(client: client).run(state.request) {}
            }
        }
    }
    func setBackgrounded(_ value: Bool) async {
        let revision = UUID()
        transition = revision
        backgrounded = value
        if !value {
            // Retain the drain barriers until this transition actually wins.
            // A newer foreground must not bypass a suspended older foreground.
            for reader in detachedReaders {
                await reader.wait()
                guard transition == revision, !backgrounded else { return }
            }
            guard transition == revision, !backgrounded else { return }
            detachedReaders.removeAll()
        }
        for key in Array(active.keys) {
            if value {
                active[key]?.generation = UUID()
                if let shutdown = active[key]?.shutdown { detachedReaders.append(shutdown) }
                active[key]?.worker?.cancel()
                active[key]?.worker = nil
            } else if active[key]?.worker == nil { attach(key) }
        }
    }
    /// Sign-out detaches without cancelling durable server work.
    func detachAll() {
        let previous = active.values
        active.removeAll()
        for state in previous { state.worker?.cancel(); state.output.finish() }
    }
    func eraseAccountJournal() async {
        detachAll()
        try? await journal.erase()
    }
    private func attach(_ key: UUID) {
        guard let state = active[key], !backgrounded else { return }
        let replayUI = !state.uiReplayed
        let generation = UUID()
        active[key]?.generation = generation
        active[key]?.worker = Task { await self.consume(key, generation: generation, replayUI: replayUI) }
    }
    private func consume(_ key: UUID, generation: UUID, replayUI: Bool) async {
        guard let state = active[key] else { return }
        do {
            let records = await journal.records()
            let runID = state.runID ?? records.first { $0.turnID == key }?.runID
            let replay = runID == nil ? CloudRunJournal.Replay(events: [], cursor: 0, byteCount: 0) : await journal.replay(runID: runID!)
            var payloads: [CloudEventPayload] = []
            if let raw = replay.snapshot {
                payloads += try JSONDecoder().decode(CloudRunSnapshot.self, from: raw).presentationEvents()
            }
            for raw in replay.events { payloads.append(try JSONDecoder().decode(CloudRunEvent.self, from: raw).event) }
            let mapper = CloudEventMapper(request: state.request)
            var approvals: [String: CloudEventPayload] = [:]
            var forms: [String: CloudEventPayload] = [:]
            var terminal = false
            for payload in payloads {
                switch payload {
                case .approval(let a): approvals[a.callId] = payload
                case .approvalResolved(let id, _): approvals.removeValue(forKey: id)
                case .elicitation(let e): forms[e.id] = payload
                case .elicitationResolved(let id): forms.removeValue(forKey: id)
                case .finished: terminal = true; approvals.removeAll(); forms.removeAll()
                default: break
                }
                let events = await mapper.map(payload)
                if replayUI { deliver(events, key: key, identity: state.identity) }
            }
            if active[key]?.identity == state.identity { active[key]?.uiReplayed = true }
            if terminal { if valid(key, generation) { state.output.finish() }; return }
            guard valid(key, generation), !Task.isCancelled else { return }
            let journal = journal
            let shutdown = CloudReaderShutdown()
            active[key]?.shutdown = shutdown
            var engine = CloudChatEngine(client: client, elicitations: elicitations,
                onRunStarted: { conversation, turn, id in
                    try? await journal.register(.init(conversationID: conversation, turnID: turn, runID: id))
                    if await self.started(key, generation: generation, runID: id) {
                        await self.onRunStarted(conversation, turn, id)
                    }
                }, onEvent: { _, _, id, data in
                    guard try await journal.append(data, runID: id) else { return }
                    let event = try JSONDecoder().decode(CloudRunEvent.self, from: data)
                    // Publish from the durable hook, before transport acknowledgment.
                    // Cancellation cannot strand a journaled delta in an inner buffer.
                    let mapped = await mapper.map(event.event)
                    await self.deliver(mapped, key: key, identity: state.identity)
                }, onSnapshot: { _, _, id, data in
                    try await journal.checkpoint(data, runID: id)
                    let snapshot = try JSONDecoder().decode(CloudRunSnapshot.self, from: data)
                    let mapped = try await mapper.replace(with: snapshot)
                    await self.deliver(mapped, key: key, identity: state.identity)
                })
            engine.priorEvents = payloads
            engine.onDetached = { await shutdown.finish() }
            let stream = runID.map { engine.resume(request: state.request, runID: $0, cursor: replay.cursor,
                                                   pendingEvents: Array(approvals.values) + Array(forms.values)) } ?? engine.run(state.request)
            for await event in stream {
                guard valid(key, generation), !Task.isCancelled else { return }
                // Wire events were published by the pre-ack hook. Only local
                // transport/cancellation verdicts have no corresponding wire event.
                if case .finished = event, active[key]?.terminalPublished != true {
                    deliver([event], key: key, identity: state.identity)
                }
            }
            if valid(key, generation), !Task.isCancelled { state.output.finish() }
        } catch {
            if valid(key, generation), !Task.isCancelled {
                state.output.yield(.finished(.failed(error.localizedDescription)))
                state.output.finish()
            }
        }
    }
    private func deliver(_ events: [AgentEvent], key: UUID, identity: UUID) {
        guard let state = active[key], state.identity == identity else { return }
        for event in events {
            if case .finished = event { active[key]?.terminalPublished = true }
            state.output.yield(event)
        }
    }
    private func valid(_ key: UUID, _ generation: UUID) -> Bool { active[key]?.generation == generation }
    private func started(_ key: UUID, generation: UUID, runID: String) -> Bool {
        guard valid(key, generation) else { return false }
        active[key]?.runID = runID
        return true
    }
}

/// Actor-owned continuations are resumed with no locks or cancellation handlers.
private actor CloudReaderShutdown {
    private var finished = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if finished { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func finish() {
        finished = true
        let pending = waiters; waiters.removeAll()
        for waiter in pending { waiter.resume() }
    }
}
