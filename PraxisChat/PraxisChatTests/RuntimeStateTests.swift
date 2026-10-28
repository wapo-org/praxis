import XCTest
import AgentCore
import AgentProviders
import AgentMCP
import AgentRuntime
import AgentTestSupport
@testable import PraxisChat

/// Context compaction through the app, durable runtime state (spills,
/// JS `kv`) and the JS `fs` scope over attachments.
@MainActor
final class RuntimeStateTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!
    private lazy var attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))

    override func setUp() async throws {
        directory = temporaryDirectory()
        secrets = InMemorySecretStore()
    }

    /// Flushed before the directory goes, so no write lands in a removed folder.
    private var persistences: [ConversationStore] = []

    override func tearDown() async throws {
        for persistence in persistences { await persistence.flush() }
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeServices(scratch: ScratchStore? = nil) throws -> AgentServices {
        let settings = ProviderSettings(fileURL: directory.appendingPathComponent("Providers.json"), secrets: secrets)
        var profile = ProviderProfile.draft(.customAnthropic)
        profile.endpoint.baseURL = URL(string: "http://localhost:9/v1")!
        profile.defaultModel = "test-model"
        try settings.save(profile, apiKey: "sk-test")
        let consent = AIDataConsent(fileURL: nil)
        consent.grant("localhost:9", providerName: "Test")
        return AgentServices(settings: settings,
                             connectors: ConnectorLibrary(fileURL: directory.appendingPathComponent("Connectors.json"),
                                                          secrets: secrets, transport: ScriptedTransport(replies: [])),
                             skills: SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills")),
                             elicitations: ElicitationCenter(), providerTransport: ScriptedTransport(replies: []),
                             attachments: attachments, consent: consent, scratch: scratch)
    }

    private func store(_ services: AgentServices, _ provider: ScriptedProvider, conversations: [Conversation]?) -> ChatStore {
        let settings = services.settings
        let engine = LiveChatEngine(runtime: services.runtime, resolve: { model in await settings.selection(model: model) },
                                    makeProvider: { _, _ in provider }, attachments: attachments, usesBackgroundTasks: false)
        let persistence = ConversationStore(directory: directory.appendingPathComponent("Conversations"))
        persistences.append(persistence)
        let store = ChatStore(engine: engine, conversations: conversations, persistence: persistence,
                              attachments: attachments, services: services)
        store.coalesceInterval = .milliseconds(5)
        return store
    }

    private func send(_ store: ChatStore, _ text: String) async {
        store.send(text: text)
        await waitUntil { !store.isRunning }
    }

    // MARK: Compaction

    /// One earlier live turn far over the default (128K fallback) budget.
    private func longConversation() -> Conversation {
        let big = String(repeating: "lorem ipsum ", count: 21_000) // ~63K estimated tokens
        var turn = Turn(userText: "old question")
        turn.engine = .live
        turn.isFinished = true
        turn.transcript = [.user("old question " + big), Message(role: .assistant, parts: [.text("old answer " + big)])]
        return Conversation(title: "Long", turns: [turn])
    }

    func testCompactionIsShownPersistedAndReusedWhileTheTranscriptStaysWhole() async throws {
        let services = try makeServices()
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("SUMMARY OF OLD"), ScriptedProvider.text("answer"),
                                                ScriptedProvider.text("second answer")])
        let chat = store(services, provider, conversations: [longConversation()])
        let conv = chat.conversations[0]

        await send(chat, "next")
        XCTAssertEqual(provider.requests.count, 2)
        XCTAssertTrue(provider.requests[0].tools.isEmpty, "the summary request")
        let main = provider.requests[1]
        XCTAssertTrue(main.messages[0].text.contains("SUMMARY OF OLD"))
        XCTAssertEqual(main.messages.count, 1, "summary joined the new user message")
        XCTAssertEqual(conv.compaction?.coveredMessages, 2)
        XCTAssertEqual(conv.compaction?.summary, "SUMMARY OF OLD")
        // The full history is still stored for the UI.
        XCTAssertEqual(conv.turns[0].transcript.count, 2)
        XCTAssertEqual(conv.turns[1].transcript.last?.text, "answer")
        // A divider marker in the thread carries the summary.
        let marker = try XCTUnwrap(conv.turns[1].compactionMarkers.first)
        XCTAssertEqual(marker.state, .done)
        XCTAssertEqual(marker.summary, "SUMMARY OF OLD")
        XCTAssertGreaterThan(marker.tokensBefore, marker.tokensAfter)
        XCTAssertTrue(conv.turns[1].activities.flatMap(\.steps).isEmpty, "no step for it any more")

        // Reload from disk: the record survives and is reused without summarizing again.
        await persistences.last?.flush()
        let reloaded = store(services, provider, conversations: nil)
        let again = try XCTUnwrap(reloaded.conversations.first { $0.id == conv.id })
        XCTAssertEqual(again.compaction, conv.compaction)
        XCTAssertEqual(again.turns[1].compactionMarkers, [marker], "the marker and its summary survive relaunch")
        reloaded.select(again.id)
        await send(reloaded, "and then?")
        XCTAssertEqual(provider.requests.count, 3)
        let third = provider.requests[2]
        XCTAssertFalse(third.tools.isEmpty)
        XCTAssertTrue(third.messages[0].text.contains("SUMMARY OF OLD"))
        XCTAssertEqual(third.messages.last?.text.hasSuffix("and then?"), true)
        XCTAssertLessThan(third.messages.count, again.turns.flatMap(\.transcript).count)
    }

    func testCompactionRecordRoundTripsAndANewerOneIsDroppedNotFatal() throws {
        var record = ConversationRecord(id: UUID(), title: "t", updatedAt: Date(), isPinned: false, turns: [],
                                        compaction: ContextCompaction(summary: "s", coveredMessages: 2, fingerprint: "f", model: "m"))
        let data = try JSONEncoder().encode(record)
        XCTAssertEqual(try JSONDecoder().decode(ConversationRecord.self, from: data).compaction?.summary, "s")

        var json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        var compaction = try XCTUnwrap(json["compaction"] as? [String: Any])
        compaction["version"] = 99
        json["compaction"] = compaction
        let decoded = try JSONDecoder().decode(ConversationRecord.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(decoded.compaction)
        XCTAssertEqual(decoded.title, "t")
        record.compaction = nil
        let plain = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any])
        XCTAssertNil(plain["compaction"], "absent when there's none")
    }

    func testReducerShowsCompactionAsADividerMarker() {
        var reducer = TurnReducer()
        var turn = Turn(userText: "q")
        let now = Date()
        let tool = ToolActivity(id: "t1", name: "search", source: .builtin,
                                presentation: ToolPresentation(category: .other, runningTitle: "Searching", finishedTitle: "Searched"))
        _ = reducer.reduce(.toolCallStarted(tool), into: &turn, at: now)
        _ = reducer.reduce(.toolFinished(id: "t1", ToolCompletion(status: .succeeded, summary: "ok")), into: &turn, at: now)

        _ = reducer.reduce(.compaction(id: "k1", .started(.threshold)), into: &turn, at: now)
        XCTAssertEqual(turn.compactionMarkers.map(\.state), [.running])
        XCTAssertEqual(CompactionActivity.title(turn.compactionMarkers[0]), "Summarizing earlier messages…")
        XCTAssertFalse(turn.activities[0].isRunning, "the marker ends the open activity")

        let record = ContextCompaction(summary: "s", coveredMessages: 3, fingerprint: "f", model: "m",
                                       tokensBefore: 120_000, tokensAfter: 9_000)
        let change = reducer.reduce(.compaction(id: "k1", .finished(record)), into: &turn, at: now)
        XCTAssertTrue(change.effects.contains(.commit))
        let marker = turn.compactionMarkers[0]
        XCTAssertEqual(marker.state, .done)
        XCTAssertEqual(marker.summary, "s")
        XCTAssertEqual(CompactionActivity.title(marker), "Earlier messages summarized")
        XCTAssertEqual(CompactionActivity.sizes(before: marker.tokensBefore, after: marker.tokensAfter), "~120K → ~9K tokens")
        XCTAssertEqual(CompactionActivity.accessibilityLabel(marker), "Earlier messages summarized, ~120K → ~9K tokens")

        // A later step opens a new activity below the marker.
        _ = reducer.reduce(.toolCallStarted(ToolActivity(id: "t2", name: "search", source: .builtin, presentation: tool.presentation)),
                           into: &turn, at: now)
        XCTAssertEqual(turn.activities.count, 2)
        guard case .activity? = turn.blocks.last else { return XCTFail("activity after the marker") }

        // A failed one says why; a cancelled or unfinished one leaves nothing behind.
        _ = reducer.reduce(.compaction(id: "k2", .started(.overflow)), into: &turn, at: now)
        _ = reducer.reduce(.compaction(id: "k2", .failed("Couldn't summarize earlier messages: 500")), into: &turn, at: now)
        XCTAssertEqual(turn.compactionMarkers.last?.state, .failed("Couldn't summarize earlier messages: 500"))
        _ = reducer.reduce(.compaction(id: "k3", .started(.threshold)), into: &turn, at: now)
        _ = reducer.reduce(.compaction(id: "k3", .failed(CompactionActivity.cancelledReason)), into: &turn, at: now)
        _ = reducer.reduce(.compaction(id: "k4", .started(.threshold)), into: &turn, at: now)
        _ = reducer.finish(&turn, outcome: .stopped, at: now)
        XCTAssertEqual(turn.compactionMarkers.map(\.key), ["k1", "k2"])
    }

    func testCompactionMarkersRoundTripInTurns() throws {
        var turn = Turn(userText: "q")
        turn.blocks = [.compaction(CompactionMarker(key: "k", state: .failed("x"))),
                       .compaction(CompactionMarker(key: "k2", state: .done, summary: "remembered", tokensBefore: 5, tokensAfter: 2))]
        let decoded = try JSONDecoder().decode(Turn.self, from: JSONEncoder().encode(turn))
        XCTAssertEqual(decoded.blocks, turn.blocks)
    }

    // MARK: Measured prompt size

    func testMeasuredPromptSizeIsPersistedAndBudgetsTheNextRun() async throws {
        let services = try makeServices()
        // The provider reports a prompt far larger than the text suggests.
        let huge = Usage(inputTokens: 20_000, outputTokens: 10, cacheReadTokens: 105_000)
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("first answer", usage: huge),
                                                ScriptedProvider.text("SUMMARY"), ScriptedProvider.text("second answer")])
        let chat = store(services, provider, conversations: [Conversation(title: "New chat")])
        await send(chat, "hello")
        let conv = try XCTUnwrap(chat.selected)
        let measurement = try XCTUnwrap(conv.contextMeasurement)
        XCTAssertEqual(measurement.promptTokens, 125_000)
        XCTAssertEqual(measurement.messageCount, 1)
        XCTAssertNil(conv.compaction)

        // Relaunch: the measurement is on disk, and the next run starts from it — 125K is
        // over the default window's budget, so it summarizes before sending.
        await persistences.last?.flush()
        let reloaded = store(services, provider, conversations: nil)
        let again = try XCTUnwrap(reloaded.conversations.first { $0.id == conv.id })
        XCTAssertEqual(again.contextMeasurement, measurement)
        reloaded.select(again.id)
        await send(reloaded, "and then?")
        XCTAssertEqual(provider.requests.count, 3)
        XCTAssertTrue(provider.requests[1].tools.isEmpty, "the summary request came first")
        XCTAssertNotNil(again.compaction)
        XCTAssertEqual(again.turns.last?.compactionMarkers.first?.state, .done)
    }

    func testMeasurementRoundTripsAndANewerOneIsDropped() throws {
        let m = ContextMeasurement(model: "m", messageCount: 2, fingerprint: "f", compactedMessages: 0, promptTokens: 9)
        let record = ConversationRecord(id: UUID(), title: "t", updatedAt: Date(), isPinned: false, turns: [],
                                        contextMeasurement: m)
        let data = try JSONEncoder().encode(record)
        XCTAssertEqual(try JSONDecoder().decode(ConversationRecord.self, from: data).contextMeasurement, m)
        var json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        var stored = try XCTUnwrap(json["contextMeasurement"] as? [String: Any])
        stored["version"] = 99
        json["contextMeasurement"] = stored
        let decoded = try JSONDecoder().decode(ConversationRecord.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertNil(decoded.contextMeasurement)
        XCTAssertEqual(decoded.title, "t")
    }

    // MARK: Deleting a conversation

    func testDeletingAConversationDropsItsRuntimeFiles() async throws {
        let root = directory.appendingPathComponent("Scratch", isDirectory: true)
        let services = try makeServices(scratch: ScratchStore(root: root))
        let chat = store(services, ScriptedProvider(steps: []), conversations: [Conversation(title: "a"), Conversation(title: "b")])
        let (a, b) = (chat.conversations[0].id.uuidString, chat.conversations[1].id.uuidString)
        await services.runtime.spills.spill(for: a).store(id: "x", text: "spilled")
        await services.runtime.spills.spill(for: b).store(id: "x", text: "kept")
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(a).path))

        chat.deleteConversations([chat.conversations[0].id])
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent(a).path))
        let kept = await services.runtime.spills.spill(for: b).length(id: "x")
        XCTAssertEqual(kept, 4)

        // Launch-time pruning drops directories of conversations that are gone.
        try ScratchStore(root: root).write(Data("orphan".utf8), conversationID: "gone", name: "kv.json")
        services.pruneRuntimeState(keeping: chat.conversations.map(\.id))
        await waitUntil { !FileManager.default.fileExists(atPath: root.appendingPathComponent("gone").path) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: root.appendingPathComponent(b).path))
    }

    // MARK: JS fs scope

    private func file(_ name: String, _ text: String) -> Attachment {
        Attachment(kind: .file, name: name, fileData: Data(text.utf8), mediaType: "text/plain", store: attachments)
    }

    func testFilesListThisTurnAndReadEarlierOnesByExactNameOnly() async throws {
        let old = file("data.csv", "v1"), notes = file("notes.txt", "notes"), new = file("data.csv", "v2")
        let files = AttachmentFiles(current: [new], conversation: [old, notes, new], store: attachments)

        let listed = await files.list()
        XCTAssertEqual(listed, ["data.csv"])
        // The re-attached copy owns the plain name; the older one is still reachable.
        var read = try await files.read("data.csv", maxBytes: 100)
        XCTAssertEqual(String(decoding: read, as: UTF8.self), "v2")
        read = try await files.read("data (2).csv", maxBytes: 100)
        XCTAssertEqual(String(decoding: read, as: UTF8.self), "v1")
        read = try await files.read("notes.txt", maxBytes: 3)
        XCTAssertEqual(String(decoding: read, as: UTF8.self), "not")

        for path in ["/notes.txt", "../notes.txt", "./notes.txt", "sub/notes.txt", "..", "", "NOTES.TXT", "notes"] {
            do {
                _ = try await files.read(path, maxBytes: 100)
                XCTFail("\(path) should not be readable")
            } catch {}
        }
    }

    func testHiddenFilesAreNeitherListedNorReadable() async throws {
        let old = file("secrets.csv", "old"), notes = file("notes.txt", "notes"), new = file("data.csv", "new")
        var hiddenOld = old
        hiddenOld.isHiddenFromCode = true
        var hiddenNew = new
        hiddenNew.isHiddenFromCode = true
        let files = AttachmentFiles(current: [hiddenNew, notes], conversation: [hiddenOld, hiddenNew, notes], store: attachments)

        let listed = await files.list()
        XCTAssertEqual(listed, ["notes.txt"], "a hidden file of this turn isn't listed")
        for name in ["secrets.csv", "data.csv"] {
            do {
                _ = try await files.read(name, maxBytes: 100)
                XCTFail("\(name) is hidden")
            } catch let error as AttachmentFiles.HiddenFromCode {
                XCTAssertEqual(error.name, name)
                XCTAssertTrue(error.localizedDescription.contains("turned off code access for “\(name)”"), error.localizedDescription)
            }
        }
        let read = try await files.read("notes.txt", maxBytes: 100)
        XCTAssertEqual(String(decoding: read, as: UTF8.self), "notes")
    }

    func testHidingAppliesMidRunThroughTheLiveSet() async throws {
        let old = file("data.csv", "v1"), new = file("other.txt", "x")
        let hidden = HiddenSet()
        let files = AttachmentFiles(current: [new], conversation: [old, new], store: attachments,
                                    hidden: { hidden.value })
        _ = try await files.read("data.csv", maxBytes: 10)
        hidden.value = [old.id, new.id]
        let listed = await files.list()
        XCTAssertEqual(listed, [])
        do { _ = try await files.read("data.csv", maxBytes: 10); XCTFail("hidden now") } catch is AttachmentFiles.HiddenFromCode {}
        hidden.value = []
        let back = try await files.read("data.csv", maxBytes: 10)
        XCTAssertEqual(String(decoding: back, as: UTF8.self), "v1")
    }

    func testHideFromCodeIsPersistedWithTheConversation() async throws {
        let services = try makeServices()
        let a = file("a.txt", "A")
        var turn = Turn(userText: "q", attachments: [a])
        turn.isFinished = true
        let chat = store(services, ScriptedProvider(steps: [ScriptedProvider.text("ok")]),
                         conversations: [Conversation(title: "c", turns: [turn])])
        let conv = chat.conversations[0]
        await send(chat, "go") // indexes the conversation on disk
        // In the composer, before sending…
        let pending = file("b.txt", "B")
        chat.attachments = [pending]
        chat.setHiddenFromCode(true, attachmentID: pending.id)
        XCTAssertTrue(chat.attachments[0].isHiddenFromCode)
        // …and on a sent turn.
        chat.setHiddenFromCode(true, attachmentID: a.id)
        XCTAssertEqual(chat.hiddenFromCode(in: conv.id), [a.id])

        await persistences.last?.flush()
        let reloaded = store(services, ScriptedProvider(steps: []), conversations: nil)
        let again = try XCTUnwrap(reloaded.conversations.first { $0.id == conv.id })
        XCTAssertEqual(again.turns[0].attachments.first?.isHiddenFromCode, true)
        XCTAssertEqual(reloaded.hiddenFromCode(in: conv.id), [a.id])
        reloaded.setHiddenFromCode(false, attachmentID: a.id)
        XCTAssertEqual(reloaded.hiddenFromCode(in: conv.id), [])
        // Older files on disk (no flag) decode as available.
        let legacy = #"{"id":"\#(UUID().uuidString)","kind":"file","name":"x.txt","hasImage":false}"#
        XCTAssertFalse(try JSONDecoder().decode(Attachment.self, from: Data(legacy.utf8)).isHiddenFromCode)
    }

    func testMessageNotesFilesHiddenFromCode() {
        var hidden = file("big.bin", "x")
        hidden.isHiddenFromCode = true
        let shown = file("log.bin", "y")
        let text = AttachmentMedia.text("look", fileOnly: [shown, hidden], hasJavaScript: true)
        XCTAssertEqual(text, "look\n\n[Attached file: “log.bin”. Read them with `fs` in run_javascript.]\n"
                       + "[Attached file hidden from code by the user: “big.bin”.]")
    }

    func testFilesWithoutBytesAreLeftOut() async throws {
        let ghost = Attachment(kind: .file, name: "ghost.txt", store: attachments)
        let files = AttachmentFiles(current: [ghost], store: attachments)
        XCTAssertTrue(files.isEmpty)
        let listed = await files.list()
        XCTAssertEqual(listed, [])
    }
}

/// A hidden set a test can change while `AttachmentFiles` holds it.
private final class HiddenSet: @unchecked Sendable {
    private let lock = NSLock()
    private var ids: Set<UUID> = []
    var value: Set<UUID> {
        get { lock.withLock { ids } }
        set { lock.withLock { ids = newValue } }
    }
}
