import XCTest
import UIKit
import Synchronization
import AgentCore
import AgentProviders
import AgentMCP
import AgentRuntime
import AgentTestSupport
@testable import PraxisChat

/// `LiveChatEngine` end to end through `ChatStore`, against a scripted
/// provider (and a scripted MCP server where a tool must ask).
@MainActor
final class LiveChatEngineTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!

    override func setUp() async throws {
        directory = temporaryDirectory()
        secrets = InMemorySecretStore()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: Fixtures

    /// `consented`: the provider host is already allowed to receive chat
    /// data (the consent flow has its own tests).
    private func makeServices(withProvider: Bool = true, mcp: ScriptedTransport? = nil,
                              consented: Bool = true) throws -> AgentServices {
        let settings = ProviderSettings(fileURL: directory.appendingPathComponent("Providers.json"), secrets: secrets)
        if withProvider {
            var profile = ProviderProfile.draft(.customAnthropic)
            profile.endpoint.baseURL = URL(string: "http://localhost:9/v1")!
            profile.defaultModel = "test-model"
            try settings.save(profile, apiKey: "sk-test")
        }
        let connectors = ConnectorLibrary(fileURL: directory.appendingPathComponent("Connectors.json"), secrets: secrets,
                                          transport: mcp ?? ScriptedTransport(replies: []))
        let skills = SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills"))
        let consent = AIDataConsent(fileURL: nil)
        if consented { consent.grant("localhost:9", providerName: "Test") }
        return AgentServices(settings: settings, connectors: connectors, skills: skills, elicitations: ElicitationCenter(),
                             providerTransport: ScriptedTransport(replies: []), attachments: attachments, consent: consent)
    }

    private lazy var attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))

    private func engine(_ services: AgentServices, _ provider: any ModelProvider) -> LiveChatEngine {
        let settings = services.settings
        return LiveChatEngine(runtime: services.runtime, resolve: { model in await settings.selection(model: model) },
                              makeProvider: { _, _ in provider }, attachments: attachments, usesBackgroundTasks: false)
    }

    private func store(_ services: AgentServices, _ provider: ScriptedProvider, fresh: Bool = true) -> ChatStore {
        let store = ChatStore(engine: engine(services, provider),
                              conversations: fresh ? [Conversation(title: "New chat")] : nil,
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)
        return store
    }

    private func send(_ store: ChatStore, _ text: String) async {
        store.send(text: text)
        await waitUntil { !store.isRunning }
    }

    private func notes(_ message: Message?) -> [String] {
        message?.parts.compactMap { if case .note(let n) = $0 { return n }; return nil } ?? []
    }

    // MARK: Setup freezing

    func testSetupIsFrozenPersistedAndReusedAfterReload() async throws {
        let services = try makeServices()
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("Hi"), ScriptedProvider.text("Planned")])
        let first = store(services, provider)
        let conv = first.conversations[0]
        XCTAssertTrue(first.isLive)
        XCTAssertEqual(first.model.id, "test-model")

        await send(first, "hello")
        let setup = try XCTUnwrap(conv.setup, "frozen at the first send")
        let turn = conv.turns[0]
        XCTAssertEqual(turn.outcome, .completed)
        XCTAssertEqual(turn.engine, .live)
        XCTAssertEqual(turn.transcript.map(\.role), [.user, .assistant])
        XCTAssertEqual(turn.transcript[0].text, "hello")
        XCTAssertEqual(notes(turn.transcript[0]), [SystemPrompt.modeNote(mode: .auto, effort: .high)])
        XCTAssertEqual(turn.transcript[1].text, "Hi")
        let request = try XCTUnwrap(provider.requests.first)
        XCTAssertEqual(request.model, "test-model")
        XCTAssertEqual(request.system, setup.systemPrompt)
        XCTAssertEqual(request.tools.map(\.name), setup.toolSpecs.map(\.name))

        // Mode change: appended as a note on the next user message only.
        first.mode = .plan
        await send(first, "plan it")
        XCTAssertEqual(conv.setup, setup, "never re-frozen once messages exist")
        let second = try XCTUnwrap(provider.requests.last)
        XCTAssertEqual(second.system, setup.systemPrompt)
        XCTAssertEqual(second.messages.map(\.role), [.user, .assistant, .user])
        XCTAssertEqual(second.messages[0], turn.transcript[0], "history replays byte-identical")
        XCTAssertEqual(notes(second.messages.last), [SystemPrompt.modeNote(mode: .plan, effort: .high)])
        await first.flushPersistence()

        // Relaunch: the setup comes back from disk and keeps being used.
        let provider2 = ScriptedProvider(steps: [ScriptedProvider.text("Still here")])
        let reloaded = store(services, provider2, fresh: false)
        let again = try XCTUnwrap(reloaded.conversations.first { $0.id == conv.id })
        XCTAssertEqual(again.setup, setup)
        reloaded.select(again.id)
        reloaded.mode = .plan
        await send(reloaded, "third")
        XCTAssertEqual(again.setup, setup)
        let third = try XCTUnwrap(provider2.requests.first)
        XCTAssertEqual(third.system, setup.systemPrompt)
        XCTAssertEqual(third.messages.count, 5)
        XCTAssertTrue(notes(third.messages.last).isEmpty, "mode unchanged since the last note")
    }

    func testNoProviderFailsFastPointingToSettings() async throws {
        let services = try makeServices(withProvider: false)
        let provider = ScriptedProvider(steps: [])
        let store = store(services, provider)
        XCTAssertEqual(store.model.id, "")
        await send(store, "hello?")
        let turn = store.conversations[0].turns[0]
        XCTAssertEqual(turn.outcome, .needsProvider)
        XCTAssertTrue(turn.transcript.isEmpty, "nothing was sent")
        XCTAssertNil(store.conversations[0].setup)
        XCTAssertTrue(provider.requests.isEmpty)
        XCTAssertNotNil(turn.outcome?.note)
    }

    // MARK: Approvals and repair

    private static func fakeMCPServer() -> ScriptedTransport {
        ScriptedTransport { request, _ in
            let rpc = request.httpBody.flatMap { try? JSONValue(parsing: $0) } ?? [:]
            let id = rpc["id"] ?? .null
            func reply(_ result: JSONValue) -> ScriptedTransport.Reply {
                .json(JSONValue.object(["jsonrpc": "2.0", "id": id, "result": result]).encodedString())
            }
            switch rpc["method"]?.stringValue {
            case "server/discover"?:
                return reply(["resultType": "complete", "supportedVersions": ["2026-07-28"], "capabilities": ["tools": [:]],
                              "_meta": ["io.modelcontextprotocol/serverInfo": ["name": "fake", "version": "1.0"]]])
            case "tools/list"?:
                return reply(["tools": [["name": "deploy", "description": "Deploys",
                                         "inputSchema": ["type": "object", "properties": [:]]]]])
            case "tools/call"?:
                return reply(["content": [["type": "text", "text": "deployed"]], "isError": false])
            default:
                return .json(JSONValue.object(["jsonrpc": "2.0", "id": id,
                                               "error": ["code": -32601, "message": "Method not found"]]).encodedString())
            }
        }
    }

    private func installAcme(_ services: AgentServices) throws {
        try services.connectors.install(MCPInstaller.parse(url: "https://acme.mcp.test/mcp", name: "Acme"))
    }

    func testAlwaysAllowIsPersistedAndSkipsTheNextApproval() async throws {
        let services = try makeServices(mcp: Self.fakeMCPServer())
        try installAcme(services)
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("c1", "mcp__acme__deploy", "{}")]), ScriptedProvider.text("Deployed"),
            ScriptedProvider.toolCalls([("c2", "mcp__acme__deploy", "{}")]), ScriptedProvider.text("Deployed again"),
        ])
        let store = store(services, provider)
        let conv = store.conversations[0]

        store.send(text: "deploy")
        await waitUntil { !store.approvals.pendingIDs.isEmpty }
        // The approval card's step arrives after the committed tool call.
        await waitUntil { conv.turns[0].activities.flatMap(\.steps).contains { $0.approval != nil } }
        XCTAssertTrue(conv.setup?.toolSpecs.contains { $0.name == "mcp__acme__deploy" } ?? false,
                      "the enabled connector was frozen in")
        store.resolveApproval(try XCTUnwrap(store.approvals.pendingIDs.first), decision: .allowAlways)
        await waitUntil { !store.isRunning }
        XCTAssertEqual(conv.turns[0].outcome, .completed)
        XCTAssertEqual(store.policy.alwaysAllow.count, 1)
        await store.flushPersistence()
        let snapshot = try XCTUnwrap(ConversationStore(directory: directory.appendingPathComponent("Conversations")).load())
        XCTAssertEqual(snapshot.policy.alwaysAllow, store.policy.alwaysAllow, "persisted with the index")

        await send(store, "deploy again")
        XCTAssertTrue(store.approvals.pendingIDs.isEmpty)
        XCTAssertEqual(conv.turns[1].outcome, .completed)
        XCTAssertEqual(conv.turns[1].transcript.last?.text, "Deployed again")
    }

    func testStoppedToolCallIsClosedInTheNextTurnsHistory() async throws {
        let services = try makeServices(mcp: Self.fakeMCPServer())
        try installAcme(services)
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("c1", "mcp__acme__deploy", "{}")]), ScriptedProvider.text("OK"),
        ])
        let store = store(services, provider)
        let conv = store.conversations[0]
        store.send(text: "deploy")
        await waitUntil { !store.approvals.pendingIDs.isEmpty }
        // The approval card's step arrives after the committed tool call.
        await waitUntil { conv.turns[0].activities.flatMap(\.steps).contains { $0.approval != nil } }
        store.stop()
        XCTAssertEqual(conv.turns[0].outcome, .stopped)
        XCTAssertEqual(conv.turns[0].transcript.last?.toolCalls.map(\.id), ["c1"], "the dangling call was committed")

        await send(store, "never mind")
        let request = try XCTUnwrap(provider.requests.last)
        XCTAssertEqual(request.messages.map(\.role), [.user, .assistant, .user, .user])
        XCTAssertEqual(request.messages[2].toolResults.map(\.callID), ["c1"])
        XCTAssertEqual(conv.turns[1].transcript.first?.toolResults.first?.isError, true,
                       "the closing result is persisted with the next turn")
    }

    // MARK: Attachments

    func testImagesGoInAsPartsButArePersistedByReference() async throws {
        let services = try makeServices()
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("A square"), ScriptedProvider.text("Still a square")])
        let store = store(services, provider)
        let png = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { ctx in
            UIColor.red.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        store.attachments = [Attachment(kind: .photo, name: "Photo", imageData: png, store: attachments)]
        await send(store, "what is this?")

        let sent = try XCTUnwrap(provider.requests.first?.messages.last)
        let image = try XCTUnwrap(sent.parts.compactMap { if case .image(let m) = $0 { return m }; return nil }.first)
        XCTAssertEqual(image.data, png)
        XCTAssertEqual(image.mediaType, "image/png")
        let stored = try XCTUnwrap(store.conversations[0].turns[0].transcript.first)
        let reference = try XCTUnwrap(stored.parts.compactMap { if case .image(let m) = $0 { return m }; return nil }.first)
        XCTAssertNotNil(AttachmentMedia.referencedID(reference), "no image bytes in the conversation file")

        await send(store, "and now?")
        let replayed = try XCTUnwrap(provider.requests.last?.messages.first)
        XCTAssertEqual(replayed, sent, "the next request replays the exact bytes")
    }

    // MARK: Elicitation scopes (R3-M5)

    func testCancellingOneScopeLeavesOtherScopesPending() async throws {
        let center = ElicitationCenter()
        func req(_ message: String) -> MCPElicitation {
            MCPElicitation(serverID: "s", serverName: "S", message: message,
                           kind: .form(schema: ["type": "object", "properties": [:]]))
        }
        let scopeA = UUID(), scopeB = UUID()
        // Matched by scope, not queue position (arrival order is a race).
        async let a = center.elicit(req("a"), scope: scopeA)
        async let b = center.elicit(req("b"), scope: scopeB)
        await waitUntil { center.queue.count == 2 }
        center.cancel(scope: scopeA)
        let resultA = await a
        XCTAssertEqual(resultA, .cancel)
        XCTAssertEqual(center.queue.count, 1)
        XCTAssertEqual(center.queue.first?.scope, scopeB)
        let idB = try XCTUnwrap(center.queue.first?.id)
        center.respond(idB, with: .accept(["choice": "yes"]))
        let resultB = await b
        XCTAssertEqual(resultB, .accept(["choice": "yes"]))
        XCTAssertTrue(center.queue.isEmpty)
    }

    func testStopCancelsTheRunScopeAndLeavesOtherChatsElicitations() async throws {
        let services = try makeServices()
        let seen = ElicitationProbe()
        let engine = ElicitingEngine(center: services.elicitations, probe: seen)
        let store = ChatStore(engine: engine,
                              conversations: [Conversation(title: "A"), Conversation(title: "B")],
                              services: services)
        store.coalesceInterval = .milliseconds(5)
        let a = store.conversations[0], b = store.conversations[1]
        store.select(a.id)
        store.send(text: "a")
        await waitUntil { services.elicitations.queue.count == 1 }
        store.select(b.id)
        store.send(text: "b")
        await waitUntil { services.elicitations.queue.count == 2 }

        // Fresh scope per run, both runs tagged.
        XCTAssertEqual(seen.scopeCount(), 2)
        let scopeA = try XCTUnwrap(seen.scope(for: a.id))
        let scopeB = try XCTUnwrap(seen.scope(for: b.id))
        XCTAssertNotEqual(scopeA, scopeB)

        // Stop A's run: A's waiter resolves .cancel, B's elicitation stays.
        store.select(a.id)
        store.stop()
        await waitUntil { seen.result(for: a.id) != nil }
        XCTAssertEqual(seen.result(for: a.id), .cancel)
        XCTAssertEqual(services.elicitations.queue.count, 1)
        XCTAssertEqual(services.elicitations.queue.first?.scope, scopeB)
        XCTAssertTrue(store.isRunning(b.id))

        // B answers and completes normally.
        let idB = try XCTUnwrap(services.elicitations.queue.first?.id)
        services.elicitations.respond(idB, with: .accept(["choice": "yes"]))
        await waitUntil { !store.isRunning(b.id) }
        XCTAssertEqual(seen.result(for: b.id), .accept(["choice": "yes"]))
        XCTAssertEqual(b.turns[0].outcome, .completed)
    }

    // MARK: Stop (R3-H1 engine half)

    func testStopEndsALiveRunPromptly() async throws {
        let services = try makeServices()
        let provider = ToolThenSilentProvider()
        let engine = engine(services, provider)
        let flag = StopFlag()
        var request = ChatRunRequest(
            conversationID: UUID(), history: [], userMessage: nil, userText: "go",
            mode: .auto, effort: .low, modelID: "test-model", webSearch: false,
            attachments: [], policy: ToolPolicy(), approvals: ApprovalCenter(), setup: nil)
        request.isCancelled = { flag.isSet }
        let stream = engine.run(request)
        let collector = Task { () -> [AgentEvent] in
            var events: [AgentEvent] = []
            for await event in stream { events.append(event) }
            return events
        }
        // Stop once the run is hanging in its second response.
        let start = Date()
        while provider.requestCount < 2, Date().timeIntervalSince(start) < 10 {
            try? await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertEqual(provider.requestCount, 2, "the run never reached its hanging response")
        flag.set()
        let flipAt = Date()
        // A hanging suite helps nobody: unblock the collector (whose
        // `for await` ends on cancel) if the fix ever regresses.
        Task { try? await Task.sleep(for: .seconds(10)); collector.cancel() }
        let events = await collector.value
        XCTAssertLessThan(Date().timeIntervalSince(flipAt), 2.0, "the stream must finish promptly after stop")
        XCTAssertEqual(provider.requestCount, 2, "nothing is sent after stop")
        // The pre-stop tool executed exactly once (its result rode request 2).
        let results = provider.requests[1].messages.flatMap(\.toolResults)
        XCTAssertEqual(results.map(\.callID), ["a"])
        XCTAssertTrue(events.contains { if case .committed = $0 { return true }; return false })
    }
}

/// A run elicits once with its request scope, then finishes: cancelled
/// when the waiter resolves `.cancel`, completed otherwise.
private struct ElicitingEngine: ChatEngine {
    var kind: EngineKind { .scripted }
    let center: ElicitationCenter
    let probe: ElicitationProbe

    func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent> {
        AsyncStream { continuation in
            let task = Task {
                probe.noteRun(request.conversationID, scope: request.elicitationScope)
                let result = await center.elicit(
                    MCPElicitation(serverID: "s", serverName: "S", message: "pick one",
                                   kind: .form(schema: ["type": "object", "properties": [:]])),
                    scope: request.elicitationScope)
                probe.noteResult(request.conversationID, result: result)
                continuation.yield(.finished(result == .cancel ? .cancelled : .completed))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Collects elicitation scopes/results across tasks.
private final class ElicitationProbe: Sendable {
    private let state = Mutex<(scopes: [UUID: UUID?], results: [UUID: MCPElicitationResult])>(([:], [:]))
    func noteRun(_ conversation: UUID, scope: UUID?) { state.withLock { $0.scopes[conversation] = scope } }
    func noteResult(_ conversation: UUID, result: MCPElicitationResult) {
        state.withLock { $0.results[conversation] = result }
    }
    func scopeCount() -> Int { state.withLock { $0.scopes.count } }
    func scope(for conversation: UUID) -> UUID? { state.withLock { $0.scopes[conversation] ?? nil } }
    func result(for conversation: UUID) -> MCPElicitationResult? { state.withLock { $0.results[conversation] } }
}

/// First request: one real tool call. Later requests: a text fragment,
/// then silence forever (a run that never ends on its own).
private final class ToolThenSilentProvider: ModelProvider, Sendable {
    let flavor: ProviderFlavor = .anthropicMessages
    let capabilities = Capabilities()
    private let state = Mutex<(requests: [ProviderRequest], count: Int)>(([], 0))
    var requests: [ProviderRequest] { state.withLock { $0.requests } }
    var requestCount: Int { state.withLock { $0.requests.count } }
    func listModels() async throws -> [ModelInfo] { [] }
    func stream(_ request: ProviderRequest) -> AsyncThrowingStream<ProviderEvent, Error> {
        let n = state.withLock { s in s.requests.append(request); s.count += 1; return s.count }
        return AsyncThrowingStream { continuation in
            if n == 1 {
                continuation.yield(.toolCallStarted(index: 0, id: "a", name: "read_tool_output"))
                continuation.yield(.toolCallDelta(index: 0, json: #"{"id":"nope","offset":0}"#))
                continuation.yield(.blockFinished(index: 0))
                continuation.yield(.completed(ProviderResponse(
                    message: Message(role: .assistant, parts: [
                        .toolCall(ToolCall(id: "a", name: "read_tool_output", arguments: #"{"id":"nope","offset":0}"#)),
                    ]),
                    stopReason: .toolUse, usage: Usage())))
                continuation.finish()
            } else {
                continuation.yield(.textDelta(index: 0, text: "thinking…"))
            }
        }
    }
}

/// A flippable stop flag for engine tests.
private final class StopFlag: Sendable {
    private let box = Mutex(false)
    var isSet: Bool { box.withLock { $0 } }
    func set() { box.withLock { $0 = true } }
}

/// Provider profiles and connector configs on disk: no secrets in JSON.
@MainActor
final class AgentServicesPersistenceTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws { directory = temporaryDirectory() }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

    func testProfileRoundTripsWithoutTheKeyInJSON() throws {
        let file = directory.appendingPathComponent("Providers.json")
        let secrets = InMemorySecretStore()
        let settings = ProviderSettings(fileURL: file, secrets: secrets)
        var profile = ProviderProfile.draft(.openRouterOpenAI)
        profile.defaultModel = "openai/gpt-5"
        profile.endpoint.extraHeaders = ["X-Title": "Praxis"]
        profile.endpoint.capabilities.vision = false
        try settings.save(profile, apiKey: "sk-or-very-secret")
        settings.store([ModelInfo(id: "openai/gpt-5", maxOutputTokens: 1000)], for: profile.id)

        let json = try String(contentsOf: file, encoding: .utf8)
        XCTAssertFalse(json.contains("sk-or-very-secret"))
        XCTAssertFalse(String(describing: try XCTUnwrap(settings.endpoint(for: profile.id))).contains("sk-or-very-secret"))
        XCTAssertEqual(secrets.allKeys, [ProviderSettings.keychainKey(for: profile.id)])

        let reloaded = ProviderSettings(fileURL: file, secrets: secrets)
        XCTAssertEqual(reloaded.profiles, [profile])
        XCTAssertEqual(reloaded.selectedProfileID, profile.id)
        XCTAssertEqual(reloaded.endpoint(for: profile.id)?.apiKey, "sk-or-very-secret")
        XCTAssertEqual(reloaded.models(for: profile.id).map(\.id), ["openai/gpt-5"])
        let selection = try XCTUnwrap(reloaded.selection())
        XCTAssertEqual(selection.model, "openai/gpt-5")
        XCTAssertEqual(selection.maxOutputTokens, 1000)

        try reloaded.save(profile, apiKey: nil)
        XCTAssertEqual(reloaded.apiKey(for: profile.id), "sk-or-very-secret", "nil keeps the key")
        reloaded.delete(profile.id)
        XCTAssertTrue(secrets.allKeys.isEmpty)
        XCTAssertFalse(reloaded.hasProfiles)
        XCTAssertNil(reloaded.selection())
    }

    func testConnectorConfigsPersistWithSecretsInTheStore() async throws {
        let file = directory.appendingPathComponent("Connectors.json")
        let secrets = InMemorySecretStore()
        let library = ConnectorLibrary(fileURL: file, secrets: secrets, transport: ScriptedTransport(replies: []))
        let candidate = MCPInstallCandidate(
            name: "Acme", urlTemplate: "https://acme.mcp.test/mcp",
            headers: [MCPHeaderTemplate(name: "Authorization", value: "Bearer {token}", isSecret: true)],
            inputs: [MCPInstallInput(key: "token", location: .header("Authorization"), isSecret: true)])
        let config = try library.install(candidate, values: ["token": "pat-very-secret"])
        await library.setTrusted(config.id, true)
        await library.setEnabled(config.id, false)
        XCTAssertFalse(try String(contentsOf: file, encoding: .utf8).contains("pat-very-secret"))
        XCTAssertEqual(secrets.allKeys.count, 1)

        let reloaded = ConnectorLibrary(fileURL: file, secrets: secrets, transport: ScriptedTransport(replies: []))
        let server = try XCTUnwrap(reloaded.server(config.id))
        XCTAssertTrue(server.trusted)
        XCTAssertFalse(server.enabled)
        XCTAssertEqual(server.auth, .headers)
        XCTAssertTrue(reloaded.defaultConversationServerIDs.isEmpty, "off servers stay out of new chats")
        XCTAssertEqual(reloaded.client(for: config.id)?.config, server)

        await reloaded.remove(config.id)
        XCTAssertNil(reloaded.client(for: config.id))
        XCTAssertTrue(secrets.allKeys.isEmpty, "header secrets go with the server")
        XCTAssertTrue(ConnectorLibrary(fileURL: file, secrets: secrets).servers.isEmpty)
    }

    func testEraSnapshotSurvivesRelaunch() async throws {
        let file = directory.appendingPathComponent("Connectors.json")
        let transport = ScriptedTransport { request, _ in
            let rpc = request.httpBody.flatMap { try? JSONValue(parsing: $0) } ?? [:]
            let id = rpc["id"] ?? .null
            let result: JSONValue = rpc["method"]?.stringValue == "server/discover"
                ? ["resultType": "complete", "supportedVersions": ["2026-07-28"], "capabilities": ["tools": [:]]]
                : ["tools": []]
            return .json(JSONValue.object(["jsonrpc": "2.0", "id": id, "result": result]).encodedString())
        }
        let library = ConnectorLibrary(fileURL: file, secrets: InMemorySecretStore(), transport: transport)
        let config = try library.install(MCPInstaller.parse(url: "https://acme.mcp.test/mcp"))
        _ = try await library.review(config.id)

        let reloaded = ConnectorLibrary(fileURL: file, secrets: InMemorySecretStore())
        let era = await reloaded.eraCache.era(for: config.url)
        XCTAssertEqual(era, .modern)
    }

    func testVersionOneRecordDecodesWithoutSetup() throws {
        let json = #"{"id":"6B1C1F43-2C53-4C46-9A8C-3B0B58A0B0A1","title":"Old","updatedAt":0,"isPinned":false,"turns":[]}"#
        let record = try JSONDecoder().decode(ConversationRecord.self, from: Data(json.utf8))
        XCTAssertEqual(record.version, 1)
        XCTAssertNil(record.setup)
        XCTAssertNil(record.connectorIDs)
        let written = try JSONEncoder().encode(record)
        XCTAssertEqual(try JSONDecoder().decode(ConversationRecord.self, from: written).version, ConversationRecord.currentVersion)
    }

    func testElicitationsQueueAndCancelWithTheirCall() async {
        let center = ElicitationCenter()
        let ask = MCPElicitation(serverID: "s", serverName: "Acme", message: "Which env?",
                                 kind: .form(schema: ["type": "object", "required": ["env"],
                                                      "properties": ["env": ["type": "string", "enum": ["dev", "prod"]],
                                                                     "force": ["type": "boolean", "default": false]]]))
        // Serialize registration: two concurrent `elicit` calls race to the
        // MainActor, so creation order is NOT queue order (measured: the
        // second task registers first ~20% of the time). Answering
        // `queue[0]` before serializing hangs whenever it flips, because the
        // answered task's waiter is then never resumed.
        let answered = Task { await center.elicit(ask) }
        await waitUntil { center.queue.count == 1 }
        let cancelled = Task { await center.elicit(ask) }
        await waitUntil { center.queue.count == 2 }
        let first = center.queue[0].id
        center.respond(first, with: .accept(["env": "dev"]))
        cancelled.cancel()
        let result = await answered.value
        let cancelledResult = await cancelled.value
        XCTAssertEqual(result, .accept(["env": "dev"]))
        XCTAssertEqual(cancelledResult, .cancel)
        await waitUntil { center.queue.isEmpty }

        guard case .form(let schema) = ask.kind else { return XCTFail() }
        let fields = ElicitationField.fields(in: schema)
        XCTAssertEqual(fields.map(\.key), ["env", "force"])
        XCTAssertEqual(fields[0].kind, .choice(["dev", "prod"]))
        XCTAssertTrue(fields[0].isRequired)
        XCTAssertEqual(fields[1].kind, .boolean)
        XCTAssertEqual(fields[1].defaultValue, false)
    }

    func testElicitationCancelledBeforePresentResolvesCancel() async {
        let center = ElicitationCenter()
        let ask = MCPElicitation(serverID: "s", serverName: "Acme", message: "Which env?",
                                 kind: .form(schema: ["type": "object"]))
        // Cancelled before or while registering: either way the waiter (if
        // any) resolves `.cancel` and nothing stays queued.
        let task = Task { await center.elicit(ask) }
        task.cancel()
        let result = await task.value
        XCTAssertEqual(result, .cancel)
        await waitUntil { center.queue.isEmpty }
        XCTAssertTrue(center.queue.isEmpty)
    }

    func testEngineSelection() {
        XCTAssertEqual(EngineKind.resolve(override: nil, hasProvider: false), .demo)
        XCTAssertEqual(EngineKind.resolve(override: nil, hasProvider: true), .live)
        XCTAssertEqual(EngineKind.resolve(override: .demo, hasProvider: true), .demo)
        XCTAssertEqual(EngineKind.resolve(override: .live, hasProvider: false), .live)
    }

    func testFirstProviderSwitchesTheDemoToLive() throws {
        let settings = ProviderSettings(fileURL: directory.appendingPathComponent("P.json"), secrets: InMemorySecretStore())
        let services = AgentServices(
            settings: settings,
            connectors: ConnectorLibrary(fileURL: directory.appendingPathComponent("C.json"), secrets: InMemorySecretStore()),
            skills: SkillLibrary(importedDirectory: directory.appendingPathComponent("S")),
            elicitations: ElicitationCenter())
        let store = ChatStore(engine: DemoAgentEngine(timeScale: 0), conversations: [Conversation(title: "New chat")],
                              services: services, picksEngineAutomatically: true)
        XCTAssertFalse(store.isLive)
        XCTAssertEqual(store.availableModels, MockData.models)
        store.providersChanged()
        XCTAssertFalse(store.isLive, "still no provider")

        var profile = ProviderProfile.draft(.anthropic)
        profile.defaultModel = "claude-test"
        try settings.save(profile, apiKey: "k")
        store.providersChanged()
        XCTAssertTrue(store.isLive)
        XCTAssertEqual(store.model.id, "claude-test")
        XCTAssertTrue(store.showsWebSearch, "Anthropic hosts web search")
        XCTAssertFalse(store.showsDemoToggles)
        XCTAssertTrue(store.trayConnectors.isEmpty, "no demo connectors when live")
    }
}
