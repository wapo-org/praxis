import XCTest
import UIKit
import AgentCore
import AgentProviders
import AgentMCP
import AgentRuntime
import AgentTestSupport
@testable import PraxisChat

/// The consent backstop in `LiveChatEngine` (R3-M1, R3-L1): no keyed
/// request goes out before `mayShare` allows it, and a mid-run revoke
/// stops the run before its next provider request.
@MainActor
final class ConsentRecheckAppTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!

    static let model = "some/open-model"
    static let tools404 = #"{"error":{"message":"No endpoints found that support tool use","code":404}}"#

    override func setUp() async throws {
        directory = temporaryDirectory()
        secrets = InMemorySecretStore()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private lazy var attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))

    private func settings(listTransport: ScriptedTransport) -> ProviderSettings {
        ProviderSettings(fileURL: directory.appendingPathComponent("Providers.json"), secrets: secrets,
                         transport: listTransport)
    }

    private func openRouterProfile() -> ProviderProfile {
        var profile = ProviderProfile.draft(.openRouterOpenAI)
        profile.defaultModel = Self.model
        return profile
    }

    private func services(_ settings: ProviderSettings, consent: AIDataConsent) -> AgentServices {
        AgentServices(settings: settings,
                      connectors: ConnectorLibrary(fileURL: directory.appendingPathComponent("Connectors.json"),
                                                   secrets: secrets, transport: ScriptedTransport(replies: [])),
                      skills: SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills")),
                      elicitations: ElicitationCenter(), providerTransport: ScriptedTransport(replies: []),
                      attachments: attachments, consent: consent)
    }

    private func openAISSE(_ text: String) -> ScriptedTransport.Reply {
        let chunk = JSONValue.object(["choices": [["index": 0, "delta": ["content": .string(text)]]]]).encodedString()
        let done = JSONValue.object(["choices": [["index": 0, "delta": [:], "finish_reason": "stop"]]]).encodedString()
        return .sse("data: \(chunk)\n\ndata: \(done)\n\ndata: [DONE]\n\n")
    }

    private func store(engine: LiveChatEngine, services: AgentServices) -> ChatStore {
        let store = ChatStore(engine: engine, conversations: [Conversation(title: "New chat")],
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)
        return store
    }

    // MARK: R3-M1 — revoke mid-run

    func testRevokingConsentMidRunStopsBeforeTheNextProviderRequest() async throws {
        let settings = settings(listTransport: ScriptedTransport(replies: []))
        let profile = openRouterProfile()
        try settings.save(profile, apiKey: "sk-or")
        let host = AIDataConsent.host(of: profile.endpoint.baseURL)
        let consent = AIDataConsent(fileURL: nil)
        consent.grant(host, providerName: "OpenRouter")
        let services = services(settings, consent: consent)
        let chat = ScriptedTransport(replies: [.json(Self.tools404, status: 404), openAISSE("Paris is lovely.")])
        var engine = LiveChatEngine(runtime: services.runtime, resolve: { model in await settings.selection(model: model) },
                                    makeProvider: { endpoint, _ in OpenAIChatProvider(endpoint: endpoint, transport: chat) },
                                    attachments: attachments, usesBackgroundTasks: false)
        // Revoked once the first provider request has gone out: everything
        // after it must stop.
        engine.mayShare = { _ in chat.requests.isEmpty }
        engine.onToolsRejected = { selection in
            await settings.markToolsUnsupported(profileID: selection.profileID, model: selection.model)
        }
        let store = store(engine: engine, services: services)

        store.send(text: "Why is Paris nice?")
        await waitUntil { !store.isRunning }

        XCTAssertEqual(chat.requests.count, 1, "the tools-off retry never goes out after the revoke")
        XCTAssertEqual(store.conversations[0].turns[0].outcome, .failed(LiveChatEngine.noConsentReason(host: host)))
        await store.settle()
    }

    // MARK: R3-L1 — no keyed requests before the backstop

    func testImagePreCheckDoesNotRunBeforeTheConsentBackstop() async throws {
        let lists = ScriptedTransport(replies: [])
        let settings = settings(listTransport: lists)
        let profile = openRouterProfile()
        try settings.save(profile, apiKey: "sk-or")
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: Self.model), .unknown,
                       "unknown support is what triggers the pre-check")
        let host = AIDataConsent.host(of: profile.endpoint.baseURL)
        let consent = AIDataConsent(fileURL: nil)
        consent.grant(host, providerName: "OpenRouter") // the store's send proceeds...
        let services = services(settings, consent: consent)
        let chat = ScriptedTransport(replies: [])
        var engine = LiveChatEngine(runtime: services.runtime, resolve: { model in await settings.selection(model: model) },
                                    makeProvider: { endpoint, _ in OpenAIChatProvider(endpoint: endpoint, transport: chat) },
                                    attachments: attachments, usesBackgroundTasks: false)
        engine.mayShare = { _ in false } // ...but the engine's backstop says no
        engine.prepareForImages = { model in await settings.refreshForImages(model: model) }
        let store = store(engine: engine, services: services)
        let png = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).pngData { ctx in
            UIColor.red.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        store.attachments = [Attachment(kind: .photo, name: "Photo", imageData: png, store: attachments)]

        store.send(text: "what is this?")
        await waitUntil { !store.isRunning }

        XCTAssertTrue(lists.requests.isEmpty, "the model-list refresh must not run before consent")
        XCTAssertTrue(chat.requests.isEmpty, "nothing is sent without consent")
        XCTAssertEqual(store.conversations[0].turns[0].outcome, .failed(LiveChatEngine.noConsentReason(host: host)))
        await store.settle()
    }
}
