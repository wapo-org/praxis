import XCTest
import UIKit
import AgentCore
import AgentProviders
import AgentSkills
import AgentRuntime
import AgentMCP
import AgentTestSupport
@testable import PraxisChat

/// Settings → Image reading model, the live engine's `look_at_image`
/// wiring, the composer hint, and the Skills library's registry and
/// agent-skill editing.
@MainActor
final class ImageReaderAndSkillsAppTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!

    override func setUp() async throws {
        directory = temporaryDirectory()
        secrets = InMemorySecretStore()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private lazy var attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))

    private func settings() -> ProviderSettings {
        ProviderSettings(fileURL: directory.appendingPathComponent("Providers.json"), secrets: secrets)
    }

    private func png() -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30)).pngData { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
        }
    }

    private func openAISSE(_ text: String) -> ScriptedTransport.Reply {
        let chunk = JSONValue.object(["choices": [["index": 0, "delta": ["content": .string(text)]]]]).encodedString()
        let done = JSONValue.object(["choices": [["index": 0, "delta": [:], "finish_reason": "stop"]]]).encodedString()
        return .sse("data: \(chunk)\n\ndata: \(done)\n\ndata: [DONE]\n\n")
    }

    // MARK: Settings

    func testSelectionUsesEachModelsImageSupport() throws {
        let settings = settings()
        var profile = ProviderProfile.draft(.openRouterOpenAI)
        profile.defaultModel = "text-only"
        try settings.save(profile, apiKey: "sk-or")
        settings.store([ModelInfo(id: "vision", supportsImages: true), ModelInfo(id: "text-only", supportsImages: false),
                        ModelInfo(id: "unknown")], for: profile.id)

        XCTAssertEqual(settings.selection()?.endpoint.capabilities.vision, false)
        XCTAssertFalse(settings.selectedModelSupportsImages)
        XCTAssertEqual(settings.selection(model: "vision")?.endpoint.capabilities.vision, true)
        XCTAssertEqual(settings.selection(model: "unknown")?.endpoint.capabilities.vision, true, "the profile flag decides")

        profile.endpoint.capabilities.vision = false
        try settings.save(profile, apiKey: nil)
        XCTAssertEqual(settings.selection(model: "vision")?.endpoint.capabilities.vision, false, "the profile can turn it off")
    }

    func testImageReaderChoicePersistsAndGoesAwayWithItsProfile() throws {
        let settings = settings()
        let reader = ProviderProfile.draft(.openAI)
        try settings.save(reader, apiKey: "sk-reader")
        settings.store([ModelInfo(id: "gpt-vision", displayName: "GPT Vision", supportsImages: true)], for: reader.id)
        settings.setImageReader(ImageReaderChoice(profileID: reader.id, model: "gpt-vision"))
        XCTAssertEqual(settings.imageReaderDisplayName, "OpenAI · GPT Vision")
        XCTAssertEqual(settings.imageReaderSelection()?.endpoint.apiKey, "sk-reader")

        let reloaded = self.settings()
        XCTAssertEqual(reloaded.imageReader, ImageReaderChoice(profileID: reader.id, model: "gpt-vision"))
        let json = try String(contentsOf: directory.appendingPathComponent("Providers.json"), encoding: .utf8)
        XCTAssertFalse(json.contains("sk-reader"), "keys stay in the Keychain")

        reloaded.delete(reader.id)
        XCTAssertNil(reloaded.imageReader)
    }

    func testImageReaderAccessNeedsAReaderAndConsent() throws {
        let settings = settings()
        let consent = AIDataConsent(fileURL: nil)
        guard case .unavailable(let none) = AgentServices.imageReaderAccess(settings: settings, consent: consent) else {
            return XCTFail("nothing configured")
        }
        XCTAssertTrue(none.contains("Settings → Image reading model"))

        let reader = ProviderProfile.draft(.openAI)
        try settings.save(reader, apiKey: "sk-reader")
        settings.setImageReader(ImageReaderChoice(profileID: reader.id, model: "gpt-vision"))
        guard case .unavailable(let blocked) = AgentServices.imageReaderAccess(settings: settings, consent: consent) else {
            return XCTFail("no consent yet")
        }
        XCTAssertTrue(blocked.contains("api.openai.com"))

        consent.grant("api.openai.com", providerName: "OpenAI")
        guard case .ready(let ready) = AgentServices.imageReaderAccess(settings: settings, consent: consent) else {
            return XCTFail("ready")
        }
        XCTAssertEqual(ready.model, "gpt-vision")
        XCTAssertEqual(ready.endpoint.apiKey, "sk-reader")
    }

    // MARK: Live engine

    func testBlindModelAsksTheImageReader() async throws {
        let settings = settings()
        var chat = ProviderProfile.draft(.customAnthropic) // conservative: no vision
        chat.endpoint.baseURL = URL(string: "http://localhost:9/v1")!
        chat.defaultModel = "text-model"
        try settings.save(chat, apiKey: "sk-chat")
        var reader = ProviderProfile.draft(.customOpenAI)
        reader.name = "Reader"
        reader.endpoint.baseURL = URL(string: "http://localhost:8/v1")!
        reader.endpoint.capabilities.vision = true
        try settings.save(reader, apiKey: "sk-reader")
        settings.select(chat.id)

        let consent = AIDataConsent(fileURL: nil)
        consent.grant("localhost:9", providerName: "Chat")
        let readerTransport = ScriptedTransport(replies: [openAISSE("A plain red rectangle.")])
        let services = AgentServices(settings: settings,
                                     connectors: ConnectorLibrary(fileURL: directory.appendingPathComponent("Connectors.json"),
                                                                  secrets: secrets, transport: ScriptedTransport(replies: [])),
                                     skills: SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills")),
                                     elicitations: ElicitationCenter(), providerTransport: readerTransport,
                                     attachments: attachments, consent: consent)

        let bytes = png()
        let id = ImageReference.id(for: bytes)
        let provider = ScriptedProvider(capabilities: Capabilities(vision: false), steps: [
            ScriptedProvider.toolCalls([("t1", "look_at_image", #"{"image_id":"\#(id)","question":"What is it?"}"#)]),
            ScriptedProvider.text("It's a red rectangle."),
        ])
        var engine = LiveChatEngine(runtime: services.runtime, resolve: { model in await settings.selection(model: model) },
                                    makeProvider: { _, _ in provider }, attachments: attachments, usesBackgroundTasks: false)
        engine.imageReader = { await AgentServices.imageReaderAccess(settings: settings, consent: consent) }
        let store = ChatStore(engine: engine, conversations: [Conversation(title: "New chat")],
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)

        store.attachments = [Attachment(kind: .photo, name: "shot", imageData: bytes, store: attachments)]
        XCTAssertEqual(store.imageInputHint, .noReader)
        settings.setImageReader(ImageReaderChoice(profileID: reader.id, model: "llava"))
        XCTAssertEqual(store.imageInputHint, .readerNeedsConsent("Reader · llava"))
        consent.grant("localhost:8", providerName: "Reader")
        XCTAssertEqual(store.imageInputHint, .reader("Reader · llava"))

        store.send(text: "What's in the picture?")
        await waitUntil { !store.isRunning }

        let conv = store.conversations[0]
        XCTAssertTrue(conv.setup?.toolSpecs.contains { $0.name == "look_at_image" } == true)
        XCTAssertTrue(conv.setup?.systemPrompt.contains("[Image img_…] placeholder") == true)
        XCTAssertTrue(conv.setup?.systemPrompt.contains("look_at_image") == true)
        let result = try XCTUnwrap(conv.turns[0].transcript.flatMap(\.toolResults).first)
        XCTAssertFalse(result.isError, result.content.first?.text ?? "")
        XCTAssertTrue(result.content.first?.text?.contains("A plain red rectangle.") == true)
        let sent = try XCTUnwrap(readerTransport.requests.first)
        XCTAssertEqual(sent.url?.host(), "localhost")
        XCTAssertEqual(sent.url?.port, 8)
        XCTAssertEqual(sent.headers["Authorization"], "Bearer sk-reader")
        await store.settle()
    }

    // MARK: Skills

    func testRegistriesPersistAndAgentSkillsCanBeEdited() async throws {
        let md = Data("---\nname: hello\ndescription: Says hello. Use to greet.\n---\n\nSay hello.\n".utf8)
        let digest = "sha256:" + SHA256Hex.of(md)
        let index = """
        {"$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
         "skills": [{"name": "hello", "type": "skill-md", "description": "Says hello.", "url": "hello/SKILL.md", "digest": "\(digest)"}]}
        """
        let transport = ScriptedTransport { request, _ in
            switch request.url?.path() {
            case "/.well-known/agent-skills/index.json"?: return .json(index)
            case "/.well-known/agent-skills/hello/SKILL.md"?: return ScriptedTransport.Reply(status: 200, body: md)
            default: return ScriptedTransport.Reply(status: 404, body: Data())
            }
        }
        let file = directory.appendingPathComponent("SkillRegistries.json")
        let library = SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills"), registriesFileURL: file,
                                   transport: transport)
        XCTAssertEqual(library.registries.map(\.name), ["Anthropic", "OpenAI (curated)"])
        let registry = try await library.addRegistry("example.com")
        XCTAssertEqual(registry.name, "example.com")
        let listing = try await library.listing(for: registry)
        let report = try await library.install(try XCTUnwrap(listing.skills.first), from: registry)
        XCTAssertEqual(report.skill.source?.kind, .registry)
        XCTAssertEqual(library.skills.first?.source?.registryID, registry.id)

        let reopened = SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills"), registriesFileURL: file,
                                    transport: transport)
        XCTAssertEqual(reopened.customRegistries.map(\.id), [registry.id])
        reopened.removeRegistry(registry.id)
        XCTAssertTrue(SkillLibrary(importedDirectory: directory, registriesFileURL: file).customRegistries.isEmpty)

        // An agent-made skill, edited in the app: provenance kept, rules apply.
        try await library.store.saveAgentSkill(SkillDraft(name: "recap", description: "Recaps. Use for recaps.",
                                                          instructions: "v1", files: ["ref.md": "r"]),
                                               replace: false, conversationID: "c1")
        await library.reload()
        var draft = try await library.draft(for: "recap")
        draft.instructions = "v2"
        try await library.saveEdit(draft)
        let edited = try XCTUnwrap(library.skills.first { $0.name == "recap" })
        XCTAssertTrue(edited.isAgentCreated)
        XCTAssertEqual(edited.files.map(\.path), ["ref.md"])
        draft.description = "Bad <tag>x</tag>"
        do {
            try await library.saveEdit(draft)
            XCTFail("XML in the description is refused")
        } catch {}
        do {
            try await library.saveEdit(SkillDraft(name: "hello", description: "Mine now.", instructions: "x"))
            XCTFail("registry skills aren't editable as agent skills")
        } catch {}
    }
}

import CryptoKit
private enum SHA256Hex {
    static func of(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
