import ActivityKit
import Synchronization
import XCTest
@testable import PraxisChat

@MainActor
final class FakeRunActivityStore: RunActivityStore {
    typealias Content = RunActivityAttributes.ContentState

    var activitiesEnabled = true
    var states: [UUID: Content] = [:]
    var requested: [(attributes: RunActivityAttributes, state: Content, staleDate: Date, relevance: Double)] = []
    var updated: [(id: UUID, state: Content, staleDate: Date, relevance: Double)] = []
    var ended: [(id: UUID, state: Content, policy: ActivityUIDismissalPolicy)] = []
    var requestError: Error?
    /// Vended from a nonisolated closure, so stored outside the actor; mutated only on @MainActor.
    nonisolated(unsafe) var enablementContinuations: [AsyncStream<Bool>.Continuation] = []

    func enablementUpdates() -> AsyncStream<Bool> {
        AsyncStream { [weak self] continuation in
            self?.enablementContinuations.append(continuation)
        }
    }

    func current() -> [UUID: Content] { states }

    func request(attributes: RunActivityAttributes, state: Content,
                 staleDate: Date, relevanceScore: Double) async throws {
        if let error = requestError {
            requestError = nil
            throw error
        }
        requested.append((attributes, state, staleDate, relevanceScore))
        states[attributes.conversationID] = state
    }

    func update(conversationID id: UUID, state: Content,
                staleDate: Date, relevanceScore: Double) async {
        updated.append((id, state, staleDate, relevanceScore))
        states[id] = state
    }

    func end(conversationID id: UUID, state: Content,
             dismissalPolicy: ActivityUIDismissalPolicy) async {
        ended.append((id, state, dismissalPolicy))
        states.removeValue(forKey: id)
    }

    func yieldEnablement(_ value: Bool) {
        for continuation in enablementContinuations { continuation.yield(value) }
    }
}

@MainActor
final class RunActivityReporterTests: XCTestCase {
    /// Boxed because Mutex is move-only, letting the @Sendable `now` closure share one instance.
    private final class ClockBox: Sendable {
        let mutex: Mutex<Date>
        init(_ date: Date) { mutex = Mutex(date) }
    }

    private let clockBox = ClockBox(Date(timeIntervalSinceReferenceDate: 10_000))

    private var testNow: Date {
        get { clockBox.mutex.withLock { $0 } }
        set { clockBox.mutex.withLock { $0 = newValue } }
    }

    /// Create fresh instances per test because init subscribes to enablement; sharing entangles.
    private func fixtures() -> (FakeRunActivityStore, LiveRunActivityReporter) {
        let fake = FakeRunActivityStore()
        let box = clockBox
        let reporter = LiveRunActivityReporter(store: fake, now: { box.mutex.withLock { $0 } })
        return (fake, reporter)
    }

    private var id: UUID { UUID(uuidString: "11111111-2222-3333-4444-555555555555")! }

    private func began(_ reporter: LiveRunActivityReporter, _ id: UUID? = nil) async {
        await reporter.began(conversationID: id ?? self.id, title: "Chat", modelName: "Model")
    }

    // MARK: began

    func testBeganRequestsThinkingActivity() async {
        let (fake, reporter) = fixtures()
        await began(reporter)
        XCTAssertEqual(fake.requested.count, 1)
        let call = fake.requested[0]
        XCTAssertEqual(call.attributes.conversationID, id)
        XCTAssertEqual(call.attributes.chatTitle, "Chat")
        XCTAssertEqual(call.attributes.modelName, "Model")
        XCTAssertEqual(call.state.phase, .thinking)
        XCTAssertEqual(call.state.stepCount, 0)
        XCTAssertEqual(call.state.lastLine, "Thinking…")
        XCTAssertNil(call.state.toolName)
        XCTAssertEqual(call.staleDate, testNow.addingTimeInterval(60))
        XCTAssertEqual(call.relevance, 100, "the just-sent run is the visible chat")
    }

    func testBeganNoOpsWhenDisabledButRemembersAttributes() async {
        let (fake, reporter) = fixtures()
        fake.activitiesEnabled = false
        await began(reporter)
        XCTAssertTrue(fake.requested.isEmpty)

        fake.activitiesEnabled = true
        await reporter.reconcile(activeConversationIDs: [id])
        XCTAssertEqual(fake.requested.count, 1)
        XCTAssertEqual(fake.requested[0].attributes.chatTitle, "Chat")
    }

    func testBeganNoOpsOnAuthorizationErrorAndRetriesOnUpdate() async {
        let (fake, reporter) = fixtures()
        fake.requestError = ActivityAuthorizationError.denied
        await began(reporter)
        XCTAssertTrue(fake.requested.isEmpty)

        await reporter.update(conversationID: id, phase: .runningTool, stepCount: 2,
                              startedAt: testNow, lastLine: "Reading a.txt…", toolName: "read")
        XCTAssertEqual(fake.requested.count, 1)
        XCTAssertEqual(fake.requested[0].state.phase, .runningTool)
        XCTAssertTrue(fake.updated.isEmpty, "the start carried the content; no separate update")
    }

    func testDoubleBeganStartsOneActivity() async {
        let (fake, reporter) = fixtures()
        await began(reporter)
        await began(reporter)
        XCTAssertEqual(fake.requested.count, 1)
    }

    // MARK: update throttle + coalescing

    func testPhaseChangeSendsImmediately() async {
        let (fake, reporter) = fixtures()
        await began(reporter)
        testNow.addTimeInterval(1)
        await reporter.update(conversationID: id, phase: .runningTool, stepCount: 1,
                              startedAt: testNow, lastLine: "Reading a.txt…", toolName: "read")
        XCTAssertEqual(fake.updated.count, 1)
        XCTAssertEqual(fake.updated[0].state.phase, .runningTool)
        XCTAssertEqual(fake.updated[0].staleDate, testNow.addingTimeInterval(60),
                       "staleDate advances on every update")
    }

    func testSamePhaseThrottlesToOnePerFiveSeconds() async {
        let (fake, reporter) = fixtures()
        await began(reporter)
        let start = testNow
        testNow = start.addingTimeInterval(6)
        await reporter.update(conversationID: id, phase: .thinking, stepCount: 1,
                              startedAt: start, lastLine: "line 1", toolName: nil)
        XCTAssertEqual(fake.updated.count, 1)
        for n in [7, 8] {
            testNow = start.addingTimeInterval(TimeInterval(n))
            await reporter.update(conversationID: id, phase: .thinking, stepCount: n,
                                  startedAt: start, lastLine: "line \(n)", toolName: nil)
        }
        XCTAssertEqual(fake.updated.count, 1, "two rapid sends coalesce away")

        testNow = start.addingTimeInterval(12)
        await reporter.update(conversationID: id, phase: .thinking, stepCount: 9,
                              startedAt: start, lastLine: "newest", toolName: nil)
        XCTAssertEqual(fake.updated.count, 2)
        XCTAssertEqual(fake.updated[0].state.lastLine, "line 1")
        XCTAssertEqual(fake.updated[1].state.lastLine, "newest", "coalesced text is newest-wins")
        XCTAssertEqual(fake.updated[1].state.stepCount, 9)
    }

    func testUpdateStartsWhenBeganNoOpd() async {
        let (fake, reporter) = fixtures()
        fake.activitiesEnabled = false
        await began(reporter)
        fake.activitiesEnabled = true
        await reporter.update(conversationID: id, phase: .thinking, stepCount: 1,
                              startedAt: testNow, lastLine: "Writing answer…", toolName: nil)
        XCTAssertEqual(fake.requested.count, 1, "self-heals without waiting for reconcile")
    }

    func testUpdateBeforeBeganCannotStart() async {
        let (fake, reporter) = fixtures()
        await reporter.update(conversationID: id, phase: .thinking, stepCount: 1,
                              startedAt: testNow, lastLine: "x", toolName: nil)
        XCTAssertTrue(fake.requested.isEmpty, "no title/model known, nothing to start")
    }

    // MARK: truncation

    func testLongLastLineTruncatesTo140Chars() async {
        let (fake, reporter) = fixtures()
        await began(reporter)
        let long = String(repeating: "x", count: 500)
        await reporter.update(conversationID: id, phase: .runningTool, stepCount: 1,
                              startedAt: testNow, lastLine: long, toolName: "t")
        XCTAssertEqual(fake.updated.count, 1)
        let line = fake.updated[0].state.lastLine
        XCTAssertEqual(line.count, 140)
        XCTAssertTrue(line.hasSuffix("…"))
    }

    func testShortLastLinePassesThrough() async {
        let (fake, reporter) = fixtures()
        await began(reporter)
        await reporter.update(conversationID: id, phase: .runningTool, stepCount: 1,
                              startedAt: testNow, lastLine: "Reading a.txt…", toolName: "read")
        XCTAssertEqual(fake.updated[0].state.lastLine, "Reading a.txt…")
    }

    // MARK: ended

    func testEndedDoneSendsFinalStateWithAfterDismissal() async {
        let (fake, reporter) = fixtures()
        await began(reporter)
        testNow.addTimeInterval(30)
        let started = testNow.addingTimeInterval(-30)
        await reporter.update(conversationID: id, phase: .runningTool, stepCount: 3,
                              startedAt: started, lastLine: "Reading a.txt…", toolName: "read")
        testNow.addTimeInterval(30)
        await reporter.ended(conversationID: id, phase: .done, lastLine: "Done · 3 steps · 1m")
        XCTAssertEqual(fake.ended.count, 1)
        let call = fake.ended[0]
        XCTAssertEqual(call.state.phase, .done)
        XCTAssertEqual(call.state.stepCount, 3, "final state keeps the last step count")
        XCTAssertEqual(call.state.startedAt, started, "and the run's start time")
        XCTAssertEqual(call.state.lastLine, "Done · 3 steps · 1m")
        XCTAssertNil(call.state.toolName)
        XCTAssertEqual(call.policy, .after(testNow.addingTimeInterval(300)))
    }

    func testEndedFailedDismissesAfterFiveMinutes() async {
        let (fake, reporter) = fixtures()
        await began(reporter)
        await reporter.ended(conversationID: id, phase: .failed, lastLine: "Couldn't finish")
        XCTAssertEqual(fake.ended[0].policy, .after(testNow.addingTimeInterval(300)))
    }

    func testEndedPausedUsesDefaultDismissal() async {
        let (fake, reporter) = fixtures()
        await began(reporter)
        await reporter.ended(conversationID: id, phase: .paused, lastLine: "Paused in background")
        XCTAssertEqual(fake.ended[0].policy, .default, "paused stays until the user returns")
    }

    func testEndedEndsUntrackedLiveActivity() async {
        let (fake, reporter) = fixtures()
        fake.states[id] = FakeRunActivityStore.Content(phase: .runningTool, stepCount: 2,
                                                        startedAt: testNow, lastLine: "x", toolName: "t")
        await reporter.ended(conversationID: id, phase: .paused, lastLine: "Paused in background")
        XCTAssertEqual(fake.ended.count, 1, "ended ALWAYS ends with a final state")
        XCTAssertEqual(fake.ended[0].state.phase, .paused)
    }

    func testEndedClearsSoReenablementDoesNotResurrect() async {
        let (fake, reporter) = fixtures()
        fake.activitiesEnabled = false
        await began(reporter)
        await reporter.ended(conversationID: id, phase: .done, lastLine: "Done")
        fake.activitiesEnabled = true
        await reporter.reconcile(activeConversationIDs: [id])
        XCTAssertTrue(fake.requested.isEmpty, "an ended run is forgotten, never restarted")
    }

    // MARK: reconcile

    func testReconcileEndsMidFlightOrphanAsPaused() async {
        let (fake, reporter) = fixtures()
        fake.states[id] = FakeRunActivityStore.Content(phase: .runningTool, stepCount: 2,
                                                        startedAt: testNow, lastLine: "Reading a.txt…",
                                                        toolName: "read")
        await reporter.reconcile(activeConversationIDs: [])
        XCTAssertEqual(fake.ended.count, 1)
        XCTAssertEqual(fake.ended[0].state.phase, .paused)
        XCTAssertEqual(fake.ended[0].state.lastLine, "Paused in background")
        XCTAssertEqual(fake.ended[0].state.stepCount, 2)
        XCTAssertEqual(fake.ended[0].policy, .default)
    }

    func testReconcileKeepsTerminalOrphanState() async {
        let (fake, reporter) = fixtures()
        fake.states[id] = FakeRunActivityStore.Content(phase: .done, stepCount: 4,
                                                        startedAt: testNow, lastLine: "Done · 4 steps",
                                                        toolName: nil)
        await reporter.reconcile(activeConversationIDs: [])
        XCTAssertEqual(fake.ended.count, 1)
        XCTAssertEqual(fake.ended[0].state.phase, .done)
        XCTAssertEqual(fake.ended[0].state.lastLine, "Done · 4 steps")
        XCTAssertEqual(fake.ended[0].policy, .after(testNow.addingTimeInterval(300)))
    }

    func testReconcileAdoptsLiveActivityForActiveRun() async {
        let (fake, reporter) = fixtures()
        fake.states[id] = FakeRunActivityStore.Content(phase: .thinking, stepCount: 1,
                                                        startedAt: testNow, lastLine: "Thinking…",
                                                        toolName: nil)
        await reporter.reconcile(activeConversationIDs: [id])
        XCTAssertTrue(fake.ended.isEmpty)
        XCTAssertTrue(fake.requested.isEmpty, "adopts instead of starting a second activity")
        await reporter.update(conversationID: id, phase: .thinking, stepCount: 2,
                              startedAt: testNow, lastLine: "more", toolName: nil)
        XCTAssertEqual(fake.updated.count, 1, "updates flow to the adopted activity")
    }

    func testReconcileForgetsRunsNeitherLiveNorReporting() async {
        let (fake, reporter) = fixtures()
        fake.activitiesEnabled = false
        await began(reporter)
        await reporter.reconcile(activeConversationIDs: [])
        fake.activitiesEnabled = true
        await reporter.reconcile(activeConversationIDs: [id])
        XCTAssertTrue(fake.requested.isEmpty, "stale begun state is dropped, not resurrected")
    }

    // MARK: relevance

    func testNewestRunScores100Others50() async {
        let (fake, reporter) = fixtures()
        let other = UUID()
        await began(reporter)
        await began(reporter, other)
        XCTAssertEqual(fake.requested[0].relevance, 100)
        XCTAssertEqual(fake.requested[1].relevance, 100, "each began is newest at its moment")
        await reporter.update(conversationID: id, phase: .runningTool, stepCount: 1,
                              startedAt: testNow, lastLine: "x", toolName: "t")
        XCTAssertEqual(fake.updated[0].relevance, 50, "the older run drops to 50")
    }

    // MARK: enablement observation

    func testEnablementFlipStartsRememberedRuns() async {
        let (fake, reporter) = fixtures()
        fake.activitiesEnabled = false
        await began(reporter)
        // Init subscribes in a detached task; wait for the subscription before yielding or flips drop.
        await waitUntil { !fake.enablementContinuations.isEmpty }
        fake.activitiesEnabled = true
        fake.yieldEnablement(true)
        await waitUntil { !fake.requested.isEmpty }
        XCTAssertEqual(fake.requested.count, 1)
    }
}

@MainActor
final class LiveActivityKitStoreTests: XCTestCase {
    func testRequestUpdateEndRoundTrip() async throws {
        let store = LiveActivityKitStore()
        try XCTSkipIf(!store.activitiesEnabled, "activities disabled in this host")
        let id = UUID()
        let attributes = RunActivityAttributes(conversationID: id, chatTitle: "Store test",
                                               modelName: "Model")
        let started = Date()
        do {
            try await store.request(attributes: attributes,
                                    state: RunActivityAttributes.ContentState(phase: .thinking, stepCount: 0,
                                                                              startedAt: started, lastLine: "Thinking…",
                                                                              toolName: nil),
                                    staleDate: Date().addingTimeInterval(60), relevanceScore: 100)
            try XCTUnwrap(store.current()[id], "requested activity is listed")
            await store.update(conversationID: id,
                               state: RunActivityAttributes.ContentState(phase: .runningTool, stepCount: 1,
                                                                         startedAt: started, lastLine: "Reading…",
                                                                         toolName: "read"),
                               staleDate: Date().addingTimeInterval(60), relevanceScore: 100)
            // The local proxy's content refreshes asynchronously after update() returns, so poll for it.
            await waitUntil(timeout: 10) { store.current()[id]?.phase == .runningTool }
            XCTAssertEqual(store.current()[id]?.phase, .runningTool)
        } catch {
            XCTFail("ActivityKit round trip threw: \(error)")
        }
        await store.end(conversationID: id,
                        state: RunActivityAttributes.ContentState(phase: .done, stepCount: 1,
                                                                  startedAt: started, lastLine: "Done",
                                                                  toolName: nil),
                        dismissalPolicy: .immediate)
        await waitUntil(timeout: 10) { store.current()[id] == nil }
        XCTAssertNil(store.current()[id], "ended activity is gone")
    }
}
