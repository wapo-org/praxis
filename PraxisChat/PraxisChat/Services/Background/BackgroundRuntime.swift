import BackgroundTasks
import Foundation
import UIKit
import AgentCore

/// One run's progress for the system UI: total 1000, +40 per completed
/// step and +1 per coalesced text batch (both capped at 950 so the bar
/// never sits full while the run is still going), 1000 exactly at end.
/// Monotonic by construction — the only mutation is `finish()` jumping
/// to the top. Pure value type: the mapping is unit-testable with no
/// task, which the simulator can't provide (BACKGROUND_PLAN.md §2.4).
struct BackgroundProgressDriver: Equatable, Sendable {
    static let total: Int64 = 1000
    static let stepIncrement: Int64 = 40
    static let textIncrement: Int64 = 1
    static let cap: Int64 = 950

    private(set) var completed: Int64 = 0

    mutating func stepCompleted() {
        completed = min(Self.cap, completed + Self.stepIncrement)
    }

    mutating func textBatch() {
        completed = min(Self.cap, completed + Self.textIncrement)
    }

    mutating func finish() {
        completed = Self.total
    }
}

/// Per-run background state, keyed by conversation id in
/// `BackgroundRuntime` so `RunHandle` stays untouched (plan §2.1).
struct RunBackgroundState {
    var taskRequestID: String
    var title: String
    var startedAt: Date
    var continuedTask: BGContinuedProcessingTask?
    var fallbackTask: UIBackgroundTaskIdentifier?
    var driver = BackgroundProgressDriver()
    var stepCount = 0
    var phase = RunPhase.thinking
    var lastLine = "Thinking…"
    var toolName: String?
    /// A pause is settling through `stop()`: it must end neither the
    /// task nor the reporter — `runPaused()` does, after the outcome
    /// overwrite (plan §2.3 order).
    var pausing = false
    /// Finished titles of calls seen starting, for the "finished title
    /// until the next event" line.
    var titlesByCall: [String: StepPresentation.Titles] = [:]
}

/// Carries the launched task across the launch handler's domain hop.
/// BGTask is driven from whatever queue the handler runs on by
/// framework design (expiry also fires off the main actor), so sharing
/// the reference until the main-actor bind is sound.
private struct UncheckedBGTask: @unchecked Sendable {
    let task: BGContinuedProcessingTask
}

/// Owns every run's background execution (plan §2): submits one
/// `BGContinuedProcessingTask` per run at send time, binds the launched
/// task, drives its `NSProgress` from drain batches, reports to the
/// Live Activity reporter, and falls back to `beginBackgroundTask`
/// when submission fails (always, in the simulator). Expiry settles
/// through the store's pause path, never losing partial output.
///
/// Shared nothing: the store owns one runtime and calls it from its
/// run hooks; the runtime calls back only to pause and to install the
/// notification delegate. Test seams (`submitRequest` et al.) default
/// to the live singletons.
@MainActor
final class BackgroundRuntime: Sendable {
    /// Info.plist holds the `run.*` wildcard; each submission appends
    /// an 8-hex suffix (plan §2.1).
    static let taskIDPrefix = "com.praxis.chat.preview.run."
    static let fallbackTaskName = "Praxis run"
    /// DEBUG-only: UI tests pass `-PraxisSimulateBackgroundExpiry YES`
    /// so a backgrounded run pauses a few seconds after the fallback
    /// task opens, exercising the real expiry path without waiting
    /// out the ~30 s grace.
    static let simulateExpiryFlag = "PraxisSimulateBackgroundExpiry"

    private let reporter: any RunActivityReporter
    let notifications: BackgroundNotifications
    weak var store: ChatStore?

    /// Set by the scene-phase observer; batches consult it before
    /// posting anything (plan §2.5–2.6).
    var isBackgrounded = false

    /// Seams (tests inject fakes; defaults are the live singletons).
    /// Main-actor state, only ever invoked on the main actor.
    var submitRequest: (BGContinuedProcessingTaskRequest) throws -> Void = {
        try BGTaskScheduler.shared.submit($0)
    }
    var registerHandler: (String, @escaping @Sendable (BGTask) -> Void) -> Bool = {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: $0, using: .main, launchHandler: $1)
    }
    var cancelRequest: (String) -> Void = {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: $0)
    }
    var beginFallbackTask: (String, @escaping @Sendable () -> Void) -> UIBackgroundTaskIdentifier = {
        UIApplication.shared.beginBackgroundTask(withName: $0, expirationHandler: $1)
    }
    var endFallbackTask: (UIBackgroundTaskIdentifier) -> Void = {
        UIApplication.shared.endBackgroundTask($0)
    }

    /// Runs with background state (tests read through this).
    private(set) var states: [UUID: RunBackgroundState] = [:]

    /// `reporter` is `NoOpRunActivityReporter` until bg swaps in
    /// bg-live's implementation at integration (plan §6: one line).
    init(reporter: any RunActivityReporter = NoOpRunActivityReporter(),
         notifications: BackgroundNotifications = BackgroundNotifications()) {
        self.reporter = reporter
        self.notifications = notifications
    }

    // MARK: Run start

    /// Registers and submits the run's continued task (plan §2.1).
    /// Called after the run is registered, so `stop()` settling still
    /// works when submission throws. Any failure just means the
    /// scene-phase fallback (§2.2) covers this run.
    func runStarted(conversationID: UUID, turnID _: UUID, title: String, modelName: String) {
        let taskID = Self.taskIDPrefix + String(UUID().uuidString.prefix(8)).lowercased()
        states[conversationID] = RunBackgroundState(taskRequestID: taskID, title: title, startedAt: Date())
        // Dynamic registration is exempt from the register-before-launch
        // rule for continued tasks; the random suffix keeps every id
        // unique, so no id is ever registered twice (the system kills
        // the app for that).
        let handler: @Sendable (BGTask) -> Void = { [weak self, taskID] task in
            guard let continued = task as? BGContinuedProcessingTask else { return }
            let boxed = UncheckedBGTask(task: continued)
            Task { @MainActor in self?.bindLaunchedTask(boxed.task, id: taskID) }
        }
        if registerHandler(taskID, handler) {
            let request = BGContinuedProcessingTaskRequest(identifier: taskID, title: title, subtitle: "Starting…")
            // `.queue` (the default) vs `.fail` only changes which error
            // we get under load — both fall back identically. Case name
            // re-verified against BGTaskRequest.h (Queue, not Enqueue).
            request.strategy = .queue
            try? submitRequest(request)
        }
        // A Continued run supersedes a paused one: its stale approval
        // notification (kept by the pause path, plan §2.3) goes away.
        let center = notifications
        Task { await center.withdrawApprovals(for: conversationID) }
        let reporter = reporter
        Task { await reporter.began(conversationID: conversationID, title: title, modelName: modelName) }
    }

    /// The system launched our task (possibly while still foregrounded):
    /// attach expiry, seed progress, and let it supersede the fallback.
    func bindLaunchedTask(_ task: BGContinuedProcessingTask, id taskID: String) {
        guard let conversationID = states.first(where: { $0.value.taskRequestID == taskID })?.key else {
            // The run ended before its launch arrived: complete at once.
            task.setTaskCompleted(success: true)
            return
        }
        states[conversationID]?.continuedTask = task
        task.expirationHandler = { [weak self, conversationID] in
            Task { @MainActor in self?.expireContinuedTask(id: conversationID) }
        }
        task.progress.totalUnitCount = BackgroundProgressDriver.total
        if let state = states[conversationID] {
            task.progress.completedUnitCount = state.driver.completed
            task.updateTitle(state.title, subtitle: state.lastLine)
        }
        if let fallback = states[conversationID]?.fallbackTask, fallback != .invalid {
            endFallbackTask(fallback)
            states[conversationID]?.fallbackTask = nil
        }
    }

    // MARK: Batches

    /// Folds one drain batch into progress, the reporter and (when
    /// backgrounded) approval notifications. Costs no extra main-actor
    /// hops: the store calls it with the batch it already holds.
    func reportBatch(conversationID: UUID, title _: String, events: [AgentEvent]) {
        guard var state = states[conversationID] else { return }
        let previousPhase = state.phase
        var phase = state.phase
        var line = state.lastLine
        var tool = state.toolName
        var textStreamed = false
        for event in events {
            switch event {
            case .toolCallStarted(let activity), .toolCallReady(let activity):
                let titles = StepPresentation.titles(for: activity)
                state.titlesByCall[activity.id] = titles
                phase = .runningTool
                line = Self.runningLine(titles)
                tool = titles.source ?? Self.displayToolName(activity.name)
            case .toolRunning(let id):
                if let titles = state.titlesByCall[id] {
                    phase = .runningTool
                    line = Self.runningLine(titles)
                    tool = titles.source ?? tool
                } else {
                    phase = .runningTool
                    line = "Running…"
                }
            case .toolAwaitingApproval(let request):
                let name = Self.displayToolName(request.toolName)
                phase = .needsApproval
                line = "Needs approval: \(name)"
                tool = name
                if isBackgrounded {
                    let center = notifications
                    let chatTitle = state.title
                    Task {
                        await center.postApproval(requestID: request.id, tool: name, chatTitle: chatTitle,
                                                  conversationID: conversationID)
                    }
                }
            case .toolApprovalResolved(let id, _):
                phase = .thinking
                line = "Thinking…"
                tool = nil
                let center = notifications
                Task { await center.withdrawApproval(id, conversationID: conversationID) }
            case .toolFinished(let id, let completion):
                state.stepCount += 1
                state.driver.stepCompleted()
                if let titles = state.titlesByCall.removeValue(forKey: id) {
                    phase = .thinking
                    line = titles.finished
                    tool = nil
                } else if phase != .needsApproval {
                    phase = .thinking
                    line = completion.summary.isEmpty ? "Thinking…" : completion.summary
                    tool = nil
                }
            case .textDelta:
                textStreamed = true
            case .textFinished:
                state.stepCount += 1
                state.driver.stepCompleted()
                if phase == .thinking {
                    line = "Thinking…"
                    tool = nil
                }
            default:
                break
            }
        }
        if textStreamed {
            state.driver.textBatch()
            // Token text never leaves the app (lock-screen privacy, the
            // 4 KB cap, the update budget): streaming reads as one line.
            if phase == .thinking {
                line = "Writing answer…"
                tool = nil
            }
        }
        state.phase = phase
        // The reporter's line stays short (bg-live truncates again; the
        // system title gets the same text).
        state.lastLine = StepPresentation.clip(line, limit: 140) ?? "Thinking…"
        state.toolName = tool
        states[conversationID] = state
        if let task = state.continuedTask {
            task.progress.completedUnitCount = state.driver.completed
            if phase != previousPhase {
                task.updateTitle(state.title, subtitle: state.lastLine)
            }
        }
        let reporter = reporter
        let update = (phase, state.stepCount, state.startedAt, state.lastLine, state.toolName)
        Task {
            await reporter.update(conversationID: conversationID, phase: update.0, stepCount: update.1,
                                  startedAt: update.2, lastLine: update.3, toolName: update.4)
        }
    }

    // MARK: Run end

    /// A finished run: completion notification when backgrounded, task
    /// completed, request slot released, activity ended (plan §2.6).
    func runFinished(conversationID: UUID, title _: String, turn: Turn) {
        guard let state = states.removeValue(forKey: conversationID) else { return }
        var driver = state.driver
        driver.finish()
        let runPhase: RunPhase
        let line: String
        switch turn.outcome {
        case .completed, .none:
            runPhase = .done
            line = "Done · \(state.stepCount) steps · \(Self.elapsed(state.startedAt))s"
        default:
            runPhase = .failed
            line = turn.outcome?.note ?? "Couldn't finish"
        }
        if isBackgrounded {
            let center = notifications
            let body = BackgroundNotifications.completionBody(for: turn)
            let chatTitle = state.title
            Task {
                await center.withdrawApprovals(for: conversationID)
                await center.postCompletion(title: chatTitle, body: body, conversationID: conversationID)
            }
        } else {
            let center = notifications
            Task { await center.withdrawApprovals(for: conversationID) }
        }
        if let task = state.continuedTask {
            task.progress.completedUnitCount = driver.completed
            task.setTaskCompleted(success: true)
        }
        cancelRequest(state.taskRequestID)
        if let fallback = state.fallbackTask, fallback != .invalid {
            endFallbackTask(fallback)
        }
        let reporter = reporter
        Task { await reporter.ended(conversationID: conversationID, phase: runPhase, lastLine: line) }
    }

    /// A stopped, cancelled or deleted run: everything ends at once.
    /// Under `beginPause` only the bookkeeping runs — the pause path
    /// ends the task and the reporter itself, in plan §2.3 order.
    func runStopped(conversationID: UUID) {
        guard let state = states[conversationID] else { return }
        if state.pausing { return }
        states.removeValue(forKey: conversationID)
        if let task = state.continuedTask {
            task.setTaskCompleted(success: true)
        }
        cancelRequest(state.taskRequestID)
        if let fallback = state.fallbackTask, fallback != .invalid {
            endFallbackTask(fallback)
        }
        let center = notifications
        Task { await center.withdrawApprovals(for: conversationID) }
        let reporter = reporter
        Task { await reporter.ended(conversationID: conversationID, phase: .done, lastLine: "Stopped") }
    }

    func beginPause(conversationID: UUID) {
        states[conversationID]?.pausing = true
    }

    /// After `stop()` settled and the store overwrote the outcome:
    /// end the task cleanly (`success: true` — the checkpoint is clean,
    /// no system retry, no "Task Failed" card) and the activity as
    /// paused. No completion notification, and the approval one stays
    /// (it still deep-links back to the chat).
    func runPaused(conversationID: UUID) {
        guard let state = states.removeValue(forKey: conversationID) else { return }
        if let task = state.continuedTask {
            task.setTaskCompleted(success: true)
        }
        cancelRequest(state.taskRequestID)
        if let fallback = state.fallbackTask, fallback != .invalid {
            endFallbackTask(fallback)
        }
        let reporter = reporter
        Task { await reporter.ended(conversationID: conversationID, phase: .paused, lastLine: "Paused in background") }
    }

    // MARK: Scene phase

    /// Backgrounded with runs in flight: permission gate once ever,
    /// plus one ~30 s fallback task per run without a continued task.
    /// No-op when nothing runs.
    func appDidEnterBackground(running: Set<UUID>) {
        isBackgrounded = true
        let active = running.filter { states[$0] != nil }
        guard !active.isEmpty else { return }
        let center = notifications
        Task { await center.ensureFirstRunPermission() }
        var opened: [UUID] = []
        for conversationID in active {
            guard states[conversationID]?.continuedTask == nil,
                  states[conversationID]?.fallbackTask == nil else { continue }
            let expiration: @Sendable () -> Void = { [weak self, conversationID] in
                Task { @MainActor in self?.expireFallbackTask(id: conversationID) }
            }
            let fallback = beginFallbackTask(Self.fallbackTaskName, expiration)
            if fallback == .invalid {
                // No grace at all: settle now rather than be killed.
                store?.pauseRunForBackground(conversationID: conversationID)
            } else {
                states[conversationID]?.fallbackTask = fallback
                opened.append(conversationID)
            }
        }
        #if DEBUG
            if !opened.isEmpty, UserDefaults.standard.bool(forKey: Self.simulateExpiryFlag) {
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(3))
                    guard let self else { return }
                    for conversationID in opened {
                        self.store?.pauseRunForBackground(conversationID: conversationID)
                    }
                }
            }
        #endif
    }

    /// Foreground again: every fallback task ends (a later backgrounding
    /// opens a fresh one) and activities reconcile with live runs.
    func appDidBecomeActive(running: Set<UUID>) {
        isBackgrounded = false
        for id in states.keys {
            if let fallback = states[id]?.fallbackTask, fallback != .invalid {
                endFallbackTask(fallback)
            }
            states[id]?.fallbackTask = nil
        }
        let reporter = reporter
        Task { await reporter.reconcile(activeConversationIDs: running) }
    }

    /// Launch: no runs yet — just reconcile orphaned activities.
    func appDidLaunch() {
        let reporter = reporter
        Task { await reporter.reconcile(activeConversationIDs: []) }
    }

    func installNotificationDelegate() {
        if let store {
            notifications.installDelegate(store: store)
        }
    }

    // MARK: Expiry

    private func expireContinuedTask(id: UUID) {
        store?.pauseRunForBackground(conversationID: id)
    }

    private func expireFallbackTask(id: UUID) {
        store?.pauseRunForBackground(conversationID: id)
    }

    // MARK: Lines

    /// The activity row's shape: running title, plus the key argument
    /// when the row shows one ("Reading request.txt" reads the same on
    /// the lock screen as in the app).
    static func runningLine(_ titles: StepPresentation.Titles) -> String {
        guard let detail = titles.detail else { return titles.running }
        return Step.trimmingEllipsis(titles.running) + ": \(detail)"
    }

    /// `read_file` → "Read file", `mcp__exa__web_search_exa` →
    /// "Web search exa": short, stable, provider-agnostic.
    static func displayToolName(_ name: String) -> String {
        let human = StepPresentation.humanizedToolName(name)
        return human.prefix(1).uppercased() + human.dropFirst()
    }

    private static func elapsed(_ start: Date) -> Int {
        max(0, Int(Date.now.timeIntervalSince(start)))
    }
}
