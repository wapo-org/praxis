import XCTest
import UIKit
import AgentCore
import AgentProviders
import AgentSkills
import AgentRuntime
import AgentMCP
import AgentTestSupport
@testable import PraxisChat

/// Per-model reasoning effort: settings resolution and learning, the
/// snap-to-supported-levels on model change, and the engine's resend
/// clamped (or without the parameter) after a rejection.
@MainActor
final class EffortLevelsAppTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!

    static let threeLevel = "some/three-level-model"
    static let plain = "some/plain-model"
    static let paramRejection = #"{"error":{"message":"Unrecognized request argument supplied: reasoning_effort","code":400}}"#
    static let valueRejection = #"{"error":{"message":"'reasoning_effort' does not support 'xhigh' with this model","code":400}}"#

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

    private func openRouterProfile(model: String = threeLevel) -> ProviderProfile {
        var profile = ProviderProfile.draft(.openRouterOpenAI)
        profile.defaultModel = model
        return profile
    }

    private func openAISSE(_ text: String) -> ScriptedTransport.Reply {
        let chunk = JSONValue.object(["choices": [["index": 0, "delta": ["content": .string(text)]]]]).encodedString()
        let done = JSONValue.object(["choices": [["index": 0, "delta": [:], "finish_reason": "stop"]]]).encodedString()
        return .sse("data: \(chunk)\n\ndata: \(done)\n\ndata: [DONE]\n\n")
    }

    private func services(_ settings: ProviderSettings, consent: AIDataConsent) -> AgentServices {
        AgentServices(settings: settings,
                      connectors: ConnectorLibrary(fileURL: directory.appendingPathComponent("Connectors.json"),
                                                   secrets: secrets, transport: ScriptedTransport(replies: [])),
                      skills: SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills")),
                      elicitations: ElicitationCenter(), providerTransport: ScriptedTransport(replies: []),
                      attachments: attachments, consent: consent)
    }

    private func grantedConsent(for profile: ProviderProfile) -> AIDataConsent {
        let consent = AIDataConsent(fileURL: nil)
        consent.grant(AIDataConsent.host(of: profile.endpoint.baseURL), providerName: "OpenRouter")
        return consent
    }

    private func liveStore(settings: ProviderSettings, chat: ScriptedTransport) -> ChatStore {
        let services = services(settings, consent: grantedConsent(for: openRouterProfile()))
        var engine = LiveChatEngine(runtime: services.runtime, resolve: { model in await settings.selection(model: model) },
                                    makeProvider: { endpoint, _ in OpenAIChatProvider(endpoint: endpoint, transport: chat) },
                                    attachments: attachments, usesBackgroundTasks: false)
        engine.onEffortRejected = { selection in
            await settings.markEffortUnsupported(profileID: selection.profileID, model: selection.model)
        }
        engine.onEffortValueRejected = { selection, value in
            await settings.markEffortValueUnsupported(profileID: selection.profileID, model: selection.model, value: value)
        }
        let store = ChatStore(engine: engine, conversations: [Conversation(title: "New chat")],
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)
        return store
    }

    // MARK: Settings resolution

    func testEffortResolutionPrefersLearnedThenListed() throws {
        let settings = settings()
        let profile = openRouterProfile()
        try settings.save(profile, apiKey: "sk-or")
        XCTAssertNil(settings.effortWireValues(profileID: profile.id, model: Self.threeLevel), "no list cached")

        settings.store([ModelInfo(id: Self.threeLevel, reasoningEfforts: ["low", "medium", "high"]),
                        ModelInfo(id: Self.plain, reasoningEfforts: [])], for: profile.id)
        XCTAssertEqual(settings.effortWireValues(profileID: profile.id, model: Self.threeLevel), ["low", "medium", "high"])
        XCTAssertEqual(settings.effortWireValues(profileID: profile.id, model: Self.plain), [])
        XCTAssertNil(settings.effortWireValues(profileID: profile.id, model: "some/unlisted"))

        let now = Date()
        settings.markEffortValueUnsupported(profileID: profile.id, model: Self.threeLevel, value: "high", now: now)
        XCTAssertEqual(settings.effortWireValues(profileID: profile.id, model: Self.threeLevel, now: now),
                       ["low", "medium"], "learned narrowing wins over the list")
        XCTAssertEqual(settings.effortWireValues(profileID: profile.id, model: Self.threeLevel,
                                                 now: now + ProviderSettings.effortRejectionLifetime + 1),
                       ["low", "medium", "high"], "lapsed learning falls back to the list")
    }

    func testEffortCapabilityOffMeansNoLevels() throws {
        let settings = settings()
        var profile = openRouterProfile()
        profile.endpoint.capabilities.reasoningEffort = false
        try settings.save(profile, apiKey: "sk-or")
        settings.store([ModelInfo(id: Self.threeLevel, reasoningEfforts: ["low", "medium", "high"])], for: profile.id)
        XCTAssertEqual(settings.effortWireValues(profileID: profile.id, model: Self.threeLevel), [])
        XCTAssertEqual(settings.selection()?.effortLevels, [])
    }

    func testLearnedLevelsClearWhenTheListChangesLevels() throws {
        let settings = settings()
        let profile = openRouterProfile()
        try settings.save(profile, apiKey: "sk-or")
        settings.store([ModelInfo(id: Self.threeLevel, reasoningEfforts: ["low", "medium", "high"])], for: profile.id)
        settings.markEffortValueUnsupported(profileID: profile.id, model: Self.threeLevel, value: "high")
        XCTAssertEqual(settings.effortWireValues(profileID: profile.id, model: Self.threeLevel), ["low", "medium"])

        // The list reports new levels: the learning is stale.
        settings.store([ModelInfo(id: Self.threeLevel, reasoningEfforts: ["low", "medium", "high", "xhigh"])], for: profile.id)
        XCTAssertEqual(settings.effortWireValues(profileID: profile.id, model: Self.threeLevel),
                       ["low", "medium", "high", "xhigh"])

        // A list that merely repeats itself keeps contradicting learning.
        settings.markEffortValueUnsupported(profileID: profile.id, model: Self.threeLevel, value: "high")
        settings.store([ModelInfo(id: Self.threeLevel, reasoningEfforts: ["low", "medium", "high", "xhigh"])], for: profile.id)
        XCTAssertEqual(settings.effortWireValues(profileID: profile.id, model: Self.threeLevel), ["low", "medium"])
    }

    func testLearnedLevelsSurviveARelaunch() throws {
        let settings = settings()
        let profile = openRouterProfile()
        try settings.save(profile, apiKey: "sk-or")
        settings.markEffortUnsupported(profileID: profile.id, model: Self.plain)
        XCTAssertEqual(self.settings().effortWireValues(profileID: profile.id, model: Self.plain), [])
    }

    // MARK: Snapping to the new model's levels

    func testLiveModelChangeSnapsEffortToSupportedLevels() throws {
        let settings = settings()
        let profile = openRouterProfile(model: Self.plain)
        try settings.save(profile, apiKey: "sk-or")
        settings.store([ModelInfo(id: Self.threeLevel, reasoningEfforts: ["low", "medium", "high"]),
                        ModelInfo(id: Self.plain, reasoningEfforts: [])], for: profile.id)
        let store = liveStore(settings: settings, chat: ScriptedTransport(replies: []))
        XCTAssertTrue(store.isLive)
        XCTAssertEqual(store.supportedEfforts, [], "the plain model offers nothing")

        store.effort = .max
        store.model = AIModel(id: Self.threeLevel, name: "Three", tagline: "", speed: 0, intelligence: 0, streamMultiplier: 1)
        XCTAssertEqual(store.supportedEfforts, [.low, .medium, .high])
        XCTAssertEqual(store.effort, .high, "max snaps to the nearest supported level")

        store.model = AIModel(id: Self.plain, name: "Plain", tagline: "", speed: 0, intelligence: 0, streamMultiplier: 1)
        XCTAssertEqual(store.effort, .high, "an unreasoning model keeps the dial where it was")
    }

    func testDemoModelChangeSnapsEffort() {
        let store = ChatStore()
        XCTAssertFalse(store.isLive)
        store.effort = .max
        store.model = MockData.models.first { $0.id == "atlas-mini" }!
        XCTAssertEqual(store.supportedEfforts, [.low, .medium, .high])
        XCTAssertEqual(store.effort, .high)
        store.effort = .low
        store.model = MockData.models.first { $0.id == "atlas-chat" }!
        XCTAssertEqual(store.supportedEfforts, [], "the chat model hides the control")
        XCTAssertEqual(store.effort, .low, "kept: nothing to snap to")
    }

    // MARK: The engine learns from rejections

    func testUnknownModelLearnsParamRejectionAndRetriesWithoutIt() async throws {
        let settings = settings()
        let profile = openRouterProfile(model: Self.plain)
        try settings.save(profile, apiKey: "sk-or")
        XCTAssertNil(settings.effortWireValues(profileID: profile.id, model: Self.plain), "no list cached")

        let chat = ScriptedTransport(replies: [.json(Self.paramRejection, status: 400), openAISSE("Hi there."), openAISSE("Again.")])
        let store = liveStore(settings: settings, chat: chat)
        store.send(text: "hi")
        await waitUntil { !store.isRunning }

        // One rejected request with the parameter, then the same run without it.
        XCTAssertEqual(chat.requests.count, 2)
        XCTAssertEqual(chat.requests.first?.json?["reasoning_effort"], "high", "unknown is tried")
        XCTAssertNil(chat.requests.last?.json?["reasoning_effort"], "the resend drops the parameter")

        let turn = store.conversations[0].turns[0]
        XCTAssertEqual(turn.outcome, .completed, "the user isn't left with the 400")
        let note = try XCTUnwrap(turn.activities.flatMap(\.steps).first { $0.toolCallID == "effort-not-supported" },
                                 "a step says the model answered without effort")
        XCTAssertTrue(note.finalSummary.contains("doesn't take a reasoning effort"), note.finalSummary)

        // Learned and persisted: the next send drops the parameter from the start.
        XCTAssertEqual(settings.effortWireValues(profileID: profile.id, model: Self.plain), [])
        XCTAssertEqual(self.settings().effortWireValues(profileID: profile.id, model: Self.plain), [],
                       "survives a relaunch")
        XCTAssertEqual(store.supportedEfforts, [], "the tray now hides the control")
        store.send(text: "again")
        await waitUntil { !store.isRunning }
        XCTAssertEqual(chat.requests.count, 3, "no second rejection")
        XCTAssertNil(chat.requests.last?.json?["reasoning_effort"])
        await store.settle()
    }

    func testUnknownModelLearnsValueRejectionAndRetriesClamped() async throws {
        let settings = settings()
        var profile = openRouterProfile(model: Self.plain)
        profile.endpoint.openAI.maxEffortValue = "xhigh"
        try settings.save(profile, apiKey: "sk-or")

        let chat = ScriptedTransport(replies: [.json(Self.valueRejection, status: 400), openAISSE("Hi there.")])
        let store = liveStore(settings: settings, chat: chat)
        store.effort = .max
        store.send(text: "hi")
        await waitUntil { !store.isRunning }

        XCTAssertEqual(chat.requests.count, 2)
        XCTAssertEqual(chat.requests.first?.json?["reasoning_effort"], "xhigh")
        XCTAssertEqual(chat.requests.last?.json?["reasoning_effort"], "high", "nearest valid level")
        XCTAssertEqual(settings.effortWireValues(profileID: profile.id, model: Self.plain),
                       ["minimal", "low", "medium", "high"], "narrowed and remembered")
        let turn = store.conversations[0].turns[0]
        XCTAssertEqual(turn.outcome, .completed)
        XCTAssertTrue(turn.activities.flatMap(\.steps).allSatisfy { $0.toolCallID != "effort-not-supported" },
                      "a value fallback is silent")
        await store.settle()
    }

    func testKnownLevelsClampFromTheStart() async throws {
        let settings = settings()
        let profile = openRouterProfile(model: Self.threeLevel)
        try settings.save(profile, apiKey: "sk-or")
        settings.store([ModelInfo(id: Self.threeLevel, reasoningEfforts: ["low", "medium", "high"])], for: profile.id)
        XCTAssertEqual(settings.selection()?.effortLevels, ["low", "medium", "high"])

        let chat = ScriptedTransport(replies: [openAISSE("Hi there.")])
        let store = liveStore(settings: settings, chat: chat)
        store.effort = .max
        store.send(text: "hi")
        await waitUntil { !store.isRunning }

        XCTAssertEqual(chat.requests.count, 1, "nothing to reject")
        XCTAssertEqual(chat.requests.first?.json?["reasoning_effort"], "high", "max clamps to the top known level")
        await store.settle()
    }
}
