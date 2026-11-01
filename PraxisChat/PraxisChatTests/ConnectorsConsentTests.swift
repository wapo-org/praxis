import XCTest
import Synchronization
import AgentCore
import AgentProviders
import AgentMCP
import AgentRuntime
import AgentTestSupport
@testable import PraxisChat

/// Per-conversation connector toggles after a chat froze its tools, and
/// AI-data consent gating, through `ChatStore` with the live engine.
@MainActor
final class ConnectorsConsentTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!

    override func setUp() async throws {
        directory = temporaryDirectory()
        secrets = InMemorySecretStore()
    }

    override func tearDown() async throws {
        // Queued conversation writes must land before the folder goes.
        for store in stores { await store.settle() }
        stores = []
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: Fixtures

    private var stores: [ChatStore] = []

    private lazy var attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))

    private func makeServices(mcp: ScriptedTransport = ScriptedTransport(replies: []), consented: Bool = true) throws -> AgentServices {
        let settings = ProviderSettings(fileURL: directory.appendingPathComponent("Providers.json"), secrets: secrets)
        var profile = ProviderProfile.draft(.customAnthropic)
        profile.name = "Local test"
        profile.endpoint.baseURL = URL(string: "http://localhost:9/v1")!
        profile.defaultModel = "test-model"
        try settings.save(profile, apiKey: "sk-test")
        let consent = AIDataConsent(fileURL: directory.appendingPathComponent("Consent.json"))
        if consented { consent.grant("localhost:9", providerName: "Local test") }
        return AgentServices(
            settings: settings,
            connectors: ConnectorLibrary(fileURL: directory.appendingPathComponent("Connectors.json"), secrets: secrets, transport: mcp),
            skills: SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills")),
            elicitations: ElicitationCenter(), providerTransport: ScriptedTransport(replies: []),
            attachments: attachments, consent: consent)
    }

    private func engine(_ services: AgentServices, _ provider: ScriptedProvider) -> LiveChatEngine {
        var engine = services.makeEngine()
        engine.makeProvider = { _, _ in provider }
        engine.attachments = attachments
        engine.usesBackgroundTasks = false
        return engine
    }

    private func store(_ services: AgentServices, engine: any ChatEngine, fresh: Bool = true) -> ChatStore {
        let store = ChatStore(engine: engine, conversations: fresh ? [Conversation(title: "New chat")] : nil,
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)
        stores.append(store)
        return store
    }

    private func send(_ store: ChatStore, _ text: String) async {
        store.send(text: text)
        await waitUntil { !store.isRunning }
    }

    /// A modern-era MCP server with one tool.
    private static func fakeMCPServer() -> ScriptedTransport {
        ScriptedTransport { request, _ in
            let rpc = request.httpBody.flatMap { try? JSONValue(parsing: $0) } ?? [:]
            let id = rpc["id"] ?? .null
            func reply(_ result: JSONValue) -> ScriptedTransport.Reply {
                .json(JSONValue.object(["jsonrpc": "2.0", "id": id, "result": result]).encodedString())
            }
            switch rpc["method"]?.stringValue {
            case "server/discover"?:
                return reply(["resultType": "complete", "supportedVersions": ["2026-07-28"], "capabilities": ["tools": [:]]])
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

    private func methods(_ transport: ScriptedTransport) -> [String] {
        transport.requests.compactMap { $0.json?["method"]?.stringValue }
    }

    // MARK: Per-conversation connector toggles

    func testTurningAFrozenConnectorOffRefusesItsToolsInThisChatOnly() async throws {
        let mcp = Self.fakeMCPServer()
        let services = try makeServices(mcp: mcp)
        let acme = try services.connectors.install(MCPInstaller.parse(url: "https://acme.mcp.test/mcp", name: "Acme"))
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.text("Hi"),
            ScriptedProvider.toolCalls([("c1", "mcp__acme__deploy", "{}")]), ScriptedProvider.text("Couldn't deploy"),
        ])
        let store = store(services, engine: engine(services, provider))
        let conv = store.conversations[0]
        XCTAssertFalse(store.connectorsFrozen)

        await send(store, "hello")
        XCTAssertTrue(store.connectorsFrozen)
        XCTAssertEqual(store.trayConnectors.map(\.isOn), [true])

        store.setConnector(acme.id, isOn: false)
        XCTAssertEqual(conv.disabledServerIDs, [acme.id])
        XCTAssertEqual(store.trayConnectors.map(\.isOn), [false])
        XCTAssertNil(store.trayConnectors.first?.lockedReason)
        XCTAssertTrue(try XCTUnwrap(services.connectors.server(acme.id)).enabled, "only this chat changed")
        let frozen = conv.setup

        await send(store, "deploy")
        XCTAssertEqual(conv.setup, frozen, "the tool list stays frozen")
        XCTAssertTrue(provider.requests.last?.tools.contains { $0.name == "mcp__acme__deploy" } ?? false,
                      "its tools are still offered")
        let result = try XCTUnwrap(conv.turns[1].transcript.flatMap(\.toolResults).first)
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.content.compactMap(\.text).joined().contains("for this conversation"))
        XCTAssertFalse(methods(mcp).contains("tools/call"), "nothing reached the server")
        XCTAssertTrue(store.approvals.pendingIDs.isEmpty, "refused, not asked")

        // Persisted with the conversation.
        await store.flushPersistence()
        let saved = try XCTUnwrap(ConversationStore(directory: directory.appendingPathComponent("Conversations")).load())
        XCTAssertEqual(saved.conversations.first { $0.id == conv.id }?.disabledServerIDs, [acme.id])

        // Back on: removed from the set (and saved).
        store.setConnector(acme.id, isOn: true)
        XCTAssertTrue(conv.disabledServerIDs.isEmpty)
        XCTAssertEqual(store.trayConnectors.map(\.isOn), [true])
        await store.flushPersistence()
        let again = try XCTUnwrap(ConversationStore(directory: directory.appendingPathComponent("Conversations")).load())
        XCTAssertEqual(again.conversations.first { $0.id == conv.id }?.disabledServerIDs, [])
    }

    func testEveryRunRequestCarriesTheChatsDisabledServers() async throws {
        let services = try makeServices(mcp: Self.fakeMCPServer())
        let acme = try services.connectors.install(MCPInstaller.parse(url: "https://acme.mcp.test/mcp", name: "Acme"))
        let beta = try services.connectors.install(MCPInstaller.parse(url: "https://beta.mcp.test/mcp", name: "Beta"))
        let setup = await services.runtime.prepare(mcpServerIDs: [acme.id]).setup
        let started = Turn(userText: "hi", isFinished: true, transcript: [Message(role: .user, parts: [.text("hi")])], engine: .live)
        let conv = Conversation(title: "Chat", turns: [started], setup: setup, connectorIDs: [acme.id],
                                disabledServerIDs: [acme.id])
        let recorder = RecordingEngine()
        let store = ChatStore(engine: recorder, conversations: [conv], attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)

        XCTAssertTrue(store.connectorsFrozen)
        XCTAssertEqual(store.trayConnectors.map(\.id), [acme.id])
        XCTAssertEqual(store.newChatOnlyConnectors.map(\.id), [beta.id], "installed after the freeze")
        XCTAssertEqual(store.newChatOnlyConnectors.first?.lockedReason, "Available in new chats")
        store.setConnector(beta.id, isOn: true)
        XCTAssertEqual(conv.disabledServerIDs, [acme.id], "a connector outside the frozen setup can't be toggled here")

        await send(store, "first")
        XCTAssertEqual(recorder.requests.last?.disabledServerIDs, [acme.id])
        store.setConnector(acme.id, isOn: false)
        await send(store, "second")
        XCTAssertEqual(recorder.requests.last?.disabledServerIDs, [acme.id])
        store.setConnector(acme.id, isOn: true)
        await send(store, "third")
        XCTAssertEqual(recorder.requests.last?.disabledServerIDs, [])
        XCTAssertEqual(recorder.requests.count, 3)

        // A connector turned off in Settings shows as such, not toggleable.
        await services.connectors.setEnabled(acme.id, false)
        XCTAssertEqual(store.trayConnectors.first?.lockedReason, "Off in Settings")
    }

    func testDisabledServersRoundTripAndOldFilesDecodeWithNone() throws {
        let record = ConversationRecord(id: UUID(), title: "T", updatedAt: Date(timeIntervalSince1970: 0), isPinned: false,
                                        turns: [], disabledServerIDs: ["b", "a"])
        let data = try JSONEncoder().encode(record)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains(#""disabledServerIDs":["a","b"]"#), "sorted on disk")
        XCTAssertEqual(try JSONDecoder().decode(ConversationRecord.self, from: data).disabledServerIDs, ["a", "b"])

        let none = ConversationRecord(id: UUID(), title: "T", updatedAt: Date(timeIntervalSince1970: 0), isPinned: false, turns: [])
        let plain = try JSONEncoder().encode(none)
        XCTAssertFalse(String(decoding: plain, as: UTF8.self).contains("disabledServerIDs"))
        XCTAssertEqual(try JSONDecoder().decode(ConversationRecord.self, from: plain).disabledServerIDs, [])
    }

    // MARK: AI-data consent

    func testNothingIsSentBeforeConsentAndDecliningRestoresTheDraft() async throws {
        let services = try makeServices(consented: false)
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("Hello"), ScriptedProvider.text("Again")])
        let store = store(services, engine: engine(services, provider))
        let conv = store.conversations[0]
        let file = Attachment(kind: .file, name: "notes.txt", fileData: Data("notes".utf8), mediaType: "text/plain", store: attachments)
        store.draft = "hello there"
        store.attachments = [file]

        store.send(text: store.draft)
        let request = try XCTUnwrap(store.pendingConsent)
        XCTAssertEqual(request.host, "localhost:9")
        XCTAssertEqual(request.providerName, "Local test")
        XCTAssertTrue(conv.turns.isEmpty, "the turn waits for the decision")
        XCTAssertFalse(store.isRunning)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(provider.requests.isEmpty, "no request before consent")

        store.resolveConsent(allow: false)
        XCTAssertNil(store.pendingConsent)
        XCTAssertEqual(store.draft, "hello there")
        XCTAssertEqual(store.attachments, [file])
        XCTAssertTrue(conv.turns.isEmpty)
        XCTAssertFalse(services.consent.isGranted("localhost:9"))
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(provider.requests.isEmpty, "declining sends nothing")

        // Asked again; allowing sends the held message once.
        store.send(text: store.draft)
        XCTAssertNotNil(store.pendingConsent)
        store.resolveConsent(allow: true)
        XCTAssertNil(store.pendingConsent)
        await waitUntil { !store.isRunning }
        XCTAssertEqual(provider.requests.count, 1)
        XCTAssertEqual(conv.turns.count, 1)
        XCTAssertEqual(conv.turns[0].userText, "hello there")
        XCTAssertEqual(conv.turns[0].attachments.map(\.id), [file.id])
        XCTAssertEqual(store.draft, "")
        XCTAssertTrue(store.attachments.isEmpty)
        XCTAssertTrue(services.consent.isGranted("localhost:9"))

        // Remembered: the next send doesn't ask.
        await send(store, "again")
        XCTAssertNil(store.pendingConsent)
        XCTAssertEqual(provider.requests.count, 2)
    }

    func testRetryAfterWithdrawingAsksAgainAndDeclineLeavesTheTurn() async throws {
        let services = try makeServices()
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("One"), ScriptedProvider.text("Two")])
        let store = store(services, engine: engine(services, provider))
        let conv = store.conversations[0]
        await send(store, "hi")
        let before = conv.turns[0]

        services.consent.revoke("localhost:9")
        store.retry(turnID: before.id)
        XCTAssertEqual(store.pendingConsent?.action, .retry(before.id))
        XCTAssertEqual(conv.turns, [before], "nothing rewound yet")
        store.resolveConsent(allow: false)
        XCTAssertEqual(conv.turns, [before])
        XCTAssertEqual(provider.requests.count, 1)

        store.retry(turnID: before.id)
        store.resolveConsent(allow: true)
        await waitUntil { !store.isRunning }
        XCTAssertEqual(provider.requests.count, 2)
        XCTAssertEqual(conv.turns[0].transcript.last?.text, "Two")
    }

    func testDemoEngineNeverAsks() throws {
        let services = try makeServices(consented: false)
        let store = ChatStore(engine: DemoAgentEngine(timeScale: 0), conversations: [Conversation(title: "New chat")],
                              services: services)
        store.send(text: "hello")
        XCTAssertNil(store.pendingConsent, "the demo sends nothing anywhere")
        XCTAssertEqual(store.conversations[0].turns.count, 1)
        store.stop()
    }

    func testEngineRefusesWithoutConsentEvenIfAsked() async throws {
        let services = try makeServices(consented: false)
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("Should never run")])
        let request = ChatRunRequest(conversationID: UUID(), history: [], userMessage: nil, userText: "hi", mode: .auto,
                                     effort: .low, modelID: "test-model", webSearch: false, attachments: [],
                                     policy: ToolPolicy(), approvals: AutoApprove())
        var events: [AgentEvent] = []
        for await event in engine(services, provider).run(request) { events.append(event) }
        guard case .finished(.failed(let reason))? = events.last else { return XCTFail("expected a failed run, got \(events)") }
        XCTAssertTrue(reason.contains("localhost:9"))
        XCTAssertTrue(provider.requests.isEmpty)
        XCTAssertFalse(events.contains { if case .committed = $0 { return true }; return false }, "nothing committed")
    }

    func testConsentPersistsPerHostAndCanBeWithdrawn() {
        let file = directory.appendingPathComponent("Consent.json")
        let consent = AIDataConsent(fileURL: file)
        XCTAssertEqual(AIDataConsent.host(of: URL(string: "https://API.Anthropic.com/v1")!), "api.anthropic.com")
        XCTAssertEqual(AIDataConsent.host(of: URL(string: "http://192.168.1.20:1234/v1")!), "192.168.1.20:1234")
        consent.grant("api.anthropic.com", providerName: "Anthropic")
        XCTAssertTrue(AIDataConsent(fileURL: file).isGranted(baseURL: URL(string: "https://api.anthropic.com/v1/messages")!))
        XCTAssertFalse(AIDataConsent(fileURL: file).isGranted("api.openai.com"))
        consent.revoke("api.anthropic.com")
        XCTAssertTrue(AIDataConsent(fileURL: file).grants.isEmpty)
    }

    func testConsentAnswerReturnsToTheOriginatingChat() async throws {
        let services = try makeServices(consented: false)
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("Hello")])
        let store = store(services, engine: engine(services, provider))
        store.newChat()
        let a = store.conversations[0], b = store.conversations[1]
        store.select(a.id)
        store.send(text: "hello")
        XCTAssertNotNil(store.pendingConsent)
        // The selection moves while the sheet is up; the answer must still
        // land the held send in the chat it started in.
        store.select(b.id)
        store.resolveConsent(allow: true)
        XCTAssertEqual(store.selectedID, a.id)
        XCTAssertEqual(a.turns.count, 1)
        XCTAssertTrue(b.turns.isEmpty)
        await waitUntil { !store.isRunning }
        await store.settle()
    }

    // MARK: Connector library additions

    func testTokenRequirementThenHeadersFixIt() async throws {
        // 401 without OAuth metadata anywhere → "paste a token".
        let transport = ScriptedTransport { request, _ in
            guard request.value(forHTTPHeaderField: "Authorization") == "Bearer pat-1" else {
                return .json(#"{"error":"unauthorized"}"#, status: 401)
            }
            let rpc = request.httpBody.flatMap { try? JSONValue(parsing: $0) } ?? [:]
            let result: JSONValue = rpc["method"]?.stringValue == "server/discover"
                ? ["resultType": "complete", "supportedVersions": ["2026-07-28"], "capabilities": ["tools": [:]]]
                : ["tools": [["name": "search", "inputSchema": ["type": "object"]]]]
            return .json(JSONValue.object(["jsonrpc": "2.0", "id": rpc["id"] ?? .null, "result": result]).encodedString())
        }
        let library = ConnectorLibrary(fileURL: directory.appendingPathComponent("C.json"), secrets: secrets, transport: transport)
        let config = try library.install(MCPInstaller.parse(url: "https://acme.mcp.test/mcp"), enabled: false)
        XCTAssertTrue(library.defaultConversationServerIDs.isEmpty, "provisional installs stay out of new chats")
        do {
            _ = try await library.review(config.id)
            XCTFail("expected a 401")
        } catch {}
        XCTAssertEqual(library.authRequirements[config.id], .tokenHeader)
        XCTAssertEqual(library.state(of: config.id), .needsSignIn(.tokenHeader))

        try await library.setHeaders(config.id, [HeaderEdit(name: "Authorization", value: "Bearer pat-1", isSecret: true),
                                                 HeaderEdit(name: "X-Team", value: "core", isSecret: false)])
        let updated = try XCTUnwrap(library.server(config.id))
        XCTAssertEqual(updated.auth, .headers)
        XCTAssertEqual(updated.headers.map(\.name), ["Authorization", "X-Team"])
        XCTAssertFalse(try String(contentsOf: library.fileURL, encoding: .utf8).contains("pat-1"))
        XCTAssertNil(library.authRequirements[config.id])
        let tools = try await library.review(config.id)
        XCTAssertEqual(tools.map(\.name), ["search"])
        await library.setEnabled(config.id, true)
        XCTAssertEqual(library.state(of: config.id), .connected(toolCount: 1))

        // Keeping the saved secret (nil value), then dropping it.
        try await library.setHeaders(config.id, [HeaderEdit(name: "Authorization", value: nil, isSecret: true)])
        XCTAssertEqual(secrets.allKeys.count, 1)
        try await library.setHeaders(config.id, [])
        XCTAssertTrue(secrets.allKeys.isEmpty, "unreferenced secrets are deleted")
        XCTAssertEqual(library.server(config.id)?.auth, MCPAuthKind.none)
    }

    func testManualOAuthClientAndSwitchingBack() async throws {
        let library = ConnectorLibrary(fileURL: directory.appendingPathComponent("C.json"), secrets: secrets,
                                       transport: ScriptedTransport(replies: []))
        let config = try library.install(MCPInstaller.parse(url: "https://acme.mcp.test/mcp"))
        try await library.setManualOAuth(config.id, clientID: " client-123 ", clientSecret: "shh")
        guard case .manualOAuth(let id, let key?)? = library.server(config.id)?.auth else { return XCTFail() }
        XCTAssertEqual(id, "client-123")
        XCTAssertEqual(try secrets.secret(for: key), "shh")
        await library.useAutomaticOAuth(config.id)
        XCTAssertEqual(library.server(config.id)?.auth, .oauth)
        XCTAssertNil(try secrets.secret(for: key), "the manual client's secret goes with it")
    }

    func testSingleSkillFileImportsUnderItsFrontmatterName() async throws {
        let library = SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills"))
        let file = directory.appendingPathComponent("SKILL.md")
        try """
        ---
        name: release-notes
        description: Writes release notes from a list of merged changes.
        ---
        # Release notes
        Group changes by area.
        """.write(to: file, atomically: true, encoding: .utf8)
        let report = try await library.importSkill(from: file)
        XCTAssertEqual(report.skill.name, "release-notes")
        XCTAssertFalse(report.replacedExisting)
        XCTAssertEqual(library.skills.map(\.name), ["release-notes"])
        XCTAssertEqual(SkillLibrary.frontmatterName(in: Data("---\nname: ../evil\n---".utf8)), nil)
    }
}

/// Records each request and finishes at once (no network, no runtime).
private final class RecordingEngine: ChatEngine {
    private let recorded = Mutex<[ChatRunRequest]>([])
    var requests: [ChatRunRequest] { recorded.withLock { $0 } }
    var kind: EngineKind { .live }

    func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent> {
        recorded.withLock { $0.append(request) }
        return AsyncStream { continuation in
            continuation.yield(.committed([Message(role: .assistant, parts: [.text("ok")])]))
            continuation.yield(.finished(.completed))
            continuation.finish()
        }
    }
}

/// The elicitation form: fields from the schema, validation, and what an
/// accept carries.
final class ElicitationFormTests: XCTestCase {
    private let schema: JSONValue = [
        "type": "object",
        "required": ["email", "count", "env"],
        "properties": [
            "email": ["type": "string", "format": "email", "title": "Email"],
            "site": ["type": "string", "format": "uri"],
            "count": ["type": "integer", "minimum": 1, "maximum": 10, "default": 3],
            "ratio": ["type": "number", "maximum": 1],
            "env": ["type": "string", "oneOf": [["const": "dev", "title": "Development"], ["const": "prod", "title": "Production"]]],
            "notify": ["type": "boolean", "default": true],
            "due": ["type": "string", "format": "date"],
            "nick": ["type": "string", "minLength": 2, "maxLength": 4],
        ],
    ]

    func testFieldsComeFromTheSchema() {
        let form = ElicitationForm(schema: schema)
        let byKey = Dictionary(uniqueKeysWithValues: form.fields.map { ($0.key, $0) })
        XCTAssertEqual(byKey["email"]?.format, .email)
        XCTAssertEqual(byKey["site"]?.format, .uri)
        XCTAssertEqual(byKey["due"]?.format, .date)
        XCTAssertEqual(byKey["count"]?.kind, .integer)
        XCTAssertEqual(byKey["count"]?.minimum, 1)
        XCTAssertEqual(byKey["count"]?.maximum, 10)
        XCTAssertEqual(byKey["env"]?.kind, .choice(["dev", "prod"]))
        XCTAssertEqual(byKey["env"]?.choiceTitles, ["Development", "Production"])
        XCTAssertEqual(form.values["count"], "3", "defaults prefill")
        XCTAssertEqual(form.flags["notify"], true)
    }

    func testValidationAndContent() {
        var form = ElicitationForm(schema: schema)
        XCTAssertFalse(form.isValid)
        XCTAssertEqual(form.problems["email"], "Required")
        XCTAssertEqual(form.problems["env"], "Required")
        XCTAssertNil(form.problems["site"], "empty optional fields are fine")
        XCTAssertNil(form.content(), "nothing is sent while invalid")

        form.values["email"] = "not-an-email"
        form.values["count"] = "11"
        form.values["ratio"] = "abc"
        form.values["env"] = "staging"
        form.values["site"] = "example"
        form.values["due"] = "12/01/2026"
        form.values["nick"] = "x"
        let problems = form.problems
        XCTAssertEqual(problems["email"], "Enter an email address")
        XCTAssertEqual(problems["count"], "Must be at most 10")
        XCTAssertEqual(problems["ratio"], "Enter a number")
        XCTAssertEqual(problems["env"], "Choose one of the options")
        XCTAssertNotNil(problems["site"])
        XCTAssertEqual(problems["due"], "Use the format YYYY-MM-DD")
        XCTAssertEqual(problems["nick"], "At least 2 characters")

        form.values["count"] = "2.5"
        XCTAssertEqual(form.problems["count"], "Enter a whole number")

        form.values["email"] = " ada@example.com "
        form.values["count"] = "4"
        form.values["ratio"] = "0,5"
        form.values["env"] = "prod"
        form.values["site"] = "https://example.com/a"
        form.values["due"] = "2026-12-01"
        form.values["nick"] = "ada"
        form.flags["notify"] = false
        XCTAssertTrue(form.isValid, "\(form.problems)")
        XCTAssertEqual(form.content(), [
            "email": "ada@example.com", "count": 4, "ratio": 0.5, "env": "prod",
            "site": "https://example.com/a", "due": "2026-12-01", "nick": "ada", "notify": false,
        ])

        form.values["site"] = ""
        form.values["ratio"] = "   "
        XCTAssertEqual(form.content()?["site"], nil, "cleared optional fields are left out")
        XCTAssertEqual(form.content()?["ratio"], nil)
    }

    func testDateTimeAndLegacyEnumNames() {
        let form = ElicitationForm(schema: [
            "type": "object", "required": ["when"],
            "properties": [
                "when": ["type": "string", "format": "date-time"],
                "size": ["type": "string", "enum": ["s", "l"], "enumNames": ["Small", "Large"]],
            ],
        ])
        let when = form.fields.first { $0.key == "when" }!
        XCTAssertNil(when.problem(with: "2026-10-23T09:30:00Z"))
        XCTAssertNil(when.problem(with: "2026-10-23T09:30:00.250+02:00"))
        XCTAssertEqual(when.problem(with: "tomorrow"), "Enter a date and time")
        XCTAssertEqual(form.fields.first { $0.key == "size" }?.choiceTitles, ["Small", "Large"])
    }
}
