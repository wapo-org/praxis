import Foundation
import AgentCore

extension ChatStore {
    func recordCloudRun(conversationID: UUID, turnID: UUID, runID: String) {
        guard let conv = conversations.first(where: { $0.id == conversationID }),
              let index = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        conv.turns[index].cloudRunID = runID
        persistence?.save(conv.record)
    }
    func clearCloudReplica() {
        // Detach presentation without setting cancellation flags: sign-out must
        // not cancel server runs belonging to the account being left.
        for handle in runs.values {
            handle.task?.cancel()
            approvals.denyAll(handle.approvalIDs)
            cloudElicitations.cancel(scope: handle.elicitationScope)
            background.runStopped(conversationID: handle.conversationID)
        }
        runs.removeAll(); conversations = []; selectedID = nil
        persistence = nil; policy = ToolPolicy()
        clearCloudDrafts()
    }
    func installCloudPersistence(_ persistence: ConversationStore, engine: CloudLifecycleEngine) {
        self.persistence = persistence
        use(engine)
        guard let snapshot = persistence.load() else { return }
        conversations = snapshot.conversations.map { Conversation(record: $0.settledAfterRelaunch()) }
        selectedID = conversations.first?.id
        policy = snapshot.policy
        for record in snapshot.conversations {
            guard let conv = conversations.first(where: { $0.id == record.id }) else { continue }
            for original in record.turns where original.engine == .cloud && (original.isRunning || !original.isFinished) {
                guard let index = conv.turns.firstIndex(where: { $0.id == original.id }) else { continue }
                conv.turns[index].blocks = []; conv.turns[index].transcript = []
                startRun(in: conv, turnID: original.id)
            }
        }
    }
    func applyCloudReplica(_ replica: CloudCursorReplica) throws {
        let remote: [CloudRemoteChat] = try replica.rows("chat", as: CloudRemoteChat.self)
        let messages: [CloudSyncedMessage] = try replica.rows("message", as: CloudSyncedMessage.self)
        let remoteIDs = Set(remote.map(\.id))
        // Only synced rows are deleted by tombstones; unsent local drafts stay.
        for conv in conversations where conv.cloudChatID.map({ !remoteIDs.contains($0) }) == true {
            if let handle = runs.removeValue(forKey: conv.id) { handle.task?.cancel() }
        }
        conversations.removeAll { $0.cloudChatID.map { !remoteIDs.contains($0) } == true }
        for chat in remote {
            let conv: Conversation
            if let cached = conversations.first(where: { $0.cloudChatID == chat.id || $0.id.uuidString == chat.id }) { conv = cached }
            else {
                conv = Conversation(id: CloudReplicaScope.localID(chat.id), title: chat.title, cloudChatID: chat.id)
                conversations.append(conv)
            }
            conv.cloudChatID = chat.id; conv.title = chat.title; conv.isPinned = chat.pinned ?? false
            conv.connectorIDs = chat.connectorIds; conv.disabledServerIDs = Set(chat.disabledConnectorIds ?? [])
            if let date = try? Date(chat.updatedAt, strategy: .iso8601) { conv.updatedAt = date }
            let rows = messages.filter { $0.chatId == chat.id }.sorted {
                $0.createdAt == $1.createdAt ? $0.id < $1.id : $0.createdAt < $1.createdAt
            }
            var turns: [Turn] = []
            for row in rows {
                let id = CloudReplicaScope.localID(row.clientTurnId ?? row.runId ?? row.id)
                var index = turns.firstIndex { $0.id == id }
                if index == nil {
                    turns.append(Turn(id: id, userText: "", isFinished: true, outcome: .completed, engine: .cloud))
                    index = turns.count - 1
                }
                let i = index!
                let native = row.native
                turns[i].transcript.append(native)
                if row.role == "user" { turns[i].userText = native.text }
                else if !native.text.isEmpty {
                    turns[i].blocks.append(.markdown(id: CloudReplicaScope.localID(row.id), source: native.text, isStreaming: false))
                }
            }
            // A locally rendered turn retains tool details and live block ids.
            // New/changed remote turns get an authoritative message projection.
            for turn in turns {
                if let index = conv.turns.firstIndex(where: { $0.id == turn.id }) {
                    if !isRunning(conv.id), conv.turns[index].transcript.count < turn.transcript.count { conv.turns[index] = turn }
                } else { conv.turns.append(turn) }
            }
            persistence?.save(conv.record)
        }
        conversations.sort { $0.updatedAt > $1.updatedAt }
        if !conversations.contains(where: { $0.id == selectedID }) { selectedID = conversations.first?.id }
        persistence?.saveIndex(.init(conversations: conversations.map {
            .init(id: $0.id, title: $0.title, updatedAt: $0.updatedAt, isPinned: $0.isPinned)
        }, policy: policy))
    }
    func resumeCloudRuns(_ replica: CloudCursorReplica, engine: CloudLifecycleEngine) async throws {
        let remoteRuns: [CloudRun] = try replica.rows("run", as: CloudRun.self)
        for run in remoteRuns where !["completed", "cancelled", "failed"].contains(run.status) {
            guard let conv = conversations.first(where: { $0.cloudChatID == run.chatId }), !isRunning(conv.id) else { continue }
            let turnID = CloudReplicaScope.localID(run.clientTurnId ?? run.id)
            guard let index = conv.turns.firstIndex(where: { $0.id == turnID }) else { continue }
            try await engine.registerRemoteRun(conversationID: conv.id, turnID: turnID, runID: run.id)
            conv.turns[index].blocks = []; conv.turns[index].transcript = []
            startRun(in: conv, turnID: turnID)
        }
    }

}
