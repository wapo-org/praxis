import Foundation
import AgentCore
import AgentMCP

struct CloudChatEngine: ChatEngine {
    let kind: EngineKind = .cloud
    let buildsUserMessage = true
    var onDetached: @Sendable () async -> Void = {}
    var priorEvents: [CloudEventPayload] = []
    let client: CloudAPIClient
    let attachments: AttachmentStore
    let elicitations: ElicitationCenter
    var onRunStarted: @Sendable (UUID, UUID, String) async -> Void
    var onEvent: @Sendable (UUID, UUID, String, Data) async throws -> Void
    var onSnapshot: @Sendable (UUID, UUID, String, Data) async throws -> Void
    var onCursor: @Sendable (UUID, UUID, String, Int) async -> Void
    var onRunFinished: @Sendable (UUID, UUID, String) async -> Void

    init(client: CloudAPIClient, attachments: AttachmentStore = .shared,
         elicitations: ElicitationCenter = ElicitationCenter(),
         onRunStarted: @escaping @Sendable (UUID, UUID, String) async -> Void = { _, _, _ in },
         onEvent: @escaping @Sendable (UUID, UUID, String, Data) async throws -> Void = { _, _, _, _ in },
         onSnapshot: @escaping @Sendable (UUID, UUID, String, Data) async throws -> Void = { _, _, _, _ in },
         onCursor: @escaping @Sendable (UUID, UUID, String, Int) async -> Void = { _, _, _, _ in },
         onRunFinished: @escaping @Sendable (UUID, UUID, String) async -> Void = { _, _, _ in }) {
        self.client = client; self.attachments = attachments; self.elicitations = elicitations
        self.onRunStarted = onRunStarted; self.onEvent = onEvent; self.onSnapshot = onSnapshot; self.onCursor = onCursor; self.onRunFinished = onRunFinished
    }

    func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent> { stream(request, runID: nil, cursor: 0, pendingEvents: []) }
    func resume(request: ChatRunRequest, runID: String, cursor: Int, pendingEvents: [CloudEventPayload] = []) -> AsyncStream<AgentEvent> {
        stream(request, runID: runID, cursor: cursor, pendingEvents: pendingEvents)
    }
    func cancel(runID: String) async throws {
        try await client.sendVoid("/v1/runs/\(CloudAPIClient.segment(runID))/cancel", method: "POST", body: Data(#"{"type":"run.cancel"}"#.utf8))
    }

    private func stream(_ request: ChatRunRequest, runID: String?, cursor: Int, pendingEvents: [CloudEventPayload]) -> AsyncStream<AgentEvent> {
        AsyncStream { out in
            let control = CloudRunControl()
            let pending = CloudPendingActions()
            let worker = Task {
                do {
                    let id: String
                    if let runID { id = runID } else { id = try await start(request) }
                    await control.setRunID(id)
                    await onRunStarted(request.conversationID, request.turnID, id)
                    let wasCancelled = await control.wasCancelled()
                    if request.isCancelled() || wasCancelled {
                        if let cancellation = await control.requestCancel(client: client) { try await cancellation.value }
                        out.yield(.finished(.cancelled)); out.finish(); await onDetached(); return
                    }
                    for event in pendingEvents {
                        await respond(to: event, runID: id, request: request, pending: pending, out: out)
                    }
                    let mapper = CloudEventMapper(request: request)
                    for payload in priorEvents { _ = await mapper.map(payload) }
                    var nextCursor = cursor
                    var recoveries = 0
                    while true {
                        do {
                    try await CloudSSEClient(client: client).consume(runID: id, chatID: request.cloudChatID ?? request.conversationID.uuidString, after: nextCursor,
                        onCursor: { cursor in await onCursor(request.conversationID, request.turnID, id, cursor) },
                        onEvent: { _, raw in try await onEvent(request.conversationID, request.turnID, id, raw) }) { event in
                        for mapped in await mapper.map(event.event) {
                            if case .terminated = out.yield(mapped) { throw CancellationError() }
                        }
                        await respond(to: event.event, runID: id, request: request, pending: pending, out: out)
                    }
                            break
                        } catch let error as CloudAPIError where error.code == "cursor_expired" {
                            guard recoveries < 2 else { throw CloudAPIError.malformedEvent("Snapshot recovery limit exceeded") }
                            recoveries += 1
                            let raw = try await client.jsonData("/v1/runs/\(CloudAPIClient.segment(id))/snapshot")
                            let snapshot = try JSONDecoder().decode(CloudRunSnapshot.self, from: raw)
                            guard snapshot.run.id == id, snapshot.run.chatId == request.cloudChatID ?? request.conversationID.uuidString else {
                                throw CloudAPIError.malformedEvent("snapshot identity mismatch")
                            }
                            await pending.cancelAll()
                            try await onSnapshot(request.conversationID, request.turnID, id, raw)
                            for mapped in try await mapper.replace(with: snapshot) { out.yield(mapped) }
                            nextCursor = snapshot.lastEventId
                            await onCursor(request.conversationID, request.turnID, id, nextCursor)
                            if snapshot.isTerminal { break }
                            for payload in snapshot.pendingEvents {
                                await respond(to: payload, runID: id, request: request, pending: pending, out: out)
                            }
                        }
                    }
                    await onRunFinished(request.conversationID, request.turnID, id)
                } catch {
                    // Transport cancellation detaches only. Stop is the explicit
                    // request flag handled by the watcher, never onTermination.
                    if !Task.isCancelled { out.yield(.finished(request.isCancelled() ? .cancelled : .failed(error.localizedDescription))) }
                }
                await pending.cancelAll()
                await onDetached()
                out.finish()
            }
            let watcher = Task {
                while !Task.isCancelled {
                    if request.isCancelled() {
                        if let cancellation = await control.requestCancel(client: client) {
                            try? await cancellation.value
                            worker.cancel()
                            await pending.cancelAll()
                            out.yield(.finished(.cancelled)); out.finish()
                        }
                        // If start is in-flight it observes the cancellation as
                        // soon as it receives the durable run id.
                        return
                    }
                    do { try await Task.sleep(for: .milliseconds(50)) } catch { return }
                }
            }
            out.onTermination = { _ in
                watcher.cancel()
                if request.isCancelled() {
                    // Stop can terminate the consumer before the 50ms watcher
                    // observes its flag. This uncancelled task owns the durable
                    // POST, independently of the now-terminated stream.
                    Task {
                        if let cancellation = await control.requestCancel(client: client) {
                            _ = try? await cancellation.value
                            worker.cancel()
                        }
                        // Start still in flight: let it obtain the durable id,
                        // observe the flag and cancel that run before attaching.
                    }
                } else { worker.cancel() } // detach only
            }
        }
    }

    /// Restores outstanding human-response tasks from a durable journal without
    /// blocking the event reader. Resolved requests are cancelled by SSE events.
    private func respond(to payload: CloudEventPayload, runID id: String, request: ChatRunRequest,
                         pending: CloudPendingActions, out: AsyncStream<AgentEvent>.Continuation) async {
        switch payload {
        case .approval(let approval):
            await pending.start("approval:" + approval.callId) {
                let decision = await request.approvals.decide(approval.native)
                guard !Task.isCancelled, !request.isCancelled() else { return }
                do {
                    let body = try JSONEncoder().encode(CloudApprovalDecision(approvalId: approval.id, decision: CloudEventMapper.decisionString(decision)))
                    try await client.sendVoid("/v1/runs/\(CloudAPIClient.segment(id))/approvals", method: "POST", body: body)
                } catch { if !Task.isCancelled { out.yield(.finished(.failed(error.localizedDescription))); out.finish() } }
            }
        case .approvalResolved(let callID, _): await pending.cancel("approval:" + callID)
        case .elicitation(let elicitation):
            await pending.start("elicitation:" + elicitation.id) {
                let kind: MCPElicitation.Kind
                if elicitation.mode == "url", let url = elicitation.url, ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                    kind = .url(url)
                } else { kind = .form(schema: elicitation.schema) }
                let result = await elicitations.elicit(MCPElicitation(serverID: elicitation.connectorId ?? "cloud", serverName: elicitation.connectorName ?? "Cloud connector", message: elicitation.message, kind: kind), scope: request.elicitationScope)
                guard !Task.isCancelled, !request.isCancelled() else { return }
                let action: String, content: JSONValue?
                switch result {
                case .accept(let value): action = "accept"; content = value
                case .decline: action = "decline"; content = nil
                case .cancel: action = "cancel"; content = nil
                }
                do {
                    try await client.sendVoid("/v1/runs/\(CloudAPIClient.segment(id))/elicitations", method: "POST", body: JSONEncoder().encode(CloudElicitationResponse(elicitationId: elicitation.id, action: action, content: content)))
                } catch { if !Task.isCancelled { out.yield(.finished(.failed(error.localizedDescription))); out.finish() } }
            }
        case .elicitationResolved(let id): await pending.cancel("elicitation:" + id)
        default: break
        }
    }

    private func start(_ request: ChatRunRequest) async throws -> String {
        let chatID = request.cloudChatID ?? request.conversationID.uuidString
        let selection = Self.modelSelection(request.modelID)
        let chat = CloudChatInput(id: chatID, title: String(request.userText.prefix(100)), mode: request.mode.rawValue,
            providerId: selection.provider, modelId: selection.model, effort: request.effort.rawValue,
            connectorIds: request.connectorIDs, disabledConnectorIds: request.disabledServerIDs.sorted())
        do {
            let _: CloudChatIdentity = try await client.send("/v1/chats/\(CloudAPIClient.segment(chatID))")
        } catch let error as CloudAPIError where error.statusCode == 404 {
            let _: CloudChatIdentity = try await client.send("/v1/chats", method: "POST", body: JSONEncoder().encode(chat))
        }
        try Task.checkCancellation()
        let hidden = await request.hiddenFromCode()
        var ids: [String] = []
        for attachment in request.attachments {
            try Task.checkCancellation()
            guard let bytes = attachments.data(for: attachment.id) else { throw CocoaError(.fileReadNoSuchFile) }
            ids.append(try await upload(attachment, bytes: bytes, chatID: chatID, hidden: hidden.contains(attachment.id) || attachment.isHiddenFromCode))
        }
        var start = CloudStartRun(chatId: chatID, text: request.userText, providerId: selection.provider,
            modelId: selection.model, mode: request.mode.rawValue, effort: request.effort.rawValue,
            attachmentIds: ids, webSearch: request.webSearch, idempotencyKey: request.turnID.uuidString,
            clientTurnId: request.turnID.uuidString)
        #if DEBUG
        start.script = UserDefaults.standard.string(forKey: "PraxisCloudScenario").map {
            switch $0 { case "nested": "nestedApproval"; case "cancel", "reconnect": "long"; default: $0 }
        }
        #endif
        let run: CloudRun = try await client.send("/v1/runs", method: "POST", body: JSONEncoder().encode(start))
        return run.id
    }

    private func upload(_ attachment: Attachment, bytes: Data, chatID: String, hidden: Bool) async throws -> String {
        let name = AttachmentMedia.fileName(for: attachment)
        let mediaType = attachment.mediaType ?? AttachmentMedia.mediaType(forFileName: name)
        let upload: CloudUploadURL = try await client.send("/v1/uploads", method: "POST", body: JSONEncoder().encode(CloudUploadRequest(name: name, mediaType: mediaType, size: bytes.count, chatId: chatID)))
        guard let originURL = URL(string: "/", relativeTo: upload.uploadUrl)?.absoluteURL,
              (try? CloudServerConfiguration(baseURL: originURL)) != nil else { throw CloudAPIError.invalidServer }
        var request = URLRequest(url: upload.uploadUrl)
        request.httpMethod = upload.method?.rawValue ?? "POST"; request.httpBody = bytes
        request.setValue(mediaType, forHTTPHeaderField: "Content-Type")
        request.httpShouldHandleCookies = false
        // Override any Authorization in the injectable session's default
        // headers as well as avoiding the API client's bearer header.
        request.setValue("", forHTTPHeaderField: "Authorization")
        // Signed URLs grant upload access. Never forward the session bearer.
        let (data, response) = try await client.session.data(for: request, delegate: CloudRedirectGuard())
        try CloudAPIClient.validate(response, data: data)
        let storage = try JSONDecoder().decode(CloudStorageReceipt.self, from: data)
        guard !storage.storageId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CloudAPIError.invalidResponse }
        let complete = CloudUploadComplete(storageId: storage.storageId, name: name, mediaType: mediaType, size: bytes.count, chatId: chatID)
        // v0 upload.complete lacks privacy metadata; send an additive field so
        // servers with v1 support can enforce Hide from code before the run.
        var object = try JSONEncoder().encode(complete)
        var json = try JSONDecoder().decode(JSONValue.self, from: object)
        if case .object(var fields) = json { fields["hiddenFromCode"] = .bool(hidden); json = .object(fields) }
        object = Data(json.encodedString().utf8)
        let saved: CloudAttachment = try await client.send("/v1/uploads/complete", method: "POST", body: object)
        return saved.id
    }

    static func modelSelection(_ id: String) -> (provider: String?, model: String?) {
        if id.hasPrefix("cloud:"), let data = Data(base64Encoded: String(id.dropFirst(6))),
           let pair = try? JSONDecoder().decode([String].self, from: data), pair.count == 2 { return (pair[0], pair[1]) }
        return (nil, id.isEmpty ? nil : id)
    }
}

private actor CloudRunControl {
    private var runID: String?
    private var cancelled = false
    private var cancellation: Task<Void, Error>?
    func setRunID(_ id: String) { runID = id }
    func wasCancelled() -> Bool { cancelled }
    func requestCancel(client: CloudAPIClient) -> Task<Void, Error>? {
        cancelled = true
        if let cancellation { return cancellation }
        guard let runID else { return nil }
        let task = Task {
            try await client.sendVoid("/v1/runs/\(CloudAPIClient.segment(runID))/cancel", method: "POST",
                                      body: Data(#"{"type":"run.cancel"}"#.utf8))
        }
        cancellation = task
        return task
    }
}

private actor CloudPendingActions {
    private var tasks: [String: Task<Void, Never>] = [:]
    func start(_ key: String, operation: @escaping @Sendable () async -> Void) {
        guard tasks[key] == nil else { return }
        tasks[key] = Task { await operation() }
    }
    func cancel(_ key: String) { tasks.removeValue(forKey: key)?.cancel() }
    func cancelAll() async {
        let old = Array(tasks.values); tasks.removeAll()
        for task in old { task.cancel() }
        for task in old { await task.value }
    }
}

struct CloudConfigurationErrorEngine: ChatEngine {
    let kind: EngineKind = .cloud
    let message: String
    func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent> {
        AsyncStream { out in out.yield(.finished(.failed(message))); out.finish() }
    }
}
