import XCTest
import Synchronization
import AgentCore
import AgentMCP
import AgentTestSupport
@testable import PraxisChat

/// Per-tool on/off switches: the persisted denylist, "New" badges for
/// tools a server adds later, and what new conversations freeze.
@MainActor
final class ConnectorToolToggleTests: XCTestCase {
    private var directory: URL!

    override func setUp() async throws { directory = temporaryDirectory() }
    override func tearDown() async throws { try? FileManager.default.removeItem(at: directory) }

    /// A tool list a scripted transport can change between listings.
    private final class MutableTools: Sendable {
        private let box: Mutex<[JSONValue]>
        init(_ tools: [JSONValue]) { box = Mutex(tools) }
        func set(_ tools: [JSONValue]) { box.withLock { $0 = tools } }
        func get() -> [JSONValue] { box.withLock { $0 } }
    }

    private func tool(_ name: String) -> JSONValue {
        ["name": .string(name), "description": .string("Does \(name)."), "inputSchema": ["type": "object"]]
    }

    private func mcpTransport(_ tools: MutableTools) -> ScriptedTransport {
        ScriptedTransport { request, _ in
            let rpc = request.httpBody.flatMap { try? JSONValue(parsing: $0) } ?? [:]
            let id = rpc["id"] ?? .null
            let result: JSONValue = rpc["method"]?.stringValue == "server/discover"
                ? ["resultType": "complete", "supportedVersions": ["2026-07-28"], "capabilities": ["tools": [:]]]
                : ["tools": .array(tools.get())]
            return .json(JSONValue.object(["jsonrpc": "2.0", "id": id, "result": result]).encodedString())
        }
    }

    private func makeLibrary(file: String = "C.json", transport: (any HTTPTransport)? = nil) -> ConnectorLibrary {
        ConnectorLibrary(fileURL: directory.appendingPathComponent(file), secrets: InMemorySecretStore(),
                         transport: transport ?? ScriptedTransport(replies: []))
    }

    private func install(_ library: ConnectorLibrary) throws -> String {
        try library.install(ConnectorLibrary.candidate(url: "https://acme.mcp.test/mcp", name: "Acme")).id
    }

    func testToolSwitchesPersistAcrossRelaunch() async throws {
        let file = directory.appendingPathComponent("C.json")
        let library = makeLibrary()
        let id = try install(library)
        XCTAssertTrue(library.isToolEnabled(id, tool: "a"))

        library.setToolEnabled(id, tool: "a", on: false)
        XCTAssertFalse(library.isToolEnabled(id, tool: "a"))
        XCTAssertTrue(library.isToolEnabled(id, tool: "b"), "untouched tools stay on")
        library.setToolEnabled(id, tool: "missing", on: true) // no-op, no crash

        let reloaded = ConnectorLibrary(fileURL: file, secrets: InMemorySecretStore())
        XCTAssertFalse(reloaded.isToolEnabled(id, tool: "a"))
        XCTAssertEqual(reloaded.disabledTools, [id: ["a"]])

        reloaded.setToolEnabled(id, tool: "a", on: true)
        XCTAssertNil(ConnectorLibrary(fileURL: file, secrets: InMemorySecretStore()).disabledTools[id],
                     "the last re-enable drops the entry")
    }

    func testUnknownServerSwitchIsIgnored() throws {
        let library = makeLibrary()
        library.setToolEnabled("nope", tool: "a", on: false)
        library.setAllToolsEnabled("nope", on: false)
        XCTAssertTrue(library.disabledTools.isEmpty)
    }

    func testNewBadgeFlagsLaterToolsOnce() async throws {
        let file = directory.appendingPathComponent("C.json")
        let listed = MutableTools([tool("a")])
        let library = makeLibrary(transport: mcpTransport(listed))
        let id = try install(library)

        _ = try await library.review(id)
        XCTAssertFalse(library.isToolNew(id, tool: "a"), "the first listing is the baseline")

        listed.set([tool("a"), tool("b")])
        _ = try await library.review(id)
        XCTAssertTrue(library.isToolNew(id, tool: "b"))
        XCTAssertFalse(library.isToolNew(id, tool: "a"))

        // Seen state survives a relaunch (badges need a listing to
        // render against, so the reloaded check reads the seen set).
        XCTAssertEqual(ConnectorLibrary(fileURL: file, secrets: InMemorySecretStore()).seenTools[id], ["a"])
        library.markToolsSeen(id)
        XCTAssertFalse(library.isToolNew(id, tool: "b"))
        XCTAssertEqual(ConnectorLibrary(fileURL: file, secrets: InMemorySecretStore()).seenTools[id], ["a", "b"])

        listed.set([tool("a"), tool("b"), tool("c")])
        _ = try await library.review(id)
        XCTAssertTrue(library.isToolNew(id, tool: "c"))
    }

    func testDisableAllThenNewToolStartsOn() async throws {
        let listed = MutableTools([tool("a"), tool("b")])
        let library = makeLibrary(transport: mcpTransport(listed))
        let id = try install(library)
        _ = try await library.review(id)

        library.setAllToolsEnabled(id, on: false)
        XCTAssertFalse(library.isToolEnabled(id, tool: "a"))
        XCTAssertFalse(library.isToolEnabled(id, tool: "b"))

        listed.set([tool("a"), tool("b"), tool("c")])
        _ = try await library.review(id)
        XCTAssertTrue(library.isToolNew(id, tool: "c"))
        XCTAssertTrue(library.isToolEnabled(id, tool: "c"), "a denylist lets new tools start on")
        XCTAssertFalse(library.isToolEnabled(id, tool: "a"))

        library.setAllToolsEnabled(id, on: true)
        XCTAssertTrue(library.isToolEnabled(id, tool: "a"))
        XCTAssertNil(library.disabledTools[id])
    }

    func testRemoveDropsToolState() async throws {
        let listed = MutableTools([tool("a")])
        let library = makeLibrary(transport: mcpTransport(listed))
        let id = try install(library)
        _ = try await library.review(id)
        library.setToolEnabled(id, tool: "a", on: false)

        await library.remove(id)
        XCTAssertNil(library.disabledTools[id])
        XCTAssertNil(library.seenTools[id])
    }

    /// A disabled tool never reaches a new conversation's frozen setup
    /// or the provider request; its sibling does.
    func testDisabledToolIsLeftOutOfNewConversations() async throws {
        let secrets = InMemorySecretStore()
        let settings = ProviderSettings(fileURL: directory.appendingPathComponent("Providers.json"), secrets: secrets)
        var profile = ProviderProfile.draft(.customAnthropic)
        profile.endpoint.baseURL = URL(string: "http://localhost:9/v1")!
        profile.defaultModel = "test-model"
        try settings.save(profile, apiKey: "sk-test")

        let listed = MutableTools([tool("a"), tool("b")])
        let connectors = makeLibrary(transport: mcpTransport(listed))
        let skills = SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills"))
        let consent = AIDataConsent(fileURL: nil)
        consent.grant("localhost:9", providerName: "Test")
        let attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))
        let services = AgentServices(settings: settings, connectors: connectors, skills: skills,
                                     elicitations: ElicitationCenter(),
                                     providerTransport: ScriptedTransport(replies: []),
                                     attachments: attachments, consent: consent)
        let id = try install(connectors)
        _ = try await connectors.review(id)
        connectors.setToolEnabled(id, tool: "b", on: false)

        let provider = ScriptedProvider(steps: [ScriptedProvider.text("Hi")])
        let engine = LiveChatEngine(runtime: services.runtime,
                                    resolve: { model in await settings.selection(model: model) },
                                    makeProvider: { _, _ in provider }, attachments: attachments,
                                    usesBackgroundTasks: false)
        let store = ChatStore(engine: engine, conversations: [Conversation(title: "New chat")],
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)
        store.send(text: "hello")
        await waitUntil { !store.isRunning }

        let conv = store.conversations[0]
        let setup = try XCTUnwrap(conv.setup, "frozen at the first send")
        XCTAssertTrue(setup.toolSpecs.contains { $0.name == "mcp__acme__a" })
        XCTAssertFalse(setup.toolSpecs.contains { $0.name == "mcp__acme__b" })
        let request = try XCTUnwrap(provider.requests.first)
        XCTAssertTrue(request.tools.contains { $0.name == "mcp__acme__a" })
        XCTAssertFalse(request.tools.contains { $0.name == "mcp__acme__b" })
        await store.settle()
    }
}
