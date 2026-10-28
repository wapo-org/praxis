import XCTest
import UIKit
import AgentCore
import AgentProviders
import AgentSkills
import AgentRuntime
import AgentMCP
import AgentTestSupport
@testable import PraxisChat

/// The tools sibling of the image-input bug: an OpenRouter model whose tool
/// support the app doesn't know gets a request with tools and the run dies
/// with "HTTP 404: No endpoints found that support tool use". Now unknown
/// support is tried with tools, and a rejection is learned, persisted and
/// answered by resending once without tools.
@MainActor
final class ToolSupportFallbackAppTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!

    static let plain = "some/plain-model"
    static let openRouter404 = #"{"error":{"message":"No endpoints found that support tool use","code":404}}"#

    override func setUp() async throws {
        directory = temporaryDirectory()
        secrets = InMemorySecretStore()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private lazy var attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))
    private var providersFile: URL { directory.appendingPathComponent("Providers.json") }

    private func settings(transport: any HTTPTransport = ScriptedTransport(replies: [])) -> ProviderSettings {
        ProviderSettings(fileURL: providersFile, secrets: secrets, transport: transport)
    }

    private func openRouterProfile(model: String = plain) -> ProviderProfile {
        var profile = ProviderProfile.draft(.openRouterOpenAI)
        profile.defaultModel = model
        return profile
    }

    private func openAISSE(_ text: String) -> ScriptedTransport.Reply {
        let chunk = JSONValue.object(["choices": [["index": 0, "delta": ["content": .string(text)]]]]).encodedString()
        let done = JSONValue.object(["choices": [["index": 0, "delta": [:], "finish_reason": "stop"]]]).encodedString()
        return .sse("data: \(chunk)\n\ndata: \(done)\n\ndata: [DONE]\n\n")
    }

    private func body(_ request: ScriptedTransport.RecordedRequest?) -> String {
        request?.body.map { String(decoding: $0, as: UTF8.self) } ?? ""
    }

    private func services(_ settings: ProviderSettings, consent: AIDataConsent) -> AgentServices {
        AgentServices(settings: settings,
                      connectors: ConnectorLibrary(fileURL: directory.appendingPathComponent("Connectors.json"),
                                                   secrets: secrets, transport: ScriptedTransport(replies: [])),
                      skills: SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills")),
                      elicitations: ElicitationCenter(), providerTransport: ScriptedTransport(replies: []),
                      attachments: attachments, consent: consent)
    }

    // MARK: The reported failure

    func testUnknownModelLearnsFromTheRejectionAndRetriesWithoutTools() async throws {
        let settings = settings()
        let profile = openRouterProfile()
        try settings.save(profile, apiKey: "sk-or")
        XCTAssertEqual(settings.toolSupport(profileID: profile.id, model: Self.plain), .unknown, "no list cached")

        let consent = AIDataConsent(fileURL: nil)
        consent.grant(AIDataConsent.host(of: profile.endpoint.baseURL), providerName: "OpenRouter")
        let services = services(settings, consent: consent)
        let chat = ScriptedTransport(replies: [
            .json(Self.openRouter404, status: 404),
            openAISSE("Paris is lovely in spring."),
            openAISSE("Pack light."),
        ])
        var engine = LiveChatEngine(runtime: services.runtime, resolve: { model in await settings.selection(model: model) },
                                    makeProvider: { endpoint, _ in OpenAIChatProvider(endpoint: endpoint, transport: chat) },
                                    attachments: attachments, usesBackgroundTasks: false)
        engine.onToolsRejected = { selection in
            await settings.markToolsUnsupported(profileID: selection.profileID, model: selection.model)
        }
        let store = ChatStore(engine: engine, conversations: [Conversation(title: "New chat")],
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)

        XCTAssertNil(store.toolSupportHint, "unknown support is tried, not warned about")
        store.send(text: "Why is Paris nice?")
        await waitUntil { !store.isRunning }

        // One rejected request with tools, then the same run as plain chat.
        XCTAssertEqual(chat.requests.count, 2)
        XCTAssertNotNil(chat.requests.first?.json?["tools"], "the first request sent tools")
        XCTAssertNil(chat.requests.last?.json?["tools"], "the resend declares no tools")
        XCTAssertTrue(body(chat.requests.last).contains(ToolSupport.toolsOffNote))

        let conv = store.conversations[0]
        let turn = conv.turns[0]
        XCTAssertEqual(turn.outcome, .completed, "the user isn't left with the 404")
        XCTAssertTrue(turn.blocks.contains { if case .markdown(_, "Paris is lovely in spring.", _) = $0 { return true }; return false })
        let note = try XCTUnwrap(turn.activities.flatMap(\.steps).first { $0.toolCallID == "tools-not-supported" },
                                 "a step says the model answered without tools")
        XCTAssertEqual(note.title, "\(Self.plain) can't use tools — answering without them")
        XCTAssertTrue(note.finalSummary.contains("Switch to a tool-capable model"), note.finalSummary)
        XCTAssertTrue(conv.setup?.toolSpecs.isEmpty == false,
                      "the frozen setup keeps its tools for tool-capable models")

        // Learned and persisted: the next send goes without tools from the start.
        XCTAssertEqual(settings.toolSupport(profileID: profile.id, model: Self.plain), .unsupported)
        XCTAssertEqual(self.settings().toolSupport(profileID: profile.id, model: Self.plain), .unsupported,
                       "survives a relaunch")
        XCTAssertEqual(store.toolSupportHint, .noTools, "the composer now says the model can't use tools")
        store.send(text: "What should I pack?")
        await waitUntil { !store.isRunning }
        XCTAssertEqual(chat.requests.count, 3, "no second rejection")
        XCTAssertNil(chat.requests.last?.json?["tools"])
        XCTAssertEqual(store.conversations[0].turns[1].outcome, .completed)
        await store.settle()
    }

    // MARK: Known no-tools models

    func testKnownNoToolsModelSendsNoToolsFromTheStart() async throws {
        let settings = settings()
        let profile = openRouterProfile()
        try settings.save(profile, apiKey: "sk-or")
        settings.store([ModelInfo(id: Self.plain, displayName: "Plain", supportsTools: false)], for: profile.id)
        XCTAssertEqual(settings.toolSupport(profileID: profile.id, model: Self.plain), .unsupported)
        XCTAssertEqual(settings.selection()?.endpoint.capabilities.tools, false, "plain requests from the start")

        let consent = AIDataConsent(fileURL: nil)
        consent.grant(AIDataConsent.host(of: profile.endpoint.baseURL), providerName: "OpenRouter")
        let services = services(settings, consent: consent)
        let chat = ScriptedTransport(replies: [openAISSE("Hi there.")])
        let engine = LiveChatEngine(runtime: services.runtime, resolve: { model in await settings.selection(model: model) },
                                    makeProvider: { endpoint, _ in OpenAIChatProvider(endpoint: endpoint, transport: chat) },
                                    attachments: attachments, usesBackgroundTasks: false)
        let store = ChatStore(engine: engine, conversations: [Conversation(title: "New chat")],
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)

        XCTAssertEqual(store.toolSupportHint, .noTools, "warned from the start")
        store.send(text: "hi")
        await waitUntil { !store.isRunning }

        XCTAssertEqual(chat.requests.count, 1, "nothing to reject")
        XCTAssertNil(chat.requests.first?.json?["tools"])
        XCTAssertTrue(body(chat.requests.first).contains(ToolSupport.toolsOffNote))
        let turn = store.conversations[0].turns[0]
        XCTAssertEqual(turn.outcome, .completed)
        XCTAssertTrue(turn.activities.flatMap(\.steps).allSatisfy { $0.toolCallID != "tools-not-supported" },
                      "no fallback step: nothing was retried")
        await store.settle()
    }

    // MARK: Lapsing

    func testALearnedRejectionClearsWhenTheListGainsToolsAndLapses() throws {
        let settings = settings()
        let profile = openRouterProfile()
        try settings.save(profile, apiKey: "sk-or")
        settings.store([ModelInfo(id: Self.plain, supportsTools: false)], for: profile.id)
        let now = Date()
        settings.markToolsUnsupported(profileID: profile.id, model: Self.plain, now: now)
        XCTAssertEqual(settings.toolSupport(profileID: profile.id, model: Self.plain, now: now), .unsupported)
        XCTAssertEqual(settings.toolSupport(profileID: profile.id, model: Self.plain,
                                             now: now + ProviderSettings.toolRejectionLifetime + 1), .unsupported,
                       "the list still says no tools")

        settings.store([ModelInfo(id: Self.plain, supportsTools: true)], for: profile.id)
        XCTAssertEqual(settings.toolSupport(profileID: profile.id, model: Self.plain), .supported,
                       "the model gained tool support")

        // A rejection that contradicts a tool-capable list stays until it lapses.
        settings.markToolsUnsupported(profileID: profile.id, model: Self.plain, now: now)
        settings.store([ModelInfo(id: Self.plain, supportsTools: true)], for: profile.id)
        XCTAssertEqual(settings.toolSupport(profileID: profile.id, model: Self.plain, now: now), .unsupported)
        XCTAssertEqual(settings.toolSupport(profileID: profile.id, model: Self.plain,
                                             now: now + ProviderSettings.toolRejectionLifetime + 1), .supported)
    }
}
