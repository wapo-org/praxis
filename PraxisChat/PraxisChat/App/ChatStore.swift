import Foundation
import SwiftUI

/// Single source of truth (spec §2): `@Observable @MainActor`.
@MainActor
@Observable
final class ChatStore {
    var conversations: [Conversation] = Scenarios.seededConversations()
    var selectedID: UUID?
    var mode: ChatMode = .auto
    var effort: Effort = .high
    var model: AIModel = MockData.models[1]
    var webSearch = true
    var codeExecution = true
    var memory = true
    var connectors: [Connector] = MockData.connectors
    var connectorDiscovery = true
    var attachments: [Attachment] = []
    var draft: String = ""
    var isRunning: Bool { runningTurnID != nil }

    private var runningTurnID: UUID?
    private var runStartedAt: Date?
    private var runTask: Task<Void, Never>?
    private let engine = DemoAgentEngine()
    let haptics = HapticCenter()

    init() { selectedID = conversations.first?.id }

    var selected: Conversation? {
        get { conversations.first { $0.id == selectedID } }
        set { if let v = newValue, let i = conversations.firstIndex(where: { $0.id == v.id }) { conversations[i] = v } }
    }

    // MARK: Conversation management

    func newChat() {
        let c = Conversation(title: "New chat")
        conversations.insert(c, at: 0)
        selectedID = c.id
    }

    func select(_ id: UUID) { selectedID = id }

    // MARK: Sending / running

    func send(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        guard var conv = selected else { return }
        let turn = Turn(userText: trimmed, attachments: attachments)
        conv.turns.append(turn)
        if conv.title == "New chat" { conv.title = String(trimmed.prefix(42)) }
        conv.updatedAt = Date()
        selected = conv
        let sentAttachments = attachments
        attachments = []
        draft = ""
        haptics.fire(.light)
        startRun(turnID: turn.id, prompt: trimmed, attachments: sentAttachments)
    }

    func retry(turnID: UUID) {
        guard let conv = selected, let turn = conv.turns.first(where: { $0.id == turnID }) else { return }
        var c = conv
        if let i = c.turns.firstIndex(where: { $0.id == turnID }) {
            // Retrying rewinds the thread: everything below goes away,
            // the retried turn itself re-runs from scratch.
            c.turns.removeSubrange((i + 1)..<c.turns.count)
            c.turns[i].blocks = []
            c.turns[i].isFinished = false
            c.turns[i].feedback = .none
        }
        selected = c
        startRun(turnID: turnID, prompt: turn.userText, attachments: turn.attachments)
    }

    func togglePinned(_ id: UUID) {
        guard let i = conversations.firstIndex(where: { $0.id == id }) else { return }
        conversations[i].isPinned.toggle()
    }

    /// Edit puts the text back in the composer and re-runs from that point (§8).
    func edit(turnID: UUID) {
        guard var conv = selected, let idx = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        draft = conv.turns[idx].userText
        conv.turns.removeSubrange(idx..<conv.turns.count)
        selected = conv
    }

    func resend(turnID: UUID) {
        guard let conv = selected, let turn = conv.turns.first(where: { $0.id == turnID }) else { return }
        send(text: turn.userText)
    }

    func stop() {
        runTask?.cancel()
        runTask = nil
        guard let turnID = runningTurnID else { return }
        runningTurnID = nil
        let realElapsed = runStartedAt.map { Date().timeIntervalSince($0) } ?? 0
        runStartedAt = nil
        updateTurn(turnID) { turn in
            turn.isRunning = false
            turn.isFinished = true
            for i in turn.blocks.indices {
                if case .activity(var a) = turn.blocks[i], a.isRunning {
                    a.isRunning = false
                    a.isStopped = true
                    a.elapsed = realElapsed > 0 ? realElapsed : a.elapsed
                    turn.blocks[i] = .activity(a)
                }
                if case .markdown(let id, let src, _) = turn.blocks[i] {
                    turn.blocks[i] = .markdown(id: id, source: src, isStreaming: false)
                }
            }
        }
    }

    private func startRun(turnID: UUID, prompt: String, attachments: [Attachment]) {
        stop()
        runningTurnID = turnID
        runStartedAt = Date()
        updateTurn(turnID) { $0.isRunning = true }
        let effort = effort, model = model, web = webSearch
        let stream = engine.run(prompt: prompt, effort: effort, model: model, webSearch: web, hasAttachments: !attachments.isEmpty)
        runTask = Task { [weak self] in
            for await event in stream {
                guard let self, !Task.isCancelled else { break }
                self.apply(event, turnID: turnID, attachments: attachments)
            }
            guard let self, !Task.isCancelled else { return }
            self.runningTurnID = nil
            self.updateTurn(turnID) { $0.isRunning = false; $0.isFinished = true }
            self.haptics.fire(.success)
        }
    }

    private func apply(_ event: AgentEvent, turnID: UUID, attachments: [Attachment]) {
        updateTurn(turnID) { turn in
            func stepLocation(_ stepID: UUID) -> (Int, Int)? {
                for (bi, block) in turn.blocks.enumerated() {
                    if case .activity(let a) = block, let si = a.steps.firstIndex(where: { $0.id == stepID }) {
                        return (bi, si)
                    }
                }
                return nil
            }
            switch event {
            case .activityStarted:
                turn.blocks.append(.activity(ActivityData(isRunning: true, isExpanded: true)))
            case .stepStarted(_, let step):
                guard let bi = turn.blocks.indices.last(where: {
                    if case .activity = turn.blocks[$0] { return true }; return false
                }), case .activity(var a) = turn.blocks[bi] else { return }
                var s = step
                if s.finalSummary.contains("Analyzed") || s.runningSummary.contains("Analyzing") {
                    s.traces = attachments.enumerated().map { i, att in
                        Trace(kind: .image, text: "screenshot \(i + 1): \(att.name)", thumbnailData: att.imageData)
                    }
                }
                a.steps.append(s)
                turn.blocks[bi] = .activity(a)
            case .traceAppended(let stepID, let trace):
                guard let (bi, si) = stepLocation(stepID), case .activity(var a) = turn.blocks[bi] else { return }
                a.steps[si].traces.append(trace)
                turn.blocks[bi] = .activity(a)
            case .commandStarted(let stepID, let command):
                guard let (bi, si) = stepLocation(stepID), case .activity(var a) = turn.blocks[bi] else { return }
                a.steps[si].command = command
                turn.blocks[bi] = .activity(a)
            case .commandOutput(let stepID, let line):
                guard let (bi, si) = stepLocation(stepID), case .activity(var a) = turn.blocks[bi] else { return }
                a.steps[si].command?.lines.append(line)
                turn.blocks[bi] = .activity(a)
            case .commandFinished(let stepID, let exitCode, let duration):
                guard let (bi, si) = stepLocation(stepID), case .activity(var a) = turn.blocks[bi] else { return }
                a.steps[si].command?.exitCode = exitCode
                a.steps[si].command?.duration = duration
                a.steps[si].command?.isRunning = false
                turn.blocks[bi] = .activity(a)
                if exitCode != 0 { Task { @MainActor in self.haptics.fire(.warning) } }
            case .stepFinished(let stepID, let final):
                guard let (bi, si) = stepLocation(stepID), case .activity(var a) = turn.blocks[bi] else { return }
                a.steps[si].isRunning = false
                a.steps[si].finalSummary = final
                turn.blocks[bi] = .activity(a)
            case .activityFinished(let id, let elapsed):
                _ = id
                guard let bi = turn.blocks.indices.last(where: {
                    if case .activity(let a) = turn.blocks[$0] { return a.isRunning }; return false
                }), case .activity(var a) = turn.blocks[bi] else { return }
                a.isRunning = false
                a.elapsed = elapsed
                turn.blocks[bi] = .activity(a)
                let blockID = a.id
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(700))
                    self.updateTurn(turnID) { t in
                        for i in t.blocks.indices {
                            if case .activity(var act) = t.blocks[i], act.id == blockID, act.userExpanded == nil {
                                act.isExpanded = false
                                t.blocks[i] = .activity(act)
                            }
                        }
                    }
                }
            case .textBlockStarted(let id):
                turn.blocks.append(.markdown(id: id, source: "", isStreaming: true))
            case .textDelta(let blockID, let chunk):
                if let bi = turn.blocks.firstIndex(where: {
                    if case .markdown(let id, _, _) = $0 { return id == blockID }; return false
                }), case .markdown(let id, let src, _) = turn.blocks[bi] {
                    turn.blocks[bi] = .markdown(id: id, source: src + chunk, isStreaming: true)
                }
            case .messageFinished:
                for i in turn.blocks.indices {
                    if case .markdown(let id, let src, _) = turn.blocks[i] {
                        turn.blocks[i] = .markdown(id: id, source: src.trimmingCharacters(in: .whitespaces), isStreaming: false)
                    }
                }
            }
        }
    }

    func setActivityExpanded(turnID: UUID, blockID: UUID, expanded: Bool) {
        updateTurn(turnID) { turn in
            for i in turn.blocks.indices {
                if case .activity(var a) = turn.blocks[i], a.id == blockID {
                    a.isExpanded = expanded
                    a.userExpanded = expanded
                    turn.blocks[i] = .activity(a)
                }
            }
        }
    }

    func setCommandExpanded(turnID: UUID, stepID: UUID, expanded: Bool) {
        updateTurn(turnID) { turn in
            for i in turn.blocks.indices {
                if case .activity(var a) = turn.blocks[i],
                   let si = a.steps.firstIndex(where: { $0.id == stepID }) {
                    a.steps[si].command?.isExpanded = expanded
                    turn.blocks[i] = .activity(a)
                }
            }
        }
    }

    func setFeedback(turnID: UUID, feedback: Turn.Feedback) {
        updateTurn(turnID) { $0.feedback = feedback }
    }

    private func updateTurn(_ turnID: UUID, _ mutate: (inout Turn) -> Void) {
        guard var conv = selected,
              let ti = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        mutate(&conv.turns[ti])
        selected = conv
    }
}
