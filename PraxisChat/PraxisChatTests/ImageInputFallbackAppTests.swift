import XCTest
import UIKit
import AgentCore
import AgentProviders
import AgentSkills
import AgentRuntime
import AgentMCP
import AgentTestSupport
@testable import PraxisChat

/// The device bug: an OpenRouter model whose image support the app didn't
/// know ("Inception: Mercury 3") got the photo and the run died with
/// "HTTP 404: No endpoints found that support image input". Now unknown
/// support is settled from a fresh model list before sending, and a
/// rejection is learned, persisted and answered by resending once with
/// placeholders.
@MainActor
final class ImageInputFallbackAppTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!

    static let mercury = "inception/mercury-3"
    static let openRouter404 = #"{"error":{"message":"No endpoints found that support image input","code":404}}"#
    static let modelList = """
    {"data":[
      {"id":"inception/mercury-3","name":"Inception: Mercury 3","context_length":1000000,
       "architecture":{"modality":"text->text","input_modalities":["text"],"output_modalities":["text"]}},
      {"id":"openai/gpt-5-mini","name":"OpenAI: GPT-5 Mini",
       "architecture":{"modality":"text+image->text","input_modalities":["text","image"],"output_modalities":["text"]}}
    ]}
    """

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

    private func openRouterProfile(model: String = mercury) -> ProviderProfile {
        var profile = ProviderProfile.draft(.openRouterOpenAI)
        profile.defaultModel = model
        return profile
    }

    private func png(_ color: UIColor = .red) -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30)).pngData { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
        }
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

    func testUnknownModelLearnsFromTheRejectionAndResendsWithPlaceholders() async throws {
        let settings = settings()
        let profile = openRouterProfile()
        try settings.save(profile, apiKey: "sk-or")
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: Self.mercury), .unknown, "no list cached")

        let consent = AIDataConsent(fileURL: nil)
        consent.grant(AIDataConsent.host(of: profile.endpoint.baseURL), providerName: "OpenRouter")
        let services = services(settings, consent: consent)
        let chat = ScriptedTransport(replies: [
            .json(Self.openRouter404, status: 404),
            openAISSE("I can't see the screenshot itself."),
            openAISSE("Still can't see it."),
        ])
        var engine = LiveChatEngine(runtime: services.runtime, resolve: { model in await settings.selection(model: model) },
                                    makeProvider: { endpoint, _ in OpenAIChatProvider(endpoint: endpoint, transport: chat) },
                                    attachments: attachments, usesBackgroundTasks: false)
        engine.imageReader = { await AgentServices.imageReaderAccess(settings: settings, consent: consent) }
        engine.onImagesRejected = { selection in
            await settings.markImagesUnsupported(profileID: selection.profileID, model: selection.model)
        }
        let store = ChatStore(engine: engine, conversations: [Conversation(title: "New chat")],
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)

        let photo = png()
        store.attachments = [Attachment(kind: .photo, name: "IMG_7712", imageData: photo, store: attachments)]
        XCTAssertNil(store.imageInputHint, "unknown support is tried, not warned about")
        store.send(text: "What's on the screenshot?")
        await waitUntil { !store.isRunning }

        // One rejected request with the image, then the same run as text.
        XCTAssertEqual(chat.requests.count, 2)
        XCTAssertTrue(body(chat.requests.first).contains("image_url"))
        let resent = body(chat.requests.last)
        XCTAssertFalse(resent.contains("image_url"), "the resend has no image parts")
        XCTAssertTrue(resent.contains("[Image \(ImageReference.id(for: photo))"))

        let conv = store.conversations[0]
        let turn = conv.turns[0]
        XCTAssertEqual(turn.outcome, .completed, "the user isn't left with the 404")
        XCTAssertTrue(turn.blocks.contains { if case .markdown(_, "I can't see the screenshot itself.", _) = $0 { return true }; return false })
        let note = try XCTUnwrap(turn.activities.flatMap(\.steps).first { $0.toolCallID == "image-input-text-only" },
                                 "a step says the image went as text")
        XCTAssertEqual(note.title, "\(Self.mercury) can't see images")
        XCTAssertTrue(note.finalSummary.contains("Settings → Image reading model"), note.finalSummary)
        XCTAssertTrue(conv.setup?.toolSpecs.contains { $0.name == ImageReference.lookToolName } == true,
                      "the first turn gained look_at_image while nothing had been answered")
        XCTAssertEqual(turn.transcript.filter { $0.role == .user }.count, 1, "history isn't rewritten or duplicated")
        XCTAssertTrue(turn.transcript[0].parts.contains { if case .image = $0 { return true }; return false },
                      "the transcript keeps the image; placeholders are applied per request")

        // Learned and persisted: the next send goes as text from the start.
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: Self.mercury), .unsupported)
        XCTAssertEqual(self.settings().imageSupport(profileID: profile.id, model: Self.mercury), .unsupported,
                       "survives a relaunch")
        store.attachments = [Attachment(kind: .photo, name: "IMG_7713", imageData: png(.blue), store: attachments)]
        XCTAssertEqual(store.imageInputHint, .noReader, "the composer now says the model can't see images")
        store.send(text: "And this one?")
        await waitUntil { !store.isRunning }
        XCTAssertEqual(chat.requests.count, 3, "no second rejection")
        XCTAssertFalse(body(chat.requests.last).contains("image_url"))
        XCTAssertEqual(store.conversations[0].turns[1].outcome, .completed)
        await store.settle()
    }

    // MARK: Settling unknown support up front

    /// What the device had: a list cached before lists carried image
    /// support (no `supportsImages`, no read time). It counts as stale and
    /// is read again, and the fresh list settles Mercury as text-only.
    func testAListFromBeforeTheImageFlagIsStaleAndTheRefreshSettlesIt() async throws {
        let first = settings()
        let profile = openRouterProfile()
        try first.save(profile, apiKey: "sk-or")
        first.store([ModelInfo(id: Self.mercury, displayName: "Inception: Mercury 3")], for: profile.id)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: providersFile)) as? [String: Any])
        json["modelsFetchedAt"] = nil
        try JSONSerialization.data(withJSONObject: json).write(to: providersFile)

        let list = ScriptedTransport(replies: [.json(Self.modelList)])
        let settings = settings(transport: list)
        XCTAssertTrue(settings.modelListIsStale(profile.id))
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: Self.mercury), .unknown)
        XCTAssertEqual(settings.selection()?.endpoint.capabilities.vision, true, "unknown is tried")

        await settings.refreshForImages(model: nil)
        XCTAssertEqual(list.requests.count, 1)
        XCTAssertEqual(list.requests.first?.url?.path(), "/api/v1/models")
        XCTAssertFalse(settings.modelListIsStale(profile.id))
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: Self.mercury), .unsupported)
        XCTAssertEqual(settings.selection()?.endpoint.capabilities.vision, false, "images go as placeholders")
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: "openai/gpt-5-mini"), .supported)

        await settings.refreshForImages(model: nil)
        XCTAssertEqual(list.requests.count, 1, "nothing to settle: no second request")
    }

    func testALearnedRejectionClearsWhenTheListGainsImagesAndLapses() throws {
        let settings = settings()
        let profile = openRouterProfile()
        try settings.save(profile, apiKey: "sk-or")
        settings.store([ModelInfo(id: Self.mercury, supportsImages: false)], for: profile.id)
        let now = Date()
        settings.markImagesUnsupported(profileID: profile.id, model: Self.mercury, now: now)
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: Self.mercury, now: now), .unsupported)
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: Self.mercury,
                                             now: now + ProviderSettings.imageRejectionLifetime + 1), .unsupported,
                       "the list still says text-only")

        settings.store([ModelInfo(id: Self.mercury, supportsImages: true)], for: profile.id)
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: Self.mercury), .supported,
                       "the model gained image input")

        // A rejection that contradicts an image-capable list stays until it lapses.
        settings.markImagesUnsupported(profileID: profile.id, model: Self.mercury, now: now)
        settings.store([ModelInfo(id: Self.mercury, supportsImages: true)], for: profile.id)
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: Self.mercury, now: now), .unsupported)
        XCTAssertEqual(settings.imageSupport(profileID: profile.id, model: Self.mercury,
                                             now: now + ProviderSettings.imageRejectionLifetime + 1), .supported)
    }

    // MARK: A text-only image reader

    func testATextOnlyReaderIsReportedClearly() async throws {
        let settings = settings()
        let chat = openRouterProfile()
        try settings.save(chat, apiKey: "sk-or")
        let listed = try await OpenAIChatProvider(endpoint: ProviderPreset.openRouterOpenAI.endpoint(apiKey: "sk")!,
                                                  transport: ScriptedTransport(replies: [.json(Self.modelList)])).listModels()
        settings.store(listed, for: chat.id)
        let consent = AIDataConsent(fileURL: nil)
        consent.grant(AIDataConsent.host(of: chat.endpoint.baseURL), providerName: "OpenRouter")
        let services = services(settings, consent: consent)
        let store = ChatStore(engine: LiveChatEngine(runtime: services.runtime, resolve: { _ in nil },
                                                     attachments: attachments, usesBackgroundTasks: false),
                              conversations: [Conversation(title: "New chat")],
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        store.attachments = [Attachment(kind: .photo, name: "shot", imageData: png(), store: attachments)]

        // Listed as text-only: caught before anything is asked.
        settings.setImageReader(ImageReaderChoice(profileID: chat.id, model: Self.mercury))
        guard case .unavailable(let message) = AgentServices.imageReaderAccess(settings: settings, consent: consent) else {
            return XCTFail("a text-only reader isn't used")
        }
        XCTAssertTrue(message.contains("can't take images itself"), message)
        XCTAssertTrue(message.contains("Settings → Image reading model"), message)
        XCTAssertEqual(store.imageInputHint, .readerCantSeeImages("OpenRouter · Inception: Mercury 3"))

        // Unknown until its provider turns an image down: then remembered.
        settings.setImageReader(ImageReaderChoice(profileID: chat.id, model: "some/unlisted-model"))
        guard case .ready(let reader) = AgentServices.imageReaderAccess(settings: settings, consent: consent) else {
            return XCTFail("unknown is tried")
        }
        await reader.onImagesRejected?()
        guard case .unavailable = AgentServices.imageReaderAccess(settings: settings, consent: consent) else {
            return XCTFail("the rejection is remembered")
        }
        XCTAssertEqual(store.imageInputHint, .readerCantSeeImages("OpenRouter · some/unlisted-model"))
        await store.settle()
    }
}
