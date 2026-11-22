import BackgroundTasks
import Foundation
import UIKit
import AgentCore

/// Monotonic progress (capped at 950 until finish() -> 1000); pure for simulator-free tests.
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

/// Per-run background state stored outside RunHandle, keyed by conversationID.
struct RunBackgroundState {
    var taskRequestID: String
    /// Cloud execution survives suspension without a device background task.
    var continuesOnServer = false
    var title: String
    var startedAt: Date
    var continuedTask: BGContinuedProcessingTask?
    var fallbackTask: UIBackgroundTaskIdentifier?
    var driver = BackgroundProgressDriver()
    var stepCount = 0
    var phase = RunPhase.thinking
    var lastLine = "Thinking…"
    var toolName: String?
    /// Pause settling via stop() must not end task/reporter; runPaused() does after outcome update.
    var pausing = false
    var titlesByCall: [String: StepPresentation.Titles] = [:]
}

/// Transfers non-Sendable BGTask from system handler queue to MainActor bind.
private struct UncheckedBGTask: @unchecked Sendable {
    let task: BGContinuedProcessingTask
}

/// Manages BGContinuedProcessingTask & beginBackgroundTask fallback; expiry settles via pause.
@MainActor
final class BackgroundRuntime: Sendable {
    /// Matches Info.plist run.* wildcard; each submission appends a unique 8-hex suffix.
    static let taskIDPrefix = "com.praxis.chat.preview.run."
    static let fallbackTaskName = "Praxis run"
    /// UI test flag that triggers fallback expiry after a few seconds instead of waiting ~30 s.
    static let simulateExpiryFlag = "PraxisSimulateBackgroundExpiry"

    private let reporter: any RunActivityReporter
    let notifications: BackgroundNotifications
    weak var store: ChatStore?

    /// Updated by scene-phase observer; checked before posting background notifications.
    var isBackgrounded = false

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

    private(set) var states: [UUID: RunBackgroundState] = [:]

    init(reporter: any RunActivityReporter = NoOpRunActivityReporter(),
         notifications: BackgroundNotifications = BackgroundNotifications()) {
        self.reporter = reporter
        self.notifications = notifications
    }

    // MARK: Run start

    /// Must run after run registration so stop() works if submit throws (falls back on background).
    func runStarted(conversationID: UUID, turnID _: UUID, title: String, modelName: String,
                    continuesOnServer: Bool = false) {
        let taskID = Self.taskIDPrefix + String(UUID().uuidString.prefix(8)).lowercased()
        states[conversationID] = RunBackgroundState(taskRequestID: taskID, continuesOnServer: continuesOnServer, title: title, startedAt: Date())
        // Dynamic registration is exempt for continued tasks; unique suffix avoids duplicate-ID kill.
        let handler: @Sendable (BGTask) -> Void = { [weak self, taskID] task in
            guard let continued = task as? BGContinuedProcessingTask else { return }
            let boxed = UncheckedBGTask(task: continued)
            Task { @MainActor in self?.bindLaunchedTask(boxed.task, id: taskID) }
        }
        // SUNSET(native-loop): only device execution requests continued processing.
        if !continuesOnServer, registerHandler(taskID, handler) {
            let request = BGContinuedProcessingTaskRequest(identifier: taskID, title: title, subtitle: "Starting…")
            // .queue vs .fail only changes the error under load; both trigger the same fallback.
            request.strategy = .queue
            try? submitRequest(request)
        }
        // A resumed run supersedes the paused one, so withdraw its kept approval notification.
        let center = notifications
        Task { await center.withdrawApprovals(for: conversationID) }
        let reporter = reporter
        Task { await reporter.began(conversationID: conversationID, title: title, modelName: modelName) }
    }

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
                    // Never surface summary here: it may echo model-written args or raw errors onto lock screen.
                    phase = .thinking
                    line = completion.status == .succeeded ? "Thinking…" : "Step failed"
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
            // Never send token text to lock screen (privacy, 4 KB payload cap, update budget).
            if phase == .thinking {
                line = "Writing answer…"
                tool = nil
            }
        }
        state.phase = phase
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
        if !state.continuesOnServer { cancelRequest(state.taskRequestID) }
        if let fallback = state.fallbackTask, fallback != .invalid {
            endFallbackTask(fallback)
        }
        let reporter = reporter
        Task { await reporter.ended(conversationID: conversationID, phase: runPhase, lastLine: line) }
    }

    /// Under beginPause only clears bookkeeping; runPaused() ends task and reporter after outcome.
    func runStopped(conversationID: UUID) {
        guard let state = states[conversationID] else { return }
        if state.pausing { return }
        states.removeValue(forKey: conversationID)
        if let task = state.continuedTask {
            task.setTaskCompleted(success: true)
        }
        if !state.continuesOnServer { cancelRequest(state.taskRequestID) }
        if let fallback = state.fallbackTask, fallback != .invalid {
            endFallbackTask(fallback)
        }
        let center = notifications
        Task { await center.withdrawApprovals(for: conversationID) }
        let reporter = reporter
        Task { await reporter.ended(conversationID: conversationID, phase: .done, lastLine: "Stopped") }
    }

    func beginPause(conversationID: UUID) {
        guard states[conversationID]?.continuesOnServer != true else { return }
        states[conversationID]?.pausing = true
    }

    /// Complete task with success: true so iOS skips retry/Task Failed card; keep approval card.
    func runPaused(conversationID: UUID) {
        guard let state = states.removeValue(forKey: conversationID) else { return }
        if let task = state.continuedTask {
            task.setTaskCompleted(success: true)
        }
        if !state.continuesOnServer { cancelRequest(state.taskRequestID) }
        if let fallback = state.fallbackTask, fallback != .invalid {
            endFallbackTask(fallback)
        }
        let reporter = reporter
        Task { await reporter.ended(conversationID: conversationID, phase: .paused, lastLine: "Paused in background") }
    }

    // MARK: Scene phase

    func appDidEnterBackground(running: Set<UUID>) {
        isBackgrounded = true
        let active = running.filter { states[$0] != nil }
        guard !active.isEmpty else { return }
        let center = notifications
        Task { await center.ensureFirstRunPermission() }
        var opened: [UUID] = []
        for conversationID in active {
            // Cloud runs remain active on the server; suspension only detaches SSE.
            guard states[conversationID]?.continuesOnServer == false,
                  states[conversationID]?.continuedTask == nil,
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

    /// Reconcile orphaned activities and drop dead notification cards left by a prior kill.
    func appDidLaunch() {
        let reporter = reporter
        Task { await reporter.reconcile(activeConversationIDs: []) }
        let center = notifications
        Task { await center.clearRunNotifications() }
    }

    func installNotificationDelegate() {
        if let store {
            notifications.installDelegate(store: store)
        }
    }

    // MARK: Expiry

    private func expireContinuedTask(id: UUID) {
        guard states[id]?.continuesOnServer != true else { return }
        store?.pauseRunForBackground(conversationID: id)
    }

    private func expireFallbackTask(id: UUID) {
        guard states[id]?.continuesOnServer != true else { return }
        store?.pauseRunForBackground(conversationID: id)
    }

    // MARK: Lines

    static func runningLine(_ titles: StepPresentation.Titles) -> String {
        guard let detail = titles.detail else { return titles.running }
        return Step.trimmingEllipsis(titles.running) + ": \(detail)"
    }

    static func displayToolName(_ name: String) -> String {
        let human = StepPresentation.humanizedToolName(name)
        return human.prefix(1).uppercased() + human.dropFirst()
    }

    private static func elapsed(_ start: Date) -> Int {
        max(0, Int(Date.now.timeIntervalSince(start)))
    }
}
