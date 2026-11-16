import ActivityKit
import Foundation

// MARK: - Store seam

/// Test seam over ActivityKit static APIs (cannot be mocked directly); one activity per run.
@MainActor
protocol RunActivityStore: Sendable {
    var activitiesEnabled: Bool { get }
    func enablementUpdates() -> AsyncStream<Bool>
    func current() -> [UUID: RunActivityAttributes.ContentState]
    func request(attributes: RunActivityAttributes,
                 state: RunActivityAttributes.ContentState,
                 staleDate: Date, relevanceScore: Double) async throws
    func update(conversationID: UUID,
                state: RunActivityAttributes.ContentState,
                staleDate: Date, relevanceScore: Double) async
    func end(conversationID: UUID,
             state: RunActivityAttributes.ContentState,
             dismissalPolicy: ActivityUIDismissalPolicy) async
}

@MainActor
struct LiveActivityKitStore: RunActivityStore {
    typealias Content = RunActivityAttributes.ContentState

    var activitiesEnabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    func enablementUpdates() -> AsyncStream<Bool> {
        let updates = ActivityAuthorizationInfo().activityEnablementUpdates
        return AsyncStream { continuation in
            let task = Task { @MainActor in
                for await enabled in updates {
                    continuation.yield(enabled)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func current() -> [UUID: Content] {
        var out: [UUID: Content] = [:]
        for activity in Activity<RunActivityAttributes>.activities {
            out[activity.attributes.conversationID] = activity.content.state
        }
        return out
    }

    func request(attributes: RunActivityAttributes, state: Content,
                 staleDate: Date, relevanceScore: Double) async throws {
        // pushType nil = local only: no server, no push token.
        let content = ActivityContent(state: state, staleDate: staleDate,
                                      relevanceScore: relevanceScore)
        _ = try Activity<RunActivityAttributes>.request(attributes: attributes,
                                                        content: content, pushType: nil)
    }

    func update(conversationID id: UUID, state: Content,
                staleDate: Date, relevanceScore: Double) async {
        let content = ActivityContent(state: state, staleDate: staleDate,
                                      relevanceScore: relevanceScore)
        for activity in Activity<RunActivityAttributes>.activities
            where activity.attributes.conversationID == id {
            await activity.update(content)
        }
    }

    func end(conversationID id: UUID, state: Content,
             dismissalPolicy: ActivityUIDismissalPolicy) async {
        // Terminal states never go stale: staleDate nil.
        let content = ActivityContent(state: state, staleDate: nil, relevanceScore: 0)
        for activity in Activity<RunActivityAttributes>.activities
            where activity.attributes.conversationID == id {
            await activity.end(content, dismissalPolicy: dismissalPolicy)
        }
    }
}

// MARK: - Reporter

extension RunPhase {
    /// Terminal phases (done/failed/paused) keep their state when orphaned.
    var isTerminal: Bool {
        self == .done || self == .failed || self == .paused
    }
}

/// Throttled local-only ActivityKit reporter; all failures no-op so runs never depend on it.
@MainActor
final class LiveRunActivityReporter: RunActivityReporter {
    typealias Content = RunActivityAttributes.ContentState

    /// Non-phase updates: at most one per activity per interval.
    private static let updateInterval: TimeInterval = 5
    private static let staleAfter: TimeInterval = 60
    /// done/failed stay glanceable on the lock screen, then dismiss.
    private static let dismissAfter: TimeInterval = 5 * 60
    /// Keeps attributes + state far under the ~4 KB update limit.
    private static let maxLineLength = 140

    private let store: any RunActivityStore
    private let now: @Sendable () -> Date

    /// Recorded even when disabled so enablement flips/reconcile can start activities later.
    private var attributes: [UUID: RunActivityAttributes] = [:]
    /// Recorded even on throttled updates so ended() always has the latest state.
    private var lastState: [UUID: Content] = [:]
    private var liveIDs: Set<UUID> = []
    private var lastSentAt: [UUID: Date] = [:]
    private var lastSentPhase: [UUID: RunPhase] = [:]
    /// Newest run gets relevanceScore 100 (others 50) as a proxy for the active chat.
    private var mostRecentID: UUID?
    private var enablementTask: Task<Void, Never>?

    init(store: any RunActivityStore = LiveActivityKitStore(),
         now: @escaping @Sendable () -> Date = { Date() }) {
        self.store = store
        self.now = now
        // Watches enablement changes for app lifetime (weak self, no cycle) to start mid-run.
        enablementTask = Task { [weak self] in
            guard let updates = await self?.store.enablementUpdates() else { return }
            for await enabled in updates {
                guard enabled else { continue }
                await self?.startMissing()
            }
        }
    }

    // MARK: RunActivityReporter

    func began(conversationID id: UUID, title: String, modelName: String) async {
        let attrs = RunActivityAttributes(conversationID: id, chatTitle: title, modelName: modelName)
        attributes[id] = attrs
        mostRecentID = id
        if liveIDs.contains(id) || store.current()[id] != nil {
            liveIDs.insert(id) // double began, or adopted: nothing to start.
            return
        }
        guard store.activitiesEnabled else { return }
        let state = Content(phase: .thinking, stepCount: 0, startedAt: now(),
                            lastLine: "Thinking…", toolName: nil)
        lastState[id] = state
        do {
            try await store.request(attributes: attrs, state: state,
                                    staleDate: now().addingTimeInterval(Self.staleAfter),
                                    relevanceScore: relevance(for: id))
            liveIDs.insert(id)
            lastSentAt[id] = now()
            lastSentPhase[id] = .thinking
        } catch is ActivityAuthorizationError {
            // Denied, limits, unsupported — the run continues alone.
        } catch {
            // Same: a run NEVER depends on its activity.
        }
    }

    func update(conversationID id: UUID, phase: RunPhase, stepCount: Int,
                startedAt: Date, lastLine: String, toolName: String?) async {
        let state = Content(phase: phase, stepCount: stepCount, startedAt: startedAt,
                            lastLine: Self.truncate(lastLine), toolName: toolName)
        lastState[id] = state
        guard store.activitiesEnabled else { return }
        if !liveIDs.contains(id) {
            if store.current()[id] != nil {
                liveIDs.insert(id)
            } else if let attrs = attributes[id] {
                // Started disabled or prior request failed; request activity now since run is live.
                do {
                    try await store.request(attributes: attrs, state: state,
                                            staleDate: now().addingTimeInterval(Self.staleAfter),
                                            relevanceScore: relevance(for: id))
                    liveIDs.insert(id)
                    lastSentAt[id] = now()
                    lastSentPhase[id] = phase
                } catch {
                    // No-op; the next update retries.
                }
                return
            } else {
                return // update before began: no title/model, can't start.
            }
        }
        // Phase changes flush immediately; other updates coalesce in lastState at 5s intervals.
        if phase == lastSentPhase[id], let last = lastSentAt[id],
           now().timeIntervalSince(last) < Self.updateInterval {
            return
        }
        await store.update(conversationID: id, state: state,
                           staleDate: now().addingTimeInterval(Self.staleAfter),
                           relevanceScore: relevance(for: id))
        lastSentAt[id] = now()
        lastSentPhase[id] = phase
    }

    func ended(conversationID id: UUID, phase: RunPhase, lastLine: String) async {
        let base = lastState[id]
        let final = Content(phase: phase, stepCount: base?.stepCount ?? 0,
                            startedAt: base?.startedAt ?? now(),
                            lastLine: Self.truncate(lastLine), toolName: nil)
        if liveIDs.contains(id) || store.current()[id] != nil {
            await store.end(conversationID: id, state: final,
                            dismissalPolicy: Self.dismissal(for: phase, now: now()))
        }
        forget(id)
    }

    func reconcile(activeConversationIDs active: Set<UUID>) async {
        let current = store.current()
        for (id, state) in current where !active.contains(id) {
            // Orphaned activities never stay running; terminal states stay, mid-flight ones become paused.
            let terminal = state.phase.isTerminal
            let final = Content(
                phase: terminal ? state.phase : .paused,
                stepCount: state.stepCount, startedAt: state.startedAt,
                lastLine: terminal ? state.lastLine : "Paused in background",
                toolName: nil)
            await store.end(conversationID: id, state: final,
                            dismissalPolicy: Self.dismissal(for: final.phase, now: now()))
            forget(id)
        }
        for id in current.keys where active.contains(id) {
            liveIDs.insert(id)
        }
        // Snapshot the keys: forget() mutates the table we enumerate.
        for id in Array(attributes.keys) where !active.contains(id) && current[id] == nil {
            forget(id)
        }
        guard store.activitiesEnabled else { return }
        for id in active where current[id] == nil && !liveIDs.contains(id) {
            guard let attrs = attributes[id] else { continue }
            let state = lastState[id] ?? Content(phase: .thinking, stepCount: 0,
                                                 startedAt: now(), lastLine: "Thinking…", toolName: nil)
            do {
                try await store.request(attributes: attrs, state: state,
                                        staleDate: now().addingTimeInterval(Self.staleAfter),
                                        relevanceScore: relevance(for: id))
                liveIDs.insert(id)
                lastState[id] = state
                lastSentAt[id] = now()
                lastSentPhase[id] = state.phase
            } catch {
                // No-op; the next update or reconcile retries.
            }
        }
    }

    // MARK: Private

    /// Starts activities for begun runs on enable; ignores orphans (reconcile ends them).
    private func startMissing() async {
        guard store.activitiesEnabled else { return }
        let current = store.current()
        for (id, attrs) in attributes
            where !liveIDs.contains(id) && current[id] == nil {
            let state = lastState[id] ?? Content(phase: .thinking, stepCount: 0,
                                                 startedAt: now(), lastLine: "Thinking…", toolName: nil)
            do {
                try await store.request(attributes: attrs, state: state,
                                        staleDate: now().addingTimeInterval(Self.staleAfter),
                                        relevanceScore: relevance(for: id))
                liveIDs.insert(id)
                lastState[id] = state
                lastSentAt[id] = now()
                lastSentPhase[id] = state.phase
            } catch {
                // No-op; the next update or reconcile retries.
            }
        }
    }

    private func relevance(for id: UUID) -> Double {
        id == mostRecentID ? 100 : 50
    }

    private static func dismissal(for phase: RunPhase, now: Date) -> ActivityUIDismissalPolicy {
        switch phase {
        case .done, .failed: return .after(now.addingTimeInterval(dismissAfter))
        case .paused, .thinking, .runningTool, .needsApproval: return .default
        }
    }

    private static func truncate(_ line: String) -> String {
        guard line.count > maxLineLength else { return line }
        return String(line.prefix(maxLineLength - 1)) + "…"
    }

    private func forget(_ id: UUID) {
        liveIDs.remove(id)
        attributes.removeValue(forKey: id)
        lastState.removeValue(forKey: id)
        lastSentAt.removeValue(forKey: id)
        lastSentPhase.removeValue(forKey: id)
        if mostRecentID == id { mostRecentID = liveIDs.first }
    }
}
