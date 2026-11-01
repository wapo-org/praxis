import Foundation
import AgentCore
import AgentMCP
import AgentRuntime

extension ChatStore {
    // MARK: Requests

    func makeRequest(_ conv: Conversation, turnIndex: Int) -> ChatRunRequest {
        let turn = conv.turns[turnIndex]
        let earlier = conv.turns[..<turnIndex]
        // Live runs replay only live turns: demo answers are scripts.
        let replayed = engine.kind == .live ? earlier.filter { $0.engine == .live } : Array(earlier)
        let user = engine.buildsUserMessage ? nil
            : turn.transcript.first ?? userMessage(turn.userText, in: conv, before: turnIndex)
        let conversationID = conv.id
        let store = WeakStore(value: self)
        return ChatRunRequest(
            conversationID: conv.id, turnID: turn.id, history: replayed.flatMap(\.transcript), userMessage: user,
            userText: turn.userText, mode: mode, effort: effort,
            modelID: model.id, webSearch: webSearch, attachments: turn.attachments,
            conversationAttachments: conv.turns[...turnIndex].flatMap(\.attachments),
            hiddenFromCode: { await MainActor.run { store.value?.hiddenFromCode(in: conversationID) ?? [] } },
            policy: policy, approvals: approvals, setup: conv.setup,
            // The freeze always takes the full enabled set: per-chat "off"
            // is a refusal (`disabledServerIDs`), not an exclusion —
            // excluding it would drop the connector from the frozen setup
            // for good on every re-freeze (retry of the first turn).
            connectorIDs: enabledConnectorIDs(for: conv),
            // Unknown ids are ignored by the runtime, so the full set is
            // safe even when the setup is about to be (re-)frozen.
            disabledServerIDs: conv.disabledServerIDs,
            // Read live: toggling a tool applies to existing chats'
            // next run (their calls refuse) and to new chats' freeze.
            disabledTools: services?.connectors.disabledTools ?? [:],
            onSetup: { setup, failures in
                await MainActor.run { store.value?.adopt(setup, failures: failures, conversationID: conversationID) }
            },
            compaction: conv.compaction,
            onCompaction: { record in
                await MainActor.run { store.value?.adopt(record, conversationID: conversationID) }
            },
            contextMeasurement: conv.contextMeasurement,
            onContextMeasured: { measurement in
                await MainActor.run { store.value?.conversation(conversationID)?.contextMeasurement = measurement }
            })
    }

    // MARK: Code access

    /// "Hide from code" / "Available to code" on an attachment, in the
    /// composer or a sent turn. Sent turns are saved; a run in flight
    /// sees the change at its next `fs` call (`ChatRunRequest.hiddenFromCode`).
    func setHiddenFromCode(_ hidden: Bool, attachmentID: UUID) {
        if let i = attachments.firstIndex(where: { $0.id == attachmentID }) { attachments[i].isHiddenFromCode = hidden }
        for conv in conversations {
            var changed = false
            for t in conv.turns.indices {
                guard let a = conv.turns[t].attachments.firstIndex(where: { $0.id == attachmentID }),
                      conv.turns[t].attachments[a].isHiddenFromCode != hidden else { continue }
                conv.turns[t].attachments[a].isHiddenFromCode = hidden
                changed = true
            }
            if changed { persistConversation(conv) }
        }
    }

    /// Attachments of a conversation the user hid from code.
    func hiddenFromCode(in conversationID: UUID) -> Set<UUID> {
        guard let conv = conversation(conversationID) else { return [] }
        return Set(conv.turns.flatMap(\.attachments).filter(\.isHiddenFromCode).map(\.id))
    }

    /// Persists a context compaction; the turns keep the full transcript.
    private func adopt(_ compaction: ContextCompaction, conversationID: UUID) {
        guard let conv = conversation(conversationID) else { return }
        conv.compaction = compaction
        persistConversation(conv)
    }

    /// Persists a freshly frozen setup with its conversation, before the
    /// run sends anything.
    private func adopt(_ setup: ConversationSetup, failures: [MCPToolset.Failure], conversationID: UUID) {
        services?.connectors.record(failures)
        guard let conv = conversation(conversationID) else { return }
        conv.setup = setup
        // The freeze keeps the full enabled set, so per-chat toggles
        // survive a re-freeze; only ids that left the setup go.
        conv.disabledServerIDs = conv.disabledServerIDs.intersection(setup.mcpServers.map(\.id))
        persistConversation(conv)
    }

    /// The user message for a turn. Mode and effort changes ride along as
    /// a note — appended, never edited into earlier history.
    func userMessage(_ text: String, in conv: Conversation, before index: Int) -> Message {
        let note = SystemPrompt.modeNote(mode: mode.agentMode, effort: effort)
        var parts: [Part] = []
        if lastModeNote(in: conv, before: index) != note { parts.append(.note(note)) }
        if !text.isEmpty { parts.append(.text(text)) }
        return Message(role: .user, parts: parts)
    }

    private func lastModeNote(in conv: Conversation, before index: Int) -> String? {
        for turn in conv.turns[..<min(index, conv.turns.count)].reversed() {
            for message in turn.transcript.reversed() where message.role == .user {
                for part in message.parts.reversed() {
                    if case .note(let note) = part, note.hasPrefix("Current mode:") { return note }
                }
            }
        }
        return nil
    }
}
