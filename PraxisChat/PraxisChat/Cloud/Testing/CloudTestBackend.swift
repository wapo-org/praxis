#if DEBUG
import Foundation

/// Deterministic protocol-v0 server behind URLSession. The production HTTP and
/// SSE decoders still consume real status codes, headers and fragmented bytes.
/// All mutable server/connection state belongs to `queue`; callbacks never run
/// under a lock used by URLSession cancellation.
final class CloudTestBackend: @unchecked Sendable {
    enum Scenario: String, CaseIterable, Sendable {
        case text, tools, approval, nestedApproval, elicitation, compaction, vision, cancel, reconnect, error
    }
    struct Request: Sendable {
        let method: String
        let path: String
        let lastEventID: String?
        let body: Data
    }
    static let baseURL = URL(string: "https://cloud.praxis.test")!
    static let token = "dev-local"
    static let timestamp = "2026-10-29T14:00:00.000Z"
    private static let registry = Registry()
    private static let launchBackend = CloudTestBackend(
        scenario: Scenario(rawValue: UserDefaults.standard.string(forKey: "PraxisCloudScenario") ?? "text") ?? .text)

    static func makeLaunchSessionIfEnabled() -> URLSession? {
        UserDefaults.standard.bool(forKey: "PraxisCloudStub") ? launchBackend.makeSession() : nil
    }

    private final class Registry: @unchecked Sendable {
        let lock = NSLock()
        var backends: [String: CloudTestBackend] = [:]
        func insert(_ backend: CloudTestBackend) { lock.withLock { backends[backend.id] = backend } }
        func lookup(_ id: String) -> CloudTestBackend? { lock.withLock { backends[id] } }
        func remove(_ id: String) { _ = lock.withLock { backends.removeValue(forKey: id) } }
    }
    private final class Run {
        let id: String
        let chatID: String
        let scenario: Scenario
        let prompt: String
        var status = "running"
        var outcome: String?
        var events: [Data] = []
        var messages: [[String: Any]] = []
        var streams: [Connection] = []
        var openedStreams = 0
        var decisions: [String: String] = [:]
        init(id: String, chatID: String, scenario: Scenario, prompt: String) {
            self.id = id; self.chatID = chatID; self.scenario = scenario; self.prompt = prompt
        }
    }
    private final class Connection: @unchecked Sendable {
        let loader: StubProtocol
        var stopped = false
        var nextDelivery = DispatchTime.now()
        init(_ loader: StubProtocol) { self.loader = loader }
        func response(status: Int = 200, contentType: String = "application/json") {
            guard !stopped, let url = loader.request.url else { return }
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": contentType, "Cache-Control": "no-cache"])!
            loader.client?.urlProtocol(loader, didReceive: response, cacheStoragePolicy: .notAllowed)
        }
        func bytes(_ data: Data) {
            guard !stopped else { return }
            loader.client?.urlProtocol(loader, didLoad: data)
        }
        func finish() {
            guard !stopped else { return }
            stopped = true
            loader.client?.urlProtocolDidFinishLoading(loader)
        }
        func disconnect() {
            guard !stopped else { return }
            stopped = true
            loader.client?.urlProtocol(loader, didFailWithError: URLError(.networkConnectionLost))
        }
    }
    private final class StubProtocol: URLProtocol, @unchecked Sendable {
        override class func canInit(with request: URLRequest) -> Bool {
            request.value(forHTTPHeaderField: "X-Praxis-Test-Backend") != nil
        }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            guard let id = request.value(forHTTPHeaderField: "X-Praxis-Test-Backend"),
                  let backend = registry.lookup(id) else {
                client?.urlProtocol(self, didFailWithError: URLError(.resourceUnavailable)); return
            }
            backend.queue.async { backend.start(self) }
        }
        override func stopLoading() {
            guard let id = request.value(forHTTPHeaderField: "X-Praxis-Test-Backend"),
                  let backend = registry.lookup(id) else { return }
            backend.queue.async { backend.stop(self) }
        }
    }

    private let id = UUID().uuidString
    private let queue = DispatchQueue(label: "praxis.cloud.test-backend")
    private let scenario: Scenario
    private let chunkDelay: TimeInterval
    private var requests: [Request] = []
    private var connections: [ObjectIdentifier: Connection] = [:]
    private var chats: [String: [String: Any]] = [:]
    private var runs: [String: Run] = [:]
    private var idempotency: [String: (Data, String)] = [:]
    private var authenticated = true
    private var nextChat = 0
    private var nextRun = 0

    init(scenario: Scenario = .text, chunkDelay: TimeInterval = 0.025) {
        self.scenario = scenario; self.chunkDelay = chunkDelay
    }

    /// Sessions are isolated even when multiple test backends run concurrently.
    /// A backend intercepts every request in its session, so a missing fixture
    /// fails locally with 404 instead of accidentally reaching the network.
    func makeSession() -> URLSession {
        Self.registry.insert(self)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Praxis-Test-Backend": id, "Authorization": "Bearer \(Self.token)"]
        configuration.timeoutIntervalForRequest = 15
        return URLSession(configuration: configuration)
    }
    func recordedRequests() -> [Request] { queue.sync { requests } }
    func shutdown() {
        queue.sync {
            for connection in connections.values { connection.finish() }
            connections.removeAll()
        }
        Self.registry.remove(id)
    }
    private func stop(_ loader: StubProtocol) {
        connections.removeValue(forKey: ObjectIdentifier(loader))?.stopped = true
        for run in runs.values { run.streams.removeAll { $0.loader === loader } }
    }
    private func start(_ loader: StubProtocol) {
        let connection = Connection(loader)
        connections[ObjectIdentifier(loader)] = connection
        let request = loader.request
        let path = request.url?.path ?? ""
        let method = request.httpMethod ?? "GET"
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(contentsOf: buffer.prefix(count))
            }
        }
        requests.append(Request(method: method, path: path,
                                lastEventID: request.value(forHTTPHeaderField: "Last-Event-ID"), body: body))
        let input = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
        func reply(_ value: [String: Any], _ status: Int = 200) {
            connection.response(status: status); connection.bytes(Self.json(value)); connection.finish()
            connections.removeValue(forKey: ObjectIdentifier(loader))
        }
        func failure(_ code: String, _ message: String, _ status: Int) {
            reply(["type": "error", "code": code, "message": message], status)
        }
        if path.hasPrefix("/v1/auth/") {
            switch (method, path) {
            case ("POST", "/v1/auth/sign-in"), ("POST", "/v1/auth/sign-up"), ("POST", "/v1/auth/dev"):
                authenticated = true; reply(session(includeToken: true))
            case ("POST", "/v1/auth/sign-out"):
                authenticated = false; reply(["type": "ok"])
            case ("GET", "/v1/auth/session"):
                if authenticated { reply(session(includeToken: false)) }
                else { failure("unauthorized", "Sign in to continue.", 401) }
            default: failure("not_found", "No auth fixture for \(method) \(path)", 404)
            }
            return
        }
        guard authenticated, request.value(forHTTPHeaderField: "Authorization") == "Bearer \(Self.token)" else {
            failure("unauthorized", "Sign in to continue.", 401); return
        }
        let components = path.split(separator: "/").map(String.init)
        let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func parameter(_ name: String) -> String? { query.first { $0.name == name }?.value }
        switch (method, path) {
        case ("GET", "/v1/bootstrap"):
            reply(["type": "bootstrap", "protocolVersion": 0, "user": user,
                   "chats": Array(chats.values), "providers": [provider], "models": [model],
                   "connectors": [], "skills": [], "activeRuns": runs.values.filter { $0.outcome == nil }.map(descriptor),
                   "syncCursor": "stub-0", "syncRoot": "stub-root", "serverTime": Self.timestamp])
        case ("POST", "/v1/chats"):
            nextChat += 1
            let chatID = input["id"] as? String ?? "stub-chat-\(nextChat)"
            var chat = input
            chat["type"] = "chat"; chat["id"] = chatID
            chat["title"] = input["title"] ?? "New chat"; chat["mode"] = input["mode"] ?? "build"
            chat["createdAt"] = Self.timestamp; chat["updatedAt"] = Self.timestamp
            chat["connectorIds"] = input["connectorIds"] ?? []; chat["disabledConnectorIds"] = input["disabledConnectorIds"] ?? []
            chats[chatID] = chat; reply(chat, 201)
        case ("GET", "/v1/chats"): reply(page(Array(chats.values)))
        case ("GET", "/v1/providers"): reply(page([provider]))
        case ("GET", "/v1/models"):
            let matches = [model].filter { item in
                guard let q = parameter("q"), !q.isEmpty else { return true }
                return (item["displayName"] as? String ?? "").localizedCaseInsensitiveContains(q)
            }
            reply(page(parameter("cursor") == nil ? matches : []))
        case ("GET", "/v1/connectors"), ("GET", "/v1/skills"), ("GET", "/v1/skill-registries"), ("GET", "/v1/consents"):
            reply(page([]))
        case ("GET", "/v1/sync/root"):
            reply(["type": "sync.root", "root": "stub-root", "cursor": "stub-0", "strategy": "cursor"])
        case ("POST", "/v1/sync/pull"), ("POST", "/v1/sync/tree"):
            reply(["type": "sync.response", "strategy": input["strategy"] ?? "cursor", "root": "stub-root",
                   "cursor": "stub-0", "entities": [], "nextCursor": NSNull(), "nodes": []])
        case ("POST", "/v1/transcribe"):
            reply(["type": "transcription", "text": "Cloud transcription fixture", "segments": []])
        case ("POST", "/v1/runs"):
            guard let chatID = input["chatId"] as? String, chats[chatID] != nil else {
                failure("not_found", "Chat not found", 404); return
            }
            let key = input["idempotencyKey"] as? String ?? input["clientTurnId"] as? String
            let canonical = Self.json(input)
            if let key, let (previous, runID) = idempotency[chatID + key], let run = runs[runID] {
                if previous == canonical { reply(descriptor(run), 202) }
                else { failure("conflict", "Idempotency body changed", 409) }
                return
            }
            if runs.values.contains(where: { $0.chatID == chatID && $0.outcome == nil }) {
                failure("conflict", "Chat already has an active run", 409); return
            }
            nextRun += 1
            let script = (input["script"] as? String).flatMap(Scenario.init(rawValue:)) ?? scenario
            let run = Run(id: "stub-run-\(nextRun)", chatID: chatID, scenario: script, prompt: input["text"] as? String ?? "")
            runs[run.id] = run
            if let key { idempotency[chatID + key] = (canonical, run.id) }
            prepare(run); reply(descriptor(run), 202)
        default:
            if components.count >= 3, components[1] == "runs", let run = runs[components[2]] {
                if method == "GET", components.count == 3 { reply(descriptor(run)); return }
                if method == "GET", components.last == "events" {
                    let cursor = request.value(forHTTPHeaderField: "Last-Event-ID") ?? parameter("after") ?? "0"
                    guard let after = Int(cursor), after >= 0, after <= run.events.count else {
                        failure("cursor_expired", "Invalid event cursor", 409); return
                    }
                    stream(connection, run: run, after: after); return
                }
                if method == "POST", components.last == "cancel" {
                    if run.outcome == nil { finish(run, answer: nil, outcome: "cancelled") }
                    reply(descriptor(run), 202); return
                }
                if method == "POST", components.last == "approvals" {
                    let approvalID = input["approvalId"] as? String ?? ""
                    let decision = input["decision"] as? String ?? ""
                    guard approvalID == "stub-approval", ["allowOnce", "allowAlways", "deny"].contains(decision) else {
                        failure("invalid_input", "Unknown approval or decision", 400); return
                    }
                    if let previous = run.decisions[approvalID] {
                        if previous == decision { reply(descriptor(run), 202) }
                        else { failure("conflict", "Approval already resolved", 409) }
                        return
                    }
                    guard run.status == "awaitingApproval" else { failure("conflict", "Run is not awaiting approval", 409); return }
                    run.decisions[approvalID] = decision; run.status = "running"
                    emit(run, ["type": "approval.resolved", "approvalId": approvalID, "callId": "stub-call", "decision": decision])
                    emit(run, ["type": "tool.finished", "callId": "stub-call", "completion": ["type": "tool.completion", "status": decision == "deny" ? "denied" : "succeeded", "summary": "Fixture decision recorded", "preview": ""]])
                    if run.scenario == .nestedApproval { toolFinished(run, id: "stub-parent") }
                    finish(run, answer: decision == "deny" ? "Cloud tool denied." : "Cloud tool approved.")
                    reply(descriptor(run), 202); return
                }
                if method == "POST", components.last == "elicitations" {
                    guard run.status == "awaitingElicitation", input["elicitationId"] as? String == "stub-elicitation",
                          let action = input["action"] as? String, ["accept", "decline", "cancel"].contains(action) else {
                        failure("conflict", "No matching elicitation", 409); return
                    }
                    emit(run, ["type": "elicitation.resolved", "elicitationId": "stub-elicitation", "action": action])
                    finish(run, answer: "Cloud form \(action)ed."); reply(descriptor(run), 202); return
                }
            }
            if components.count >= 3, components[1] == "chats", var chat = chats[components[2]] {
                if method == "GET", components.last == "messages" {
                    let messages = runs.values.filter { $0.chatID == components[2] }
                        .sorted { $0.id.localizedStandardCompare($1.id) == .orderedAscending }.flatMap(\.messages)
                    reply(page(messages)); return
                }
                if method == "GET" { reply(chat); return }
                if method == "PATCH" {
                    for (key, value) in input where key != "type" { chat[key] = value }
                    chats[components[2]] = chat; reply(chat); return
                }
                if method == "DELETE" {
                    for run in runs.values where run.chatID == components[2] && run.outcome == nil {
                        finish(run, answer: nil, outcome: "cancelled")
                    }
                    chats.removeValue(forKey: components[2]); reply(["type": "ok"]); return
                }
            }
            failure("not_found", "No fixture for \(method) \(path)", 404)
        }
    }

    private func prepare(_ run: Run) {
        emit(run, ["type": "run.started"])
        emit(run, ["type": "messages.committed", "messages": [message(run, role: "user", text: run.prompt)]])
        emit(run, ["type": "iteration.started", "iteration": 1])
        switch run.scenario {
        case .approval, .nestedApproval:
            if run.scenario == .nestedApproval {
                emit(run, ["type": "tool.started", "activity": activity(id: "stub-parent", name: "js")])
                emit(run, ["type": "tool.running", "callId": "stub-parent"])
            }
            var call = activity(id: "stub-call", name: "fixture_write")
            var approval: [String: Any] = ["type": "approval", "id": "stub-approval", "callId": "stub-call", "toolName": "fixture_write", "source": ["type": "builtin"], "arguments": ["path": "fixture.txt"], "reason": "This fixture changes a file.", "title": "Write fixture.txt"]
            if run.scenario == .nestedApproval { call["parentCallId"] = "stub-parent"; approval["parentCallId"] = "stub-parent" }
            emit(run, ["type": "tool.started", "activity": call]); emit(run, ["type": "tool.ready", "activity": call])
            emit(run, ["type": "approval.requested", "approval": approval])
            emit(run, ["type": "run.parked", "reason": "approval"]); run.status = "awaitingApproval"
        case .elicitation:
            emit(run, ["type": "elicitation.requested", "elicitation": ["type": "elicitation", "id": "stub-elicitation", "message": "Choose a fixture name", "schema": ["type": "object", "properties": ["name": ["type": "string", "title": "Name"]], "required": ["name"]]]])
            emit(run, ["type": "run.parked", "reason": "elicitation"]); run.status = "awaitingElicitation"
        case .cancel:
            emit(run, ["type": "text.delta", "blockId": "stub-text", "text": "Cloud run is waiting for Stop."])
        case .error:
            finish(run, answer: nil, outcome: "failed")
        case .tools:
            emit(run, ["type": "tool.started", "activity": activity(id: "stub-call", name: "fixture_read")])
            emit(run, ["type": "tool.running", "callId": "stub-call"])
            emit(run, ["type": "tool.progress", "callId": "stub-call", "kind": "trace", "lines": ["fixture trace"], "traceKind": "note"])
            toolFinished(run, id: "stub-call"); finish(run, answer: answer(run))
        case .compaction:
            emit(run, ["type": "compaction", "id": "stub-compaction", "phase": "started"])
            emit(run, ["type": "compaction", "id": "stub-compaction", "phase": "finished", "summary": "Earlier fixture turns", "throughMessageId": "\(run.id)-user", "inputTokens": 4000, "outputTokens": 400])
            finish(run, answer: answer(run))
        case .vision:
            emit(run, ["type": "vision.activity", "id": "stub-vision", "phase": "started", "attachmentId": "stub-image", "modelId": "stub-vision-model", "question": "What is in this image?"])
            emit(run, ["type": "vision.activity", "id": "stub-vision", "phase": "finished", "attachmentId": "stub-image", "answer": "A fixture image."])
            finish(run, answer: answer(run))
        case .text, .reconnect: finish(run, answer: answer(run))
        }
    }
    private func activity(id: String, name: String) -> [String: Any] {
        ["type": "tool.activity", "id": id, "name": name, "source": ["type": "builtin"], "arguments": ["path": "fixture.txt"], "presentation": ["type": "tool.presentation", "category": "edit", "runningTitle": "Updating fixture…", "finishedTitle": "Updated fixture"]]
    }
    private func toolFinished(_ run: Run, id: String) {
        emit(run, ["type": "tool.finished", "callId": id, "completion": ["type": "tool.completion", "status": "succeeded", "summary": "Fixture complete", "preview": "Done"]])
    }
    private func answer(_ run: Run) -> String {
        switch run.scenario {
        case .reconnect: "Cloud reconnect: one 🌍 answer, no duplicate text."
        case .compaction: "Cloud context compacted."
        case .vision: "Cloud vision fallback complete."
        case .tools: "Cloud tool complete."
        default: "Cloud reply: \(run.prompt) 🌍"
        }
    }
    private func finish(_ run: Run, answer: String?, outcome: String = "completed") {
        if let answer {
            // Deliberately split the answer into deltas; replay must not double it.
            let midpoint = answer.index(answer.startIndex, offsetBy: answer.count / 2)
            emit(run, ["type": "text.delta", "blockId": "stub-text", "text": String(answer[..<midpoint])])
            emit(run, ["type": "text.delta", "blockId": "stub-text", "text": String(answer[midpoint...])])
            emit(run, ["type": "text.finished", "blockId": "stub-text"])
            emit(run, ["type": "messages.committed", "messages": [message(run, role: "assistant", text: answer)]])
        }
        run.outcome = outcome; run.status = outcome == "completed" ? "completed" : outcome
        emit(run, ["type": "run.finished", "outcome": outcome])
    }
    private func emit(_ run: Run, _ payload: [String: Any]) {
        if payload["type"] as? String == "messages.committed", let messages = payload["messages"] as? [[String: Any]] {
            run.messages.append(contentsOf: messages)
        }
        let eventID = run.events.count + 1
        let envelope: [String: Any] = ["type": "run.event", "id": eventID, "runId": run.id, "chatId": run.chatID, "createdAt": Self.timestamp, "event": payload]
        let data = Self.json(envelope)
        var frame = Data("id: \(eventID)\r\nevent: run.event\r\ndata: ".utf8)
        frame.append(data); frame.append(Data("\r\n\r\n".utf8)); run.events.append(frame)
        for connection in run.streams where !connection.stopped {
            deliver(frame, to: connection, after: 0)
            if payload["type"] as? String == "run.finished" {
                queue.asyncAfter(deadline: connection.nextDelivery + chunkDelay) { connection.finish() }
            }
        }
    }
    private func stream(_ connection: Connection, run: Run, after: Int) {
        connection.response(contentType: "text/event-stream; charset=utf-8")
        connection.bytes(Data(": fixture keepalive\r\nretry: 10\r\n\r\n".utf8))
        run.openedStreams += 1
        let disconnect = run.scenario == .reconnect && run.openedStreams == 1
        // Drop after the first text delta: this catches both duplicate text and
        // implementations that incorrectly treat a broken stream as completion.
        let end = disconnect ? min(run.events.count, 4) : run.events.count
        for index in after..<max(after, end) {
            deliver(run.events[index], to: connection, after: Double(index - after + 1) * chunkDelay * 4)
        }
        let completionDelay = Double(max(0, end - after) + 1) * chunkDelay * 4
        if disconnect {
            queue.asyncAfter(deadline: .now() + completionDelay) { connection.disconnect() }
        } else if run.outcome != nil {
            queue.asyncAfter(deadline: .now() + completionDelay) { connection.finish() }
        } else { run.streams.append(connection) }
    }
    private func deliver(_ data: Data, to connection: Connection, after delay: TimeInterval) {
        // One-byte first fragment and a split inside the final UTF-8 scalar
        // exercise boundaries independently of URLSession's callback batching.
        let utf8Cut = data.firstIndex(where: { $0 >= 0x80 }).map { $0 + 1 } ?? max(1, data.count - 5)
        let cuts = [0, min(1, data.count), utf8Cut, data.count]
        let proposed = DispatchTime.now() + delay
        let start = proposed > connection.nextDelivery ? proposed : connection.nextDelivery
        connection.nextDelivery = start + chunkDelay * 3
        for index in 0..<3 {
            let fragment = data.subdata(in: cuts[index]..<cuts[index + 1])
            queue.asyncAfter(deadline: start + Double(index) * chunkDelay) { connection.bytes(fragment) }
        }
    }
    private func descriptor(_ run: Run) -> [String: Any] {
        var value: [String: Any] = ["type": "run", "id": run.id, "chatId": run.chatID, "status": run.status,
                                  "createdAt": Self.timestamp, "updatedAt": Self.timestamp, "lastEventId": run.events.count]
        if let outcome = run.outcome { value["outcome"] = outcome }
        return value
    }
    private func message(_ run: Run, role: String, text: String) -> [String: Any] {
        ["type": "message", "id": "\(run.id)-\(role)", "chatId": run.chatID, "runId": run.id, "role": role,
         "parts": [["type": "text", "text": text]], "createdAt": Self.timestamp, "updatedAt": Self.timestamp]
    }
    private var user: [String: Any] { ["type": "user", "id": "stub-user", "name": "Cloud Tester", "email": "cloud@example.test"] }
    private func session(includeToken: Bool) -> [String: Any] {
        var value: [String: Any] = ["type": "session", "user": user, "expiresAt": "2099-10-29T14:00:00.000Z"]
        if includeToken { value["bearerToken"] = Self.token }; return value
    }
    private var capabilities: [String: Any] {
        ["type": "capabilities", "tools": true, "parallelToolCalls": false, "vision": false, "documents": false,
         "imagesInToolResults": false, "reasoningEffort": true, "streamUsage": true, "explicitPromptCaching": false,
         "serverWebSearch": false, "midConversationSystem": false, "serverCompaction": false, "toolSearch": false]
    }
    private var provider: [String: Any] {
        ["type": "provider", "id": "stub-provider", "name": "Cloud fixture", "flavor": "openAIChat", "baseUrl": "https://provider.invalid/v1", "maskedKey": "••••fixture", "capabilities": capabilities, "updatedAt": Self.timestamp]
    }
    private var model: [String: Any] {
        ["type": "model", "id": "stub-model", "providerId": "stub-provider", "displayName": "Cloud Fixture", "capabilities": capabilities, "reasoningEfforts": ["low", "medium", "high"], "pinned": true, "favorite": false]
    }
    private func page(_ items: [[String: Any]]) -> [String: Any] { ["type": "page", "items": items, "nextCursor": NSNull()] }
    private static func json(_ value: [String: Any]) -> Data {
        // Every fixture is JSON checked by the harness tests. Fail loudly for a
        // malformed new fixture rather than silently returning an empty body.
        try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }
}
#endif
