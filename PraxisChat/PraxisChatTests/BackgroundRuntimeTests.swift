import BackgroundTasks
import Synchronization
import UserNotifications
import XCTest
import AgentCore
@testable import PraxisChat

/// Background runs (BACKGROUND_PLAN.md §2): progress mapping, the
/// simulator fallback path, pause/continue semantics, notification
/// mapping with a fake center, and approval-action routing.
@MainActor
final class BackgroundRuntimeTests: XCTestCase {
    // MARK: Fakes

    @MainActor
    final class FakeCenter: NotificationScheduling, Sendable {
        var authorizationRequests: [UNAuthorizationOptions] = []
        var authorizationResult: Result<Bool, any Error> = .success(true)
        var added: [UNNotificationRequest] = []
        var removedPending: [[String]] = []
        var removedDelivered: [[String]] = []
        var delivered: [String] = []
        var pending: [String] = []
        var categories: Set<UNNotificationCategory> = []
        var delegate: (any UNUserNotificationCenterDelegate)?

        func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
            authorizationRequests.append(options)
            return try authorizationResult.get()
        }

        func add(_ request: UNNotificationRequest) async throws {
            added.append(request)
        }

        func removePendingNotificationRequests(withIdentifiers identifiers: [String]) {
            removedPending.append(identifiers)
        }

        func removeDeliveredNotifications(withIdentifiers identifiers: [String]) {
            removedDelivered.append(identifiers)
        }

        func deliveredIdentifiers() async -> [String] { delivered }

        func pendingIdentifiers() async -> [String] { pending }

        func setNotificationCategories(_ categories: Set<UNNotificationCategory>) {
            self.categories = categories
        }
    }

    @MainActor
    final class RecordingReporter: RunActivityReporter, Sendable {
        struct Began: Equatable { var id: UUID; var title: String; var model: String }
        struct Update: Equatable {
            var id: UUID; var phase: RunPhase; var steps: Int; var line: String; var tool: String?
        }
        struct Ended: Equatable { var id: UUID; var phase: RunPhase; var line: String }
        var begans: [Began] = []
        var updates: [Update] = []
        var endeds: [Ended] = []
        var reconciles: [Set<UUID>] = []

        func began(conversationID: UUID, title: String, modelName: String) async {
            begans.append(Began(id: conversationID, title: title, model: modelName))
        }

        func update(conversationID: UUID, phase: RunPhase, stepCount: Int, startedAt _: Date, lastLine: String,
                    toolName: String?) async {
            updates.append(Update(id: conversationID, phase: phase, steps: stepCount, line: lastLine, tool: toolName))
        }

        func ended(conversationID: UUID, phase: RunPhase, lastLine: String) async {
            endeds.append(Ended(id: conversationID, phase: phase, line: lastLine))
        }

        func reconcile(activeConversationIDs: Set<UUID>) async {
            reconciles.append(activeConversationIDs)
        }
    }

    @MainActor
    struct Rig {
        let store: ChatStore
        let runtime: BackgroundRuntime
        let reporter: RecordingReporter
        let center: FakeCenter
        var conv: Conversation { store.conversations[0] }
    }

    private func rig(_ engine: any ChatEngine) -> Rig {
        let suite = "bgtest-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        addTeardownBlock { defaults.removePersistentDomain(forName: suite) }
        let center = FakeCenter()
        let reporter = RecordingReporter()
        let runtime = BackgroundRuntime(reporter: reporter,
                                        notifications: BackgroundNotifications(center: center, defaults: defaults))
        let store = ChatStore(engine: engine, conversations: [Conversation(title: "Chat")], background: runtime)
        store.coalesceInterval = .milliseconds(5)
        return Rig(store: store, runtime: runtime, reporter: reporter, center: center)
    }

    /// Tool step opens, a result commits, partial text streams, then the
    /// run holds until stopped: pause lands on mixed partial state.
    private func pausingEngine() -> ScriptedChatEngine {
        ScriptedChatEngine { _ in
            let call = tool("bg-partial", .readFile)
            return [
                .event(.iterationStarted(1)),
                .event(.toolCallStarted(call)),
                .event(.toolRunning(id: call.id)),
                .event(.committed([
                    Message(role: .assistant, parts: [.toolCall(ToolCall(id: call.id, name: call.name, arguments: "{}"))]),
                    Message(role: .user, parts: [.toolResult(ToolResult(callID: call.id, toolName: call.name,
                                                                       content: [.text("partial-result")]))]),
                ])),
                .event(.textDelta(blockID: "p.0", text: "Partial answer so far")),
                .hold,
            ]
        }
    }

    // MARK: Progress

    func testProgressDriverIsMonotonic() {
        var driver = BackgroundProgressDriver()
        XCTAssertEqual(driver.completed, 0)
        var seen: [Int64] = [driver.completed]
        driver.stepCompleted()
        seen.append(driver.completed)
        XCTAssertEqual(driver.completed, 40)
        driver.textBatch()
        seen.append(driver.completed)
        XCTAssertEqual(driver.completed, 41)
        // A text-only stream keeps nudging without ever jumping.
        for _ in 0..<30 { driver.textBatch(); seen.append(driver.completed) }
        XCTAssertEqual(driver.completed, 71)
        // Steps cap at 950, never at full while running.
        for _ in 0..<100 { driver.stepCompleted(); seen.append(driver.completed) }
        XCTAssertEqual(driver.completed, 950)
        driver.textBatch()
        XCTAssertEqual(driver.completed, 950)
        XCTAssertTrue(zip(seen, seen.dropFirst()).allSatisfy { $0 <= $1 }, "\(seen)")
        driver.finish()
        XCTAssertEqual(driver.completed, 1000)
    }

    // MARK: Simulator fallback

    func testSubmitFailsUnavailableInSimulator() throws {
        // The simulator cannot run background processing (BGTaskScheduler.h):
        // submission must fail, and the failure is what selects the
        // beginBackgroundTask fallback — asserted, not worked around.
        let id = BackgroundRuntime.taskIDPrefix + String(UUID().uuidString.prefix(8)).lowercased()
        XCTAssertTrue(BGTaskScheduler.shared.register(forTaskWithIdentifier: id, using: .main, launchHandler: { _ in }),
                      "wildcard id must register against the pre-seeded Info.plist")
        let request = BGContinuedProcessingTaskRequest(identifier: id, title: "t", subtitle: "s")
        request.strategy = .queue
        do {
            try BGTaskScheduler.shared.submit(request)
            XCTFail("submit must fail in the simulator")
        } catch {
            let ns = error as NSError
            XCTAssertEqual(ns.domain, BGTaskScheduler.errorDomain as String)
            XCTAssertEqual(ns.code, BGTaskScheduler.Error.Code.unavailable.rawValue, "\(error)")
        }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: id)
    }

    func testFallbackPathTakenWhenSubmitFails() async {
        let rig = rig(pausingEngine())
        let unavailable = NSError(domain: BGTaskScheduler.errorDomain as String,
                                  code: BGTaskScheduler.Error.Code.unavailable.rawValue)
        rig.runtime.submitRequest = { _ in throw unavailable }
        var begun: [(String, () -> Void)] = []
        var ended: [UIBackgroundTaskIdentifier] = []
        let fakeTask = UIBackgroundTaskIdentifier(rawValue: 42)
        rig.runtime.beginFallbackTask = { name, expiration in begun.append((name, expiration)); return fakeTask }
        rig.runtime.endFallbackTask = { ended.append($0) }

        rig.store.send(text: "go")
        let conv = rig.conv
        await waitUntil { rig.store.isRunning(conv.id) }
        XCTAssertNil(rig.runtime.states[conv.id]?.continuedTask)
        rig.store.appDidEnterBackground()
        XCTAssertEqual(begun.map(\.0), [BackgroundRuntime.fallbackTaskName])
        XCTAssertEqual(rig.runtime.states[conv.id]?.fallbackTask, fakeTask)
        // First backgrounded run asks for notification permission.
        await waitUntil { rig.center.authorizationRequests.count == 1 }
        XCTAssertEqual(rig.center.authorizationRequests, [[.alert, .sound]])

        // The fallback expiring pauses the run exactly like stop().
        begun[0].1()
        await waitUntil { !rig.store.isRunning(conv.id) }
        XCTAssertEqual(conv.turns.last?.outcome, .pausedBackground)
        XCTAssertEqual(rig.runtime.states[conv.id]?.fallbackTask, nil)
        XCTAssertEqual(ended, [fakeTask])
        await rig.store.settle()
    }

    func testNothingHappensWithoutARunInFlight() async {
        let rig = rig(pausingEngine())
        rig.runtime.beginFallbackTask = { _, _ in XCTFail("no fallback without a run"); return .invalid }
        rig.store.appDidEnterBackground()
        XCTAssertTrue(rig.center.authorizationRequests.isEmpty)
        rig.store.appDidBecomeActive()
        await waitUntil { rig.reporter.reconciles == [[]] }
        await rig.store.settle()
    }

    // MARK: Pause / continue

    func testPauseKeepsPartialBlocksAndTranscript() async throws {
        let rig = rig(pausingEngine())
        rig.store.send(text: "go")
        let conv = rig.conv
        await waitUntil { conv.turns.first?.blocks.count == 2 }

        rig.store.pauseRunForBackground(conversationID: conv.id)
        await rig.store.settle()

        XCTAssertFalse(rig.store.isRunning(conv.id))
        let turn = try XCTUnwrap(conv.turns.first)
        XCTAssertTrue(turn.isFinished)
        XCTAssertFalse(turn.isRunning)
        XCTAssertEqual(turn.outcome, .pausedBackground)
        XCTAssertEqual(TurnOutcome.pausedBackground.note, "Paused in background")
        // The open tool step settled cancelled; the uncommitted stream
        // text was written into its block, not dropped.
        let steps = turn.activities.flatMap(\.steps)
        XCTAssertEqual(steps.count, 1)
        XCTAssertEqual(steps.first?.status, .cancelled)
        XCTAssertEqual(turn.markdownSources, ["Partial answer so far"])
        // User message plus the committed tool call/result survive.
        XCTAssertEqual(turn.transcript.first?.role, .user)
        XCTAssertTrue(turn.transcript.first?.parts.contains(.text("go")) ?? false)
        XCTAssertTrue(turn.transcript.contains { !$0.toolCalls.isEmpty })
        XCTAssertTrue(turn.transcript.contains { $0.parts.contains(where: {
            if case .toolResult(let r) = $0 { return r.callID == "bg-partial" }
            return false
        }) })
        await waitUntil { rig.reporter.endeds.count == 1 }
        XCTAssertEqual(rig.reporter.endeds.first?.phase, .paused)
        XCTAssertEqual(rig.reporter.endeds.first?.line, "Paused in background")
        XCTAssertTrue(rig.runtime.states.isEmpty)
        // A pause posts no completion notification.
        XCTAssertTrue(rig.center.added.isEmpty)
    }

    func testPausePersistsTheOutcome() async throws {
        let directory = temporaryDirectory()
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let engine = pausingEngine()
        let store = ChatStore(engine: engine, conversations: [Conversation(title: "Chat")],
                              persistence: ConversationStore(directory: directory))
        store.coalesceInterval = .milliseconds(5)
        let conv = store.conversations[0]
        store.send(text: "go")
        await waitUntil { conv.turns.first?.blocks.count == 2 }
        store.pauseRunForBackground(conversationID: conv.id)
        await store.settle()

        let snapshot = try XCTUnwrap(ConversationStore(directory: directory).load())
        let record = try XCTUnwrap(snapshot.conversations.first)
        XCTAssertEqual(record.turns.last?.outcome, .pausedBackground)
    }

    func testContinueReplaysHistoryIncludingThePausedTranscript() async throws {
        let runs = Mutex(0)
        let seen = Mutex<[[Message]]>([])
        let engine = ScriptedChatEngine { request in
            seen.withLock { $0.append(request.transcript) }
            let n = runs.withLock { $0 += 1; return $0 }
            if n == 1 { return Self.pausingScript() }
            return [
                .event(.iterationStarted(1)),
                .event(.textDelta(blockID: "c.1", text: "Continued fine")),
                .event(.textFinished(blockID: "c.1")),
                .event(.committed([Message(role: .assistant, parts: [.text("Continued fine")])])),
                .event(.finished(.completed)),
            ]
        }
        let rig = rig(engine)
        rig.store.send(text: "one")
        let conv = rig.conv
        await waitUntil { conv.turns.first?.blocks.count == 2 }
        rig.store.pauseRunForBackground(conversationID: conv.id)
        await waitUntil { !rig.store.isRunning(conv.id) }

        rig.store.continueRun(conversationID: conv.id)
        await waitUntil { !rig.store.isRunning(conv.id) && conv.turns.count == 2 }

        // The old turn keeps its outcome and its partial answer.
        XCTAssertEqual(conv.turns[0].outcome, .pausedBackground)
        XCTAssertEqual(conv.turns[0].markdownSources, ["Partial answer so far"])
        XCTAssertEqual(conv.turns[1].userText, "Continue")
        XCTAssertEqual(conv.turns[1].outcome, .completed)
        // The new run replayed the paused turn's committed transcript —
        // user message plus finished tool call — then continued.
        let transcripts = seen.withLock { $0 }
        XCTAssertEqual(transcripts.count, 2)
        let replayed = transcripts[1]
        XCTAssertEqual(replayed.last?.text, "Continue")
        XCTAssertTrue(replayed.dropLast().first?.parts.contains(.text("one")) ?? false)
        XCTAssertTrue(replayed.dropLast().contains { $0.toolCalls.contains(where: { $0.id == "bg-partial" }) })
        XCTAssertEqual(rig.reporter.begans.count, 2)
        await rig.store.settle()
    }

    private nonisolated static func pausingScript() -> [ScriptedChatEngine.Step] {
        let call = tool("bg-partial", .readFile)
        return [
            .event(.iterationStarted(1)),
            .event(.toolCallStarted(call)),
            .event(.toolRunning(id: call.id)),
            .event(.committed([
                Message(role: .assistant, parts: [.toolCall(ToolCall(id: call.id, name: call.name, arguments: "{}"))]),
                Message(role: .user, parts: [.toolResult(ToolResult(callID: call.id, toolName: call.name,
                                                                   content: [.text("partial-result")]))]),
            ])),
            .event(.textDelta(blockID: "p.0", text: "Partial answer so far")),
            .hold,
        ]
    }

    func testContinueGuards() async {
        // Nothing to continue: no turns, a finished run, a run in flight.
        let first = rig(ScriptedChatEngine.echo(pause: .milliseconds(1)))
        first.store.continueRun(conversationID: first.conv.id)
        XCTAssertTrue(first.conv.turns.isEmpty)
        first.store.send(text: "one")
        await waitUntil { !first.store.isRunning }
        first.store.continueRun(conversationID: first.conv.id)
        XCTAssertEqual(first.conv.turns.count, 1)

        let holding = rig(pausingEngine())
        holding.store.send(text: "one")
        await waitUntil { holding.store.isRunning }
        holding.store.continueRun(conversationID: holding.conv.id)
        XCTAssertEqual(holding.conv.turns.count, 1, "no Continue while a run is in flight")
        holding.store.stop()
        await holding.store.settle()
        await first.store.settle()
    }

    func testStopEndsBackgroundState() async {
        let rig = rig(pausingEngine())
        var cancelled: [String] = []
        rig.runtime.cancelRequest = { cancelled.append($0) }
        rig.store.send(text: "go")
        let conv = rig.conv
        await waitUntil { rig.runtime.states[conv.id] != nil }
        rig.store.stop()
        XCTAssertTrue(rig.runtime.states.isEmpty)
        XCTAssertEqual(cancelled.count, 1)
        XCTAssertTrue(cancelled.first?.hasPrefix(BackgroundRuntime.taskIDPrefix) ?? false)
        await waitUntil { rig.reporter.endeds.count == 1 }
        XCTAssertEqual(rig.reporter.endeds.first?.line, "Stopped")
        XCTAssertTrue(rig.center.added.isEmpty, "a user stop posts nothing")
        await rig.store.settle()
    }

    // MARK: Reporter phases

    func testReporterSeesBeganUpdateAndDone() async throws {
        let rig = rig(ScriptedChatEngine.echo(pause: .milliseconds(1)))
        rig.store.send(text: "go")
        let conv = rig.conv
        await waitUntil { !rig.store.isRunning(conv.id) }
        await waitUntil { rig.reporter.endeds.count == 1 }

        let began = try XCTUnwrap(rig.reporter.begans.first)
        XCTAssertEqual(began.id, conv.id)
        XCTAssertEqual(began.title, conv.displayTitle)
        XCTAssertEqual(began.model, rig.store.model.name)
        XCTAssertTrue(rig.reporter.updates.contains { $0.phase == .runningTool },
                      "\(rig.reporter.updates.map(\.phase))")
        let ended = try XCTUnwrap(rig.reporter.endeds.first)
        XCTAssertEqual(ended.phase, .done)
        XCTAssertTrue(ended.line.hasPrefix("Done · "), ended.line)
        await rig.store.settle()
    }

    // MARK: Notifications

    func testApprovalNotificationPostedAndWithdrawn() async throws {
        let request = ApprovalRequest(id: "bg-appr-1", toolName: "run_command", source: .builtin,
                                      arguments: ["command": "make ship"], reason: "test",
                                      title: "Running make ship…")
        let engine = ScriptedChatEngine([
            .event(.iterationStarted(1)),
            .approval(request,
                      onAllow: [
                          .event(.textDelta(blockID: "a", text: "allowed-path")),
                          .event(.textFinished(blockID: "a")),
                          .event(.finished(.completed)),
                      ],
                      onDeny: [
                          .event(.textDelta(blockID: "a", text: "denied-path")),
                          .event(.textFinished(blockID: "a")),
                          .event(.finished(.completed)),
                      ]),
        ])
        let rig = rig(engine)
        rig.store.send(text: "go")
        let conv = rig.conv
        rig.store.appDidEnterBackground()
        await waitUntil { rig.center.added.count == 1 }

        let posted = try XCTUnwrap(rig.center.added.first)
        XCTAssertEqual(posted.identifier, "praxis.approval.bg-appr-1")
        XCTAssertEqual(posted.content.categoryIdentifier, "praxis.approval")
        XCTAssertEqual(posted.content.title, "Praxis needs your approval")
        XCTAssertEqual(posted.content.body, "Run command in \(conv.displayTitle)")
        XCTAssertEqual(posted.content.userInfo["conversationID"] as? String, conv.id.uuidString)
        XCTAssertEqual(posted.content.userInfo["requestID"] as? String, "bg-appr-1")
        let category = try XCTUnwrap(rig.center.categories.first)
        XCTAssertEqual(category.identifier, "praxis.approval")
        let actions = Dictionary(uniqueKeysWithValues: category.actions.map { ($0.identifier, $0) })
        XCTAssertEqual(actions["praxis.approve"]?.options, [.foreground])
        XCTAssertEqual(actions["praxis.deny"]?.options, [.foreground])
        // The lock-screen line matches too.
        await waitUntil { rig.reporter.updates.contains { $0.phase == .needsApproval } }

        rig.store.resolveApproval("bg-appr-1", decision: .allowOnce)
        await waitUntil { !rig.store.isRunning(conv.id) }
        XCTAssertTrue(rig.center.removedPending.flatMap { $0 }.contains("praxis.approval.bg-appr-1"))
        XCTAssertTrue(rig.center.removedDelivered.flatMap { $0 }.contains("praxis.approval.bg-appr-1"))
        XCTAssertEqual(conv.turns.first?.markdownSources, ["allowed-path"])
        await rig.store.settle()
    }

    func testApprovalActionRouting() async {
        let bodies = ["allowed-path", "denied-path"]
        for (index, body) in bodies.enumerated() {
            let request = ApprovalRequest(id: "bg-route-\(index)", toolName: "run_command", source: .builtin,
                                          arguments: ["command": "make"], reason: "test", title: "Running…")
            let engine = ScriptedChatEngine([
                .event(.iterationStarted(1)),
                .approval(request,
                          onAllow: [
                              .event(.textDelta(blockID: "a", text: "allowed-path")),
                              .event(.textFinished(blockID: "a")),
                              .event(.finished(.completed)),
                          ],
                          onDeny: [
                              .event(.textDelta(blockID: "a", text: "denied-path")),
                              .event(.textFinished(blockID: "a")),
                              .event(.finished(.completed)),
                          ]),
            ])
            let rig = rig(engine)
            rig.store.send(text: "go")
            let conv = rig.conv
            await waitUntil { rig.store.approvals.pendingIDs.contains(request.id) }
            let delegate = BackgroundNotificationDelegate()
            delegate.store = rig.store
            if index == 0 {
                delegate.handle(.approve(requestID: request.id, conversationID: conv.id))
            } else {
                delegate.handle(.deny(requestID: request.id, conversationID: conv.id))
            }
            await waitUntil { !rig.store.isRunning(conv.id) }
            XCTAssertEqual(conv.turns.first?.markdownSources, [body])
            XCTAssertTrue(rig.store.approvals.pendingIDs.isEmpty)
            await rig.store.settle()
        }
    }

    func testCompletionNotificationWhenBackgrounded() async throws {
        let answer = "First line wins.\nSecond line is never shown in the notification."
        let engine = ScriptedChatEngine([
            .event(.iterationStarted(1)),
            .event(.textDelta(blockID: "a", text: answer)),
            .event(.textFinished(blockID: "a")),
            .event(.committed([Message(role: .assistant, parts: [.text(answer)])])),
            .event(.finished(.completed)),
        ])
        let rig = rig(engine)
        rig.store.send(text: "go")
        rig.store.appDidEnterBackground()
        let conv = rig.conv
        await waitUntil { !rig.store.isRunning(conv.id) }
        await waitUntil { rig.center.added.count == 1 }

        let posted = try XCTUnwrap(rig.center.added.first)
        XCTAssertEqual(posted.identifier, "praxis.done.\(conv.id.uuidString)")
        XCTAssertEqual(posted.content.title, conv.displayTitle)
        XCTAssertEqual(posted.content.body, "First line wins.")
        XCTAssertEqual(posted.content.userInfo["conversationID"] as? String, conv.id.uuidString)
        await rig.store.settle()
    }

    func testCompletionBodyTruncatesAndReportsFailure() {
        var turn = Turn(userText: "go")
        turn.outcome = .completed
        turn.blocks = [.markdown(id: UUID(), source: "\n" + String(repeating: "w", count: 200) + "\n", isStreaming: false)]
        let body = BackgroundNotifications.completionBody(for: turn)
        XCTAssertEqual(body.count, BackgroundNotifications.completionBodyLimit)
        XCTAssertTrue(body.hasSuffix("…"))

        var failed = Turn(userText: "go")
        failed.outcome = .failed("boom")
        XCTAssertEqual(BackgroundNotifications.completionBody(for: failed), "Couldn't finish: boom")

        var empty = Turn(userText: "go")
        empty.outcome = .completed
        XCTAssertEqual(BackgroundNotifications.completionBody(for: empty), "Done")
    }

    func testForegroundRunPostsNothing() async {
        let request = ApprovalRequest(id: "bg-fg-1", toolName: "run_command", source: .builtin,
                                      arguments: ["command": "make"], reason: "test", title: "Running…")
        let engine = ScriptedChatEngine([
            .event(.iterationStarted(1)),
            .approval(request,
                      onAllow: [.event(.finished(.completed))],
                      onDeny: [.event(.finished(.completed))]),
        ])
        let rig = rig(engine)
        rig.store.send(text: "go")
        let conv = rig.conv
        await waitUntil { rig.store.approvals.pendingIDs.contains(request.id) }
        try? await Task.sleep(for: .milliseconds(100))
        rig.store.resolveApproval(request.id, decision: .deny)
        await waitUntil { !rig.store.isRunning(conv.id) }
        await rig.store.settle()
        XCTAssertTrue(rig.center.added.isEmpty, "foreground runs never notify")
        XCTAssertTrue(rig.center.authorizationRequests.isEmpty)
    }

    func testPermissionRequestedOnceEver() async throws {
        let first = rig(pausingEngine())
        let notifications = first.runtime.notifications
        XCTAssertFalse(notifications.hasPrompted)
        await notifications.ensureFirstRunPermission()
        XCTAssertEqual(first.center.authorizationRequests, [[.alert, .sound]])
        XCTAssertTrue(notifications.hasPrompted)
        await notifications.ensureFirstRunPermission()
        XCTAssertEqual(first.center.authorizationRequests.count, 1)

        // Denied counts as asked.
        let denied = rig(pausingEngine())
        denied.center.authorizationResult = .success(false)
        await denied.runtime.notifications.ensureFirstRunPermission()
        XCTAssertTrue(denied.runtime.notifications.hasPrompted)
        XCTAssertEqual(denied.center.authorizationRequests.count, 1)

        // A thrown error doesn't: the next backgrounding retries.
        struct Boom: Error {}
        let flaky = rig(pausingEngine())
        flaky.center.authorizationResult = .failure(Boom())
        await flaky.runtime.notifications.ensureFirstRunPermission()
        XCTAssertFalse(flaky.runtime.notifications.hasPrompted)
        flaky.center.authorizationResult = .success(true)
        await flaky.runtime.notifications.ensureFirstRunPermission()
        XCTAssertTrue(flaky.runtime.notifications.hasPrompted)
        XCTAssertEqual(flaky.center.authorizationRequests.count, 2)
        await first.store.settle()
    }

    func testNotificationRouteMapping() throws {
        let conv = UUID()
        let userInfo: [AnyHashable: Any] = ["conversationID": conv.uuidString, "requestID": "r1"]
        XCTAssertEqual(NotificationRoute.resolve(actionID: BackgroundNotifications.approveActionID, userInfo: userInfo),
                       .approve(requestID: "r1", conversationID: conv))
        XCTAssertEqual(NotificationRoute.resolve(actionID: BackgroundNotifications.denyActionID, userInfo: userInfo),
                       .deny(requestID: "r1", conversationID: conv))
        // Tapping the notification itself (even an approval's) opens the chat.
        XCTAssertEqual(NotificationRoute.resolve(actionID: UNNotificationDefaultActionIdentifier, userInfo: userInfo),
                       .openChat(conversationID: conv))
        XCTAssertNil(NotificationRoute.resolve(actionID: UNNotificationDismissActionIdentifier, userInfo: userInfo))
        XCTAssertNil(NotificationRoute.resolve(actionID: "nope", userInfo: userInfo))
        XCTAssertNil(NotificationRoute.resolve(actionID: BackgroundNotifications.approveActionID, userInfo: [:]))
        XCTAssertNil(NotificationRoute.resolve(actionID: BackgroundNotifications.approveActionID,
                                               userInfo: ["conversationID": conv.uuidString]))
        XCTAssertNil(NotificationRoute.resolve(actionID: UNNotificationDefaultActionIdentifier,
                                               userInfo: ["conversationID": "garbage"]))
    }

    func testOpenChatRouting() {
        let rig = rig(pausingEngine())
        rig.runtime.notifications.installDelegate(store: rig.store)
        XCTAssertTrue((rig.center.delegate as? BackgroundNotificationDelegate) === rig.runtime.notifications.delegate)
        var opened: [URL] = []
        rig.runtime.notifications.delegate.openURL = { opened.append($0) }
        rig.runtime.notifications.delegate.handle(.openChat(conversationID: rig.conv.id))
        XCTAssertEqual(opened, [URL(string: "praxis-app://chat/\(rig.conv.id.uuidString)")])
    }

    func testUntitledFinishNeverLeaksModelTextToTheLockScreen() async {
        // The loop reports some failures (unknown tool, invalid JSON)
        // with no start event; their summaries echo model-written
        // arguments and must never become the lock-screen line.
        let rig = rig(pausingEngine())
        let conv = rig.conv
        rig.store.send(text: "go")
        await waitUntil { conv.turns.first?.blocks.count == 2 }
        rig.runtime.reportBatch(
            conversationID: conv.id, title: conv.displayTitle,
            events: [.toolFinished(id: "no-such-call", ToolCompletion(
                status: .failed, summary: "Invalid JSON arguments: {\"evil\": \"model text\"}"))])
        await waitUntil { rig.reporter.updates.contains { $0.line == "Step failed" } }
        XCTAssertFalse(rig.reporter.updates.contains { $0.line.contains("evil") })
        let before = rig.reporter.updates.count
        rig.runtime.reportBatch(
            conversationID: conv.id, title: conv.displayTitle,
            events: [.toolFinished(id: "no-such-call-either", ToolCompletion(status: .succeeded, summary: "ok"))])
        await waitUntil { rig.reporter.updates.count > before }
        XCTAssertEqual(rig.reporter.updates.last?.line, "Thinking…")
        rig.store.stop()
        await rig.store.settle()
    }

    func testLaunchClearsOrphanedRunNotifications() async {
        let rig = rig(pausingEngine())
        let conv = rig.conv
        // A card posted pre-kill plus cards the dead process left in the
        // center; an unrelated notification must survive.
        await rig.runtime.notifications.postApproval(requestID: "r1", tool: "Run command",
                                                     chatTitle: conv.displayTitle, conversationID: conv.id)
        rig.center.delivered = ["praxis.approval.r1", "praxis.done.\(conv.id.uuidString)", "other.keep"]
        rig.center.pending = ["praxis.approval.r2"]
        rig.center.removedDelivered = []
        rig.center.removedPending = []
        rig.runtime.appDidLaunch()
        await waitUntil { !rig.center.removedDelivered.isEmpty }
        await waitUntil { !rig.center.removedPending.isEmpty }
        XCTAssertEqual(rig.center.removedDelivered.flatMap { $0 }.sorted(),
                       ["praxis.approval.r1", "praxis.done.\(conv.id.uuidString)"].sorted())
        XCTAssertEqual(rig.center.removedPending.flatMap { $0 }, ["praxis.approval.r2"])
        // ...and the posting record is forgotten with them.
        await rig.runtime.notifications.withdrawApprovals(for: conv.id)
        XCTAssertEqual(rig.center.removedDelivered.count, 1, "nothing left to withdraw")
        await rig.store.settle()
    }

    func testOutcomeNoteAndCodable() throws {
        XCTAssertEqual(TurnOutcome.pausedBackground.note, "Paused in background")
        let data = try JSONEncoder().encode(TurnOutcome.pausedBackground)
        XCTAssertEqual(try JSONDecoder().decode(TurnOutcome.self, from: data), .pausedBackground)
    }
}
