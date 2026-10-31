import Foundation
import AgentCore

extension ChatStore {
    func recordCloudRun(conversationID: UUID, turnID: UUID, runID: String) {
        guard let conv = conversations.first(where: { $0.id == conversationID }),
              let index = conv.turns.firstIndex(where: { $0.id == turnID }) else { return }
        conv.turns[index].cloudRunID = runID
        persistConversation(conv)
    }
    func clearCloudReplica() {
        // Detach presentation without setting cancellation flags: sign-out must
        // not cancel server runs belonging to the account being left.
        for id in Array(runs.keys) { detachCloudRun(id) }
        conversations = []; selectedID = nil
        resetCloudStorage()
        clearCloudDrafts()
    }
    func installCloudPersistence(_ persistence: ConversationStore, engine: CloudLifecycleEngine) {
        use(engine)
        let snapshot = persistence.load()
        installCloudStorage(persistence, policy: snapshot?.policy)
        guard let snapshot else { return }
        conversations = snapshot.conversations.map { Conversation(record: $0.settledAfterRelaunch()) }
        selectedID = conversations.first?.id
        for record in snapshot.conversations {
            guard let conv = conversations.first(where: { $0.id == record.id }) else { continue }
            for original in record.turns where original.engine == .cloud && (original.isRunning || !original.isFinished) {
                guard let index = conv.turns.firstIndex(where: { $0.id == original.id }) else { continue }
                restoreCloudTurn(original.id, in: conv)
            }
        }
    }
    func applyCloudReplica(_ replica: CloudCursorReplica) throws {
        applyCloudProjection(try CloudReplicaProjection(replica))
    }
    func applyCloudProjection(_ projection: CloudReplicaProjection) {
        let remote = projection.chats
        let activeTurns = Set(projection.runs.filter { !["completed", "cancelled", "failed"].contains($0.status) }.map { CloudReplicaScope.localID($0.clientTurnId ?? $0.id) })
        var changed: [Conversation] = []
        let oldIDs = conversations.map(\.id)
        let remoteIDs = Set(remote.map(\.id))
        // Only synced rows are deleted by tombstones; unsent local drafts stay.
        for conv in conversations where conv.cloudChatID.map({ !remoteIDs.contains($0) }) == true {
            detachCloudRun(conv.id)
        }
        conversations.removeAll { $0.cloudChatID.map { !remoteIDs.contains($0) } == true }
        for chat in remote {
            let existing = conversations.first { $0.cloudChatID == chat.id || $0.id.uuidString == chat.id }
            if let touched = projection.changedChatIDs, !touched.contains(chat.id), existing != nil { continue }
            let before = existing?.record
            let conv: Conversation
            if let cached = conversations.first(where: { $0.cloudChatID == chat.id || $0.id.uuidString == chat.id }) { conv = cached }
            else {
                conv = Conversation(id: CloudReplicaScope.localID(chat.id), title: chat.title, cloudChatID: chat.id)
                conversations.append(conv)
            }
            conv.cloudChatID = chat.id; conv.title = chat.title; conv.isPinned = chat.pinned ?? false
            conv.connectorIDs = chat.connectorIds; conv.disabledServerIDs = Set(chat.disabledConnectorIds ?? [])
            if let date = try? Date(chat.updatedAt, strategy: .iso8601) { conv.updatedAt = date }
            let rows = projection.messagesByChat[chat.id] ?? []
            var firstDates: [UUID: String] = [:]
            var turns: [Turn] = []
            for row in rows {
                let id = CloudReplicaScope.localID(row.clientTurnId ?? row.runId ?? row.id)
                if firstDates[id] == nil { firstDates[id] = row.createdAt }
                var index = turns.firstIndex { $0.id == id }
                if index == nil {
                    turns.append(Turn(id: id, userText: "", isFinished: !activeTurns.contains(id), outcome: activeTurns.contains(id) ? nil : .completed, engine: .cloud))
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
            let priorOrder = Dictionary(uniqueKeysWithValues: conv.turns.enumerated().map { ($0.element.id, $0.offset) })
            conv.turns.sort {
                if let left = firstDates[$0.id], let right = firstDates[$1.id], left != right { return left < right }
                if firstDates[$0.id] != nil && firstDates[$1.id] == nil { return true }
                if firstDates[$0.id] == nil && firstDates[$1.id] != nil { return false }
                return (priorOrder[$0.id] ?? 0) < (priorOrder[$1.id] ?? 0)
            }
            if before != conv.record { changed.append(conv) }
        }
        conversations.sort { $0.updatedAt > $1.updatedAt }
        if !conversations.contains(where: { $0.id == selectedID }) { selectedID = conversations.first?.id }
        persistCloudProjection(changed, indexChanged: oldIDs != conversations.map(\.id))
    }
    func resumeCloudRuns(_ replica: CloudCursorReplica, engine: CloudLifecycleEngine) async throws {
        try await resumeCloudRuns(replica.rows("run", as: CloudRun.self), engine: engine)
    }
    func resumeCloudRuns(_ remoteRuns: [CloudRun], engine: CloudLifecycleEngine, client: CloudAPIClient? = nil) async throws {
        for run in remoteRuns where !["completed", "cancelled", "failed"].contains(run.status) {
            guard let conv = conversations.first(where: { $0.cloudChatID == run.chatId }), !isRunning(conv.id) else { continue }
            let turnID = CloudReplicaScope.localID(run.clientTurnId ?? run.id)
            guard let index = conv.turns.firstIndex(where: { $0.id == turnID }), !conv.turns[index].isFinished else { continue }
            if let client {
                let authoritative: CloudRun = try await client.send("/v1/runs/" + CloudAPIClient.segment(run.id))
                guard !["completed", "cancelled", "failed"].contains(authoritative.status),
                      authoritative.id == run.id, authoritative.chatId == run.chatId else { continue }
            }
            guard conversations.contains(where: { $0 === conv }), !isRunning(conv.id),
                  conv.turns.contains(where: { $0.id == turnID && !$0.isFinished }) else { continue }
            try await engine.registerRemoteRun(conversationID: conv.id, turnID: turnID, runID: run.id)
            guard conversations.contains(where: { $0 === conv }), !isRunning(conv.id),
                  conv.turns.contains(where: { $0.id == turnID && !$0.isFinished }) else { continue }
            restoreCloudTurn(turnID, in: conv)
        }
    }
}
