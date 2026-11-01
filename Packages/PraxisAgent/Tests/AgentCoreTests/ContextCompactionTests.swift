import Foundation
import Testing
@testable import AgentCore
import AgentTestSupport

private let noSleep: @Sendable (Duration) async throws -> Void = { _ in }

/// ~1000 estimated tokens.
private func filler(_ tag: String) -> String { tag + " " + String(repeating: "lorem ipsum ", count: 333) }

/// `pairs` user/assistant exchanges, then a new user question.
private func longTranscript(pairs: Int) -> [Message] {
    var messages: [Message] = []
    for i in 0..<pairs {
        messages.append(.user(filler("question \(i)")))
        messages.append(Message(role: .assistant, parts: [.text(filler("answer \(i)"))]))
    }
    messages.append(.user("And now?"))
    return messages
}

private func config(window: Int?, compaction: ContextCompaction? = nil) -> AgentRunConfiguration {
    AgentRunConfiguration(conversationID: "c1", model: "m", system: "sys", effort: .low,
                          context: ContextPolicy(contextWindow: window), compaction: compaction)
}

private func compactions(_ events: [AgentEvent]) -> [CompactionUpdate] {
    events.compactMap { if case .compaction(_, let u) = $0 { return u }; return nil }
}

private func finished(_ events: [AgentEvent]) -> [ContextCompaction] {
    compactions(events).compactMap { if case .finished(let c) = $0 { return c }; return nil }
}

private func outcome(_ events: [AgentEvent]) -> RunOutcome? {
    if case .finished(let o) = events.last { return o }
    return nil
}

private let echo = ClosureTool(name: "echo") { _, _ in .text("ok") }

@Suite struct ContextCompactionTests {
    // MARK: Threshold

    @Test func belowThresholdSendsTheFullTranscript() async {
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("fine")])
        let transcript = longTranscript(pairs: 2)
        let events = await AgentLoop(provider: provider, tools: .empty)
            .run(transcript: transcript, configuration: config(window: 200_000)).collect()
        #expect(outcome(events) == .completed)
        #expect(compactions(events).isEmpty)
        #expect(provider.requests.count == 1)
        #expect(provider.requests[0].messages == transcript)
    }

    @Test func crossingTheThresholdSummarizesOlderHistoryFirst() async throws {
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("SUMMARY of 0-3"), ScriptedProvider.text("answer")])
        let transcript = longTranscript(pairs: 9)
        let events = await AgentLoop(provider: provider, tools: ToolRegistry([echo]))
            .run(transcript: transcript, configuration: config(window: 30_000)).collect()

        #expect(outcome(events) == .completed)
        #expect(compactions(events).first == .started(.threshold))
        let record = try #require(finished(events).first)
        #expect(record.summary == "SUMMARY of 0-3")
        #expect(record.coveredMessages > 0 && record.coveredMessages < transcript.count)
        #expect(record.applies(to: transcript))
        #expect(record.tokensAfter < record.tokensBefore)

        // 1: the summary request — no tools, its own instructions, the old messages as text.
        let summary = provider.requests[0]
        #expect(summary.tools.isEmpty)
        #expect(summary.system != "sys")
        #expect(summary.messages.count == 1 && summary.messages[0].text.contains("question 0"))

        // 2: the real request — same system and tools (cache prefix), summary + verbatim tail.
        let main = provider.requests[1]
        #expect(main.system == "sys")
        #expect(main.tools.map(\.name) == ["echo"])
        #expect(main.messages.first?.role == .user)
        #expect(main.messages.first?.text.contains("SUMMARY of 0-3") == true)
        #expect(main.messages.last == transcript.last)
        #expect(main.messages.count < transcript.count)
        #expect(!main.messages.contains { $0.text.contains("question 0 ") })

        // The committed transcript is untouched: only the answer is appended.
        let committed = events.flatMap { if case .committed(let m) = $0 { return m }; return [] }
        #expect(committed.map(\.text) == ["answer"])
    }

    @Test func thresholdLeavesRoomForOutput() {
        let policy = ContextPolicy(contextWindow: 200_000)
        #expect(policy.threshold(window: 200_000, maxTokens: 32_000) == 128_000)
        // The output reserve is at most a quarter of the window.
        #expect(policy.threshold(window: 32_000, maxTokens: 64_000) == 17_600)
        #expect(ContextPolicy().window == 128_000)
    }

    @Test func failedSummaryKeepsTheRunGoing() async {
        let provider = ScriptedProvider(steps: [.failure(.http(status: 401, message: "nope", retryAfter: nil)),
                                                ScriptedProvider.text("answer")])
        let transcript = longTranscript(pairs: 6)
        let events = await AgentLoop(provider: provider, tools: .empty, sleep: noSleep)
            .run(transcript: transcript, configuration: config(window: 20_000)).collect()
        #expect(outcome(events) == .completed)
        guard case .failed? = compactions(events).last else { Issue.record("expected a failed compaction"); return }
        #expect(provider.requests[1].messages == transcript)
    }

    // MARK: Tool pairs

    @Test func splitPointNeverSeparatesCallsFromResults() {
        var messages: [Message] = [.user(filler("start"))]
        for i in 0..<12 {
            messages.append(Message(role: .assistant, parts: [.text(filler("step \(i)")),
                                                             .toolCall(ToolCall(id: "c\(i)", name: "echo", arguments: "{}"))]))
            messages.append(Message(role: .user, parts: [.toolResult(ToolResult(callID: "c\(i)", toolName: "echo",
                                                                                content: [.text(filler("result \(i)"))]))]))
        }
        for keep in [0, 500, 2_000, 5_000, 50_000] {
            guard let k = ContextCompaction.splitPoint(in: messages, after: 0, keepTokens: keep) else { continue }
            #expect(messages[k].toolResults.isEmpty, "cut at \(k) opens with tool results")
            let tail = messages[k...]
            let calls = Set(tail.flatMap(\.toolCalls).map(\.id))
            #expect(tail.flatMap(\.toolResults).allSatisfy { calls.contains($0.callID) })
            #expect(k < messages.count)
        }
        // Too small a budget still compacts, keeping the latest round trip whole.
        let k = ContextCompaction.splitPoint(in: messages, after: 0, keepTokens: 0)
        #expect(k == messages.count - 2)
        #expect(ContextCompaction.splitPoint(in: messages, after: messages.count - 2, keepTokens: 0) == nil)
    }

    @Test func compactionMidRunKeepsToolPairsValid() async throws {
        // Each round trip adds ~4000 tokens; the window forces a compaction
        // before the fourth request. No usage is reported, so estimates decide.
        let big = ClosureTool(name: "big") { _, _ in .text((0..<4).map { filler("payload \($0)") }.joined()) }
        func call(_ id: String) -> ScriptedProvider.Step {
            .events([.toolCallStarted(index: 0, id: id, name: "big"), .blockFinished(index: 0),
                     .completed(ProviderResponse(message: Message(role: .assistant, parts: [.toolCall(ToolCall(id: id, name: "big", arguments: "{}"))]),
                                                 stopReason: .toolUse, usage: Usage()))])
        }
        let provider = ScriptedProvider(steps: [call("t0"), call("t1"), call("t2"), ScriptedProvider.text("SUMMARY"), call("t3"),
                                                ScriptedProvider.text("done")])
        let events = await AgentLoop(provider: provider, tools: ToolRegistry([big]), limiter: ResultLimiter(maxCharacters: 100_000))
            .run(transcript: [.user("go")], configuration: config(window: 20_000)).collect()

        #expect(outcome(events) == .completed)
        let record = try #require(finished(events).first)
        let last = try #require(provider.requests.last)
        #expect(last.messages.first?.text.contains("SUMMARY") == true)
        // Every result in the request answers a call that's in the request too.
        let calls = Set(last.messages.flatMap(\.toolCalls).map(\.id))
        #expect(last.messages.flatMap(\.toolResults).allSatisfy { calls.contains($0.callID) })
        #expect(last.messages.flatMap(\.toolResults).count >= 1)
        #expect(record.coveredMessages >= 1)
    }

    // MARK: Persisted record

    @Test func persistedCompactionIsReusedWithoutResummarizing() async {
        let transcript = longTranscript(pairs: 4)
        let record = ContextCompaction(summary: "EARLIER", coveredMessages: 6,
                                       fingerprint: ContextCompaction.fingerprint(transcript[..<6]), model: "m")
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("answer")])
        let events = await AgentLoop(provider: provider, tools: .empty)
            .run(transcript: transcript, configuration: config(window: 200_000, compaction: record)).collect()
        #expect(outcome(events) == .completed)
        #expect(compactions(events).isEmpty)
        #expect(provider.requests.count == 1)
        let sent = provider.requests[0].messages
        #expect(sent.count == transcript.count - 6)
        // The tail opens with a user message: the summary joins it.
        #expect(sent[0].text.hasPrefix(ContextCompaction.preface + "EARLIER"))
        #expect(sent[0].text.hasSuffix(transcript[6].text))
        #expect(Array(sent.dropFirst()) == Array(transcript[7...]))
    }

    @Test func staleCompactionIsIgnored() async {
        let transcript = longTranscript(pairs: 4)
        var edited = transcript
        edited[2] = .user("a different question")
        let record = ContextCompaction(summary: "EARLIER", coveredMessages: 6,
                                       fingerprint: ContextCompaction.fingerprint(transcript[..<6]), model: "m")
        #expect(!record.applies(to: edited))
        #expect(!record.applies(to: Array(transcript.prefix(6))), "nothing left after the summary")
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("answer")])
        _ = await AgentLoop(provider: provider, tools: .empty)
            .run(transcript: edited, configuration: config(window: 200_000, compaction: record)).collect()
        #expect(provider.requests[0].messages == edited)
    }

    @Test func summaryBeforeAnAssistantTailIsItsOwnMessage() {
        let tail: [Message] = [Message(role: .assistant, parts: [.text("hi")]), .user("q")]
        let view = ContextCompaction.view(summary: "S", tail: tail[...])
        #expect(view.count == 3)
        #expect(view[0].role == .user && view[0].text.hasSuffix("S"))
        #expect(Array(view.dropFirst()) == tail)
    }

    @Test func fingerprintIgnoresMediaBytesAndPayloads() {
        let a = [Message(role: .user, parts: [.image(MediaData(mediaType: "image/png", data: Data([1, 2, 3]), name: "x.png")), .text("q")]),
                 Message(role: .assistant, parts: [.text("a")], raw: ProviderPayload(flavor: .anthropicMessages, data: Data("{}".utf8)))]
        var b = a
        b[0].parts[0] = .image(MediaData(mediaType: "image/png", data: Data("praxis-attachment:ref".utf8), name: "x.png"))
        b[1].raw = nil
        #expect(ContextCompaction.fingerprint(a) == ContextCompaction.fingerprint(b))
        var c = a
        c[0].parts[1] = .text("other")
        #expect(ContextCompaction.fingerprint(a) != ContextCompaction.fingerprint(c))
    }

    @Test func newerRecordsDontDecode() throws {
        let record = ContextCompaction(summary: "s", coveredMessages: 2, fingerprint: "f", model: "m")
        var json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(record)) as? [String: Any])
        #expect(try JSONDecoder().decode(ContextCompaction.self, from: JSONEncoder().encode(record)) == record)
        json["version"] = 99
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(ContextCompaction.self, from: JSONSerialization.data(withJSONObject: json))
        }
    }

    // MARK: Overflow

    @Test func overflowErrorCompactsAndRetriesOnce() async throws {
        let provider = ScriptedProvider(steps: [
            .failure(.http(status: 400, message: "prompt is too long: 21000 tokens > 20000 maximum", retryAfter: nil)),
            ScriptedProvider.text("SUMMARY"),
            ScriptedProvider.text("answer"),
        ])
        let transcript = longTranscript(pairs: 3)
        // Unknown window: the 128K fallback doesn't trigger the threshold.
        let events = await AgentLoop(provider: provider, tools: .empty)
            .run(transcript: transcript, configuration: config(window: nil)).collect()
        #expect(outcome(events) == .completed)
        #expect(compactions(events).first == .started(.overflow))
        #expect(provider.requests.count == 3)
        #expect(provider.requests[0].messages == transcript)
        #expect(provider.requests[2].messages.first?.text.contains("SUMMARY") == true)
        #expect(provider.requests[2].messages.count < transcript.count)
    }

    @Test func secondOverflowFailsTheRun() async {
        let tooLong = ProviderError.http(status: 400, message: "This model's maximum context length is 4096 tokens.", retryAfter: nil)
        let provider = ScriptedProvider(steps: [.failure(tooLong), ScriptedProvider.text("SUMMARY"), .failure(tooLong)])
        let events = await AgentLoop(provider: provider, tools: .empty)
            .run(transcript: longTranscript(pairs: 3), configuration: config(window: nil)).collect()
        guard case .failed(let reason)? = outcome(events) else { Issue.record("expected failure"); return }
        #expect(reason.contains("maximum context length"))
        #expect(provider.requests.count == 3)
    }

    @Test func contextWindowExceededStopDiscardsAndRetries() async {
        let cut = ScriptedProvider.Step.events([
            .textDelta(index: 0, text: "partial"),
            .completed(ProviderResponse(message: Message(role: .assistant, parts: [.text("partial")]),
                                        stopReason: .contextWindowExceeded, usage: Usage(inputTokens: 19_000))),
        ])
        let provider = ScriptedProvider(steps: [cut, ScriptedProvider.text("SUMMARY"), ScriptedProvider.text("full answer")])
        let events = await AgentLoop(provider: provider, tools: .empty)
            .run(transcript: longTranscript(pairs: 3), configuration: config(window: nil)).collect()
        #expect(outcome(events) == .completed)
        #expect(events.contains { if case .attemptDiscarded(let blocks, _) = $0 { return !blocks.isEmpty }; return false })
        let committed = events.flatMap { if case .committed(let m) = $0 { return m }; return [] }
        #expect(committed.map(\.text) == ["full answer"])
    }

    @Test func overflowErrorsAreRecognized() {
        let cases: [(ProviderError, Bool, Int?)] = [
            (.http(status: 400, message: "prompt is too long: 213000 tokens > 200000 maximum", retryAfter: nil), true, 200_000),
            (.http(status: 400, message: "This model's maximum context length is 128000 tokens. However, you requested 130000 tokens.", retryAfter: nil), true, 128_000),
            (.http(status: 400, message: "the request exceeds the available context size, try increasing it", retryAfter: nil), true, nil),
            (.http(status: 413, message: "Request Entity Too Large", retryAfter: nil), true, nil),
            (.stream(type: "invalid_request_error", message: "input is too long for requested model"), true, nil),
            (.http(status: 400, message: "max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens", retryAfter: nil), false, nil),
            (.http(status: 401, message: "context length", retryAfter: nil), false, nil),
            (.http(status: 529, message: "Overloaded", retryAfter: nil), false, nil),
        ]
        for (error, overflow, limit) in cases {
            #expect(error.isContextOverflow == overflow, "\(error)")
            if overflow { #expect(error.reportedContextLimit == limit, "\(error)") }
        }
    }

    @Test func renderingClipsLongPartsAndNamesMedia() {
        let message = Message(role: .user, parts: [
            .image(MediaData(mediaType: "image/png", data: Data(count: 10), name: "cat.png")),
            .toolResult(ToolResult(callID: "x1", toolName: "fetch", content: [.text(String(repeating: "z", count: 50_000))])),
        ])
        let text = ContextSummarizer.render(message, maxPartBytes: 10_000)
        #expect(text.contains("“cat.png”"))
        #expect(text.contains("id x1"))
        #expect(text.utf8.count < 4_000)
        let chunks = ContextSummarizer.chunks(longTranscript(pairs: 10)[...], maxBytes: 9_000)
        #expect(chunks.count > 1)
        #expect(chunks.allSatisfy { $0.utf8.count <= 9_000 })
    }
}

@Suite struct ScratchStoreTests {
    final class Folder {
        let url = FileManager.default.temporaryDirectory.appending(path: "scratch-\(UUID().uuidString)", directoryHint: .isDirectory)
        deinit { try? FileManager.default.removeItem(at: url) }
    }

    @Test func writesReadsAndRemovesPerConversation() throws {
        let folder = Folder()
        let store = ScratchStore(root: folder.url)
        try store.write(Data("a".utf8), conversationID: "c1", name: "x.txt")
        try store.write(Data("b".utf8), conversationID: "c2", name: "x.txt")
        #expect(store.read(conversationID: "c1", name: "x.txt") == Data("a".utf8))
        // A new instance (relaunch) sees the same files.
        let reopened = ScratchStore(root: folder.url)
        #expect(reopened.read(conversationID: "c2", name: "x.txt") == Data("b".utf8))
        #expect(reopened.totalBytes == 2)
        reopened.remove(conversationID: "c1")
        #expect(reopened.read(conversationID: "c1", name: "x.txt") == nil)
        #expect(!FileManager.default.fileExists(atPath: folder.url.appending(path: "c1").path))
        #expect(reopened.totalBytes == 1)
    }

    @Test func evictsLeastRecentlyUsedOverTheCap() throws {
        let folder = Folder()
        let store = ScratchStore(root: folder.url, maxTotalBytes: 2_500, maxFileBytes: 1_000)
        let kb = Data(count: 1_000)
        try store.write(kb, conversationID: "c1", name: "old")
        try store.write(kb, conversationID: "c2", name: "mid")
        _ = store.read(conversationID: "c1", name: "old") // now the most recent
        try store.write(kb, conversationID: "c1", name: "new")
        #expect(store.read(conversationID: "c2", name: "mid") == nil)
        #expect(store.read(conversationID: "c1", name: "old") != nil)
        #expect(store.read(conversationID: "c1", name: "new") != nil)
        #expect(store.totalBytes <= 2_500)
        #expect(throws: ScratchStore.StoreError.self) { try store.write(Data(count: 1_001), conversationID: "c1", name: "big") }
    }

    @Test func namesCantEscapeTheRoot() throws {
        let folder = Folder()
        let store = ScratchStore(root: folder.url)
        #expect(throws: ScratchStore.StoreError.self) { try store.write(Data(), conversationID: "c1", name: "../x") }
        #expect(throws: ScratchStore.StoreError.self) { try store.write(Data(), conversationID: "c1", name: "..") }
        try store.write(Data("v".utf8), conversationID: "../../etc", name: "x")
        let dirs = try FileManager.default.contentsOfDirectory(atPath: folder.url.path)
        #expect(dirs.count == 1 && dirs[0].hasPrefix("h-"))
        #expect(store.read(conversationID: "../../etc", name: "x") == Data("v".utf8))
    }

    @Test func prunesConversationsThatAreGone() throws {
        let folder = Folder()
        let store = ScratchStore(root: folder.url)
        try store.write(Data("a".utf8), conversationID: "keep", name: "x")
        try store.write(Data("b".utf8), conversationID: "gone", name: "x")
        store.removeAll(except: ["keep"])
        #expect(store.read(conversationID: "keep", name: "x") != nil)
        #expect(store.read(conversationID: "gone", name: "x") == nil)
    }

    @Test func spillsSurviveARelaunch() async throws {
        let folder = Folder()
        let text = String(repeating: "0123456789", count: 10_000)
        let first = OutputSpill(store: ScratchStore(root: folder.url), conversationID: "c1")
        await first.store(id: "toolu_01/abc", text: text)

        let relaunched = OutputSpill(store: ScratchStore(root: folder.url), conversationID: "c1")
        #expect(await relaunched.length(id: "toolu_01/abc") == text.count)
        #expect(await relaunched.read(id: "toolu_01/abc", offset: 99_990, limit: 50) == "0123456789")
        let tool = ReadToolOutputTool(spill: relaunched)
        let out = try await tool.execute(ToolInvocation(id: "r", name: "read_tool_output", arguments: ["id": "toolu_01/abc", "offset": 10, "limit": 5]),
                                         context: ToolContext(conversationID: "c1", mode: .auto))
        #expect(out.text.hasSuffix("01234"))
        let other = OutputSpill(store: ScratchStore(root: folder.url), conversationID: "c2")
        #expect(await other.length(id: "toolu_01/abc") == nil)
    }
}

@Suite struct VirtualPathTests {
    @Test func acceptsPlainNamesOnly() throws {
        #expect(try VirtualPath.validate("report (2).pdf") == "report (2).pdf")
        #expect(try VirtualPath.validate("a..b.txt") == "a..b.txt")
        for bad in ["", ".", "..", "../x", "/etc/passwd", "~/x", "dir/file.txt", "a\\b", "x\u{0}y", String(repeating: "a", count: 256)] {
            #expect(throws: VirtualPath.Invalid.self, "\(bad)") { try VirtualPath.validate(bad) }
        }
    }
}

/// The measured prompt size carried from one run to the next.
@Suite struct ContextMeasurementTests {
    private func run(_ transcript: [Message], measurement: ContextMeasurement?, model: String = "m",
                     compaction: ContextCompaction? = nil,
                     steps: [ScriptedProvider.Step] = [ScriptedProvider.text("SUMMARY"), ScriptedProvider.text("answer")])
        async -> (events: [AgentEvent], provider: ScriptedProvider) {
        let provider = ScriptedProvider(steps: steps)
        let configuration = AgentRunConfiguration(conversationID: "c1", model: model, system: "sys", effort: .low,
                                                  context: ContextPolicy(contextWindow: 30_000),
                                                  compaction: compaction, measurement: measurement)
        let events = await AgentLoop(provider: provider, tools: .empty, sleep: noSleep)
            .run(transcript: transcript, configuration: configuration).collect()
        return (events, provider)
    }

    /// The previous run's request carried the first 7 messages and was
    /// reported far larger than its text suggests (images, tool schemas…).
    private func measured(_ transcript: [Message], tokens: Int = 20_000, model: String = "m") -> ContextMeasurement {
        ContextMeasurement(model: model, messageCount: 7, fingerprint: ContextCompaction.fingerprint(transcript[..<7]),
                           compactedMessages: 0, promptTokens: tokens)
    }

    @Test func measuredSizeBudgetsTheFirstRequest() async {
        let transcript = longTranscript(pairs: 4) // ~8K estimated: under the 16.5K threshold on its own
        let estimated = await run(transcript, measurement: nil, steps: [ScriptedProvider.text("answer")])
        #expect(compactions(estimated.events).isEmpty)

        // 20K measured + the two newer messages crosses it: compact first.
        let calibrated = await run(transcript, measurement: measured(transcript))
        #expect(compactions(calibrated.events).first == .started(.threshold))
        #expect(finished(calibrated.events).count == 1)
        #expect(outcome(calibrated.events) == .completed)
    }

    @Test func staleMeasurementsAreIgnored() async {
        let transcript = longTranscript(pairs: 4)
        var edited = transcript
        edited[2] = .user("a different question")
        let m = measured(transcript)
        #expect(m.applies(to: transcript, model: "m", compactedMessages: 0))
        #expect(!m.applies(to: edited, model: "m", compactedMessages: 0), "the measured prefix was edited")
        #expect(!m.applies(to: Array(transcript.prefix(6)), model: "m", compactedMessages: 0), "retry cut into it")
        #expect(!m.applies(to: transcript, model: "other", compactedMessages: 0), "another model counts differently")
        #expect(!m.applies(to: transcript, model: "m", compactedMessages: 4), "taken through another compaction")

        for (messages, model) in [(edited, "m"), (transcript, "other")] {
            let r = await run(messages, measurement: m, model: model, steps: [ScriptedProvider.text("answer")])
            #expect(compactions(r.events).isEmpty)
        }
    }

    @Test func runsReportWhatTheProviderMeasured() async throws {
        let transcript = longTranscript(pairs: 1)
        let usage = Usage(inputTokens: 1_200, outputTokens: 40, cacheReadTokens: 3_000, cacheWriteTokens: 300)
        let r = await run(transcript, measurement: nil, steps: [ScriptedProvider.text("answer", usage: usage)])
        let reported = r.events.compactMap { if case .contextMeasured(let m) = $0 { return m }; return nil }
        let m = try #require(reported.last)
        #expect(m.promptTokens == 4_500)
        #expect(m.messageCount == transcript.count)
        #expect(m.compactedMessages == 0)
        #expect(m.model == "m")
        // It describes the transcript the next run sees (this one + the answer + a new question).
        let next = transcript + [Message(role: .assistant, parts: [.text("answer")]), .user("more")]
        #expect(m.applies(to: next, model: "m", compactedMessages: 0))
    }

    @Test func roundTripsAndRefusesNewerVersions() throws {
        let m = ContextMeasurement(model: "m", messageCount: 3, fingerprint: "f", compactedMessages: 1, promptTokens: 99,
                                   measuredAt: Date(timeIntervalSince1970: 1_000))
        #expect(try JSONDecoder().decode(ContextMeasurement.self, from: JSONEncoder().encode(m)) == m)
        var json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(m)) as? [String: Any])
        json["version"] = 7
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(ContextMeasurement.self, from: JSONSerialization.data(withJSONObject: json))
        }
    }
}
