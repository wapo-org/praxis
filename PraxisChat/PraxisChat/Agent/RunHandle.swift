import Foundation
import Synchronization
import AgentCore

/// One run in flight. Conversations run independently: each has at most
/// one handle, and stopping or replacing it never touches another chat.
@MainActor
final class RunHandle {
    let conversationID: UUID
    let turnID: UUID
    var reducer = TurnReducer()
    /// Where the turn was last seen; revalidated before every batch.
    var turnIndex: Int
    let inbox = EventInbox()
    var task: Task<Void, Never>?
    /// Approval requests this run is waiting on (denied on stop).
    var approvalIDs: Set<String> = []
    /// Flipped by stop/cancel/replace/delete; the engine watches it
    /// through the request and ends its stream.
    let cancelled = RunCancelFlag()
    /// Fresh per run; the run's elicitations carry it, and stop cancels
    /// it — other chats' runs keep their own scopes.
    let elicitationScope = UUID()

    init(conversationID: UUID, turnID: UUID, turnIndex: Int) {
        self.conversationID = conversationID
        self.turnID = turnID
        self.turnIndex = turnIndex
    }
}

/// One run's cancel flag, shared with its engine.
final class RunCancelFlag: Sendable {
    private let box = Mutex(false)
    var isCancelled: Bool { box.withLock { $0 } }
    func cancel() { box.withLock { $0 = true } }
}

/// Hands events from the engine's (coalesced) stream to the main actor in
/// batches. The reader pushes off the main actor; the first push after a
/// drain schedules one main-actor drain, which takes everything that has
/// arrived by then — so a burst costs one hop and one transcript update,
/// however many events it holds.
final class EventInbox: Sendable {
    private struct State {
        var events: [AgentEvent] = []
        var scheduled = false
        var ended = false
    }

    private let state = Mutex(State())

    /// True when the caller should schedule a drain.
    func push(_ event: AgentEvent) -> Bool {
        state.withLock { s in
            s.events.append(event)
            defer { s.scheduled = true }
            return !s.scheduled
        }
    }

    /// The stream ended. True when the caller should schedule a drain.
    func end() -> Bool {
        state.withLock { s in
            s.ended = true
            defer { s.scheduled = true }
            return !s.scheduled
        }
    }

    func drain() -> (events: [AgentEvent], ended: Bool) {
        state.withLock { s in
            let events = s.events
            s.events.removeAll(keepingCapacity: true)
            s.scheduled = false
            return (events, s.ended)
        }
    }

    /// Reads `stream` to the end (or until the reading task is cancelled),
    /// waking the consumer whenever a drain is due.
    static func pump(_ stream: AsyncStream<AgentEvent>, into inbox: EventInbox,
                     wake: @escaping @Sendable () -> Void) async {
        for await event in stream {
            if inbox.push(event) { wake() }
        }
        if inbox.end() { wake() }
    }
}
