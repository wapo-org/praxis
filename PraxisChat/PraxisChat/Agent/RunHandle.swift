import Foundation
import Synchronization
import AgentCore

/// Per-conversation run handle so stopping or replacing never affects other chats.
@MainActor
final class RunHandle {
    let conversationID: UUID
    let turnID: UUID
    var reducer = TurnReducer()
    var turnIndex: Int
    let inbox = EventInbox()
    var task: Task<Void, Never>?
    var approvalIDs: Set<String> = []
    let cancelled = RunCancelFlag()
    let elicitationScope = UUID()

    init(conversationID: UUID, turnID: UUID, turnIndex: Int) {
        self.conversationID = conversationID
        self.turnID = turnID
        self.turnIndex = turnIndex
    }
}

final class RunCancelFlag: Sendable {
    private let box = Mutex(false)
    var isCancelled: Bool { box.withLock { $0 } }
    func cancel() { box.withLock { $0 = true } }
}

/// Coalesces off-main events so bursts pay one MainActor hop and transcript update.
final class EventInbox: Sendable {
    private struct State {
        var events: [AgentEvent] = []
        var scheduled = false
        var ended = false
    }

    private let state = Mutex(State())

    func push(_ event: AgentEvent) -> Bool {
        state.withLock { s in
            s.events.append(event)
            defer { s.scheduled = true }
            return !s.scheduled
        }
    }

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

    static func pump(_ stream: AsyncStream<AgentEvent>, into inbox: EventInbox,
                     wake: @escaping @Sendable () -> Void) async {
        for await event in stream {
            if inbox.push(event) { wake() }
        }
        if inbox.end() { wake() }
    }
}
