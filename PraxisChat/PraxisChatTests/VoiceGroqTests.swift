import XCTest
import Synchronization
import AgentCore
import AgentProviders
import AgentMCP
import AgentTestSupport
@testable import PraxisChat

/// Voice-groq (VOICE_PLAN §9): model-list STT filter + manual fallback,
/// silence-boundary scan, stitch joining/overlap strip, error mapping incl.
/// 413-halving and retry-after, queue resume, and the consent branch.
/// Network behaviour is scripted (`ScriptedTransport`); there is no Groq key
/// here and none is requested.
@MainActor
final class VoiceGroqTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!
    private var stores: [ChatStore] = []

    override func setUp() async throws {
        directory = temporaryDirectory()
        secrets = InMemorySecretStore()
    }

    override func tearDown() async throws {
        for store in stores { await store.settle() }
        stores = []
        try? FileManager.default.removeItem(at: directory)
    }

    // MARK: Fakes

    /// Scriptable network: tests flip `usable` from another task.
    actor FakeNetwork: NetworkStatusReader {
        var usable: Bool
        var waitCalls = 0
        init(usable: Bool) { self.usable = usable }
        func isUsable() async -> Bool { usable }
        func waitForUsable() async throws {
            waitCalls += 1
            for _ in 0..<2000 {
                if usable { return }
                try await Task.sleep(for: .milliseconds(2))
            }
            XCTFail("waitForUsable timed out")
        }
    }

    final class SleepRecorder: Sendable {
        private let delays = Mutex<[TimeInterval]>([])
        func sleep(_ duration: Duration) async throws {
            delays.withLock { $0.append(duration.timeInterval) }
        }
        var all: [TimeInterval] { delays.withLock { $0 } }
    }

    final class Counter: Sendable {
        private let value = Mutex(0)
        func next() -> Int { value.withLock { $0 += 1; return $0 } }
        var count: Int { value.withLock { $0 } }
    }

    // MARK: Model list (STT filter, default, manual fallback)

    func testSpeechModelFilterKeepsWhisperIDs() {
        let models = [ModelInfo(id: "whisper-large-v3-turbo"), ModelInfo(id: "whisper-large-v3"),
                      ModelInfo(id: "llama-3.3-70b-versatile"), ModelInfo(id: "openai/gpt-oss-120b"),
                      ModelInfo(id: "WHISPER-FUTURE-X")]
        let ids = GroqVoiceSettings.speechModels(from: models).map(\.id)
        XCTAssertEqual(ids, ["whisper-large-v3-turbo", "whisper-large-v3", "WHISPER-FUTURE-X"])
    }

    func testDefaultModelPrefersTurboThenFirst() {
        XCTAssertEqual(GroqVoiceSettings.defaultModel(from: ["whisper-large-v3", "whisper-large-v3-turbo"]),
                       "whisper-large-v3-turbo")
        XCTAssertEqual(GroqVoiceSettings.defaultModel(from: ["whisper-large-v3"]), "whisper-large-v3")
        XCTAssertNil(GroqVoiceSettings.defaultModel(from: []))
    }

    func testSelectedModelOutsideListStaysSelectable() {
        let settings = GroqVoiceSettings(fileURL: nil, secrets: secrets)
        settings.selectModel("future-stt-model")
        XCTAssertTrue(settings.displayModels.contains("future-stt-model"))
        XCTAssertEqual(settings.selectedModelID, "future-stt-model")
    }

    func testRefreshModelsCachesFilteredList() async {
        let transport = ScriptedTransport(replies: [.json(#"{"data":[{"id":"whisper-large-v3-turbo"},{"id":"whisper-large-v3"},{"id":"llama-3.3-70b-versatile"}]}"#)])
        let file = directory.appendingPathComponent("voice-settings.json")
        let settings = GroqVoiceSettings(fileURL: file, secrets: secrets, transport: transport)
        settings.saveKey("gsk-test")
        await settings.refreshModels()
        XCTAssertEqual(settings.cachedModels, ["whisper-large-v3", "whisper-large-v3-turbo"])
        XCTAssertNotNil(settings.modelsFetchedAt)
        XCTAssertNil(settings.lastRefreshError)
        // Persisted: a fresh instance reads the same state (key via store).
        let reloaded = GroqVoiceSettings(fileURL: file, secrets: secrets)
        XCTAssertEqual(reloaded.cachedModels, settings.cachedModels)
        XCTAssertEqual(reloaded.selectedModelID, settings.selectedModelID)
        XCTAssertTrue(reloaded.isConfigured)
        // The key went to the Keychain store, never the JSON.
        let json = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
        XCTAssertFalse(json.contains("gsk-test"))
    }

    func testRefreshModels401KeepsKey() async {
        let transport = ScriptedTransport(replies: [.json(#"{"error":{"message":"invalid_api_key"}}"#, status: 401)])
        let settings = GroqVoiceSettings(fileURL: nil, secrets: secrets, transport: transport)
        settings.saveKey("gsk-wrong")
        await settings.refreshModels()
        XCTAssertEqual(settings.lastRefreshError, "Check your Groq API key.")
        XCTAssertTrue(settings.hasKey)
        XCTAssertEqual(try? secrets.secret(for: GroqVoiceSettings.keychainAccount), "gsk-wrong")
    }

    func testKeyAndLanguageRoundTrip() {
        let file = directory.appendingPathComponent("voice-settings.json")
        let settings = GroqVoiceSettings(fileURL: file, secrets: secrets)
        XCTAssertFalse(settings.isConfigured)
        settings.saveKey("  gsk-abc  ")
        XCTAssertTrue(settings.isConfigured)
        XCTAssertEqual(try? secrets.secret(for: GroqVoiceSettings.keychainAccount), "gsk-abc")
        settings.setLanguage("es")
        settings.selectModel("whisper-large-v3")
        let reloaded = GroqVoiceSettings(fileURL: file, secrets: secrets)
        XCTAssertEqual(reloaded.language, "es")
        XCTAssertEqual(reloaded.selectedModelID, "whisper-large-v3")
        settings.removeKey()
        XCTAssertFalse(settings.isConfigured)
    }

    // MARK: Error mapping

    func testMapGroqError() {
        guard case .unauthorized = mapGroqError(status: 401) else { return XCTFail("401") }
        guard case .tooLarge = mapGroqError(status: 413) else { return XCTFail("413") }
        guard case .rateLimited(let after) = mapGroqError(status: 429, retryAfter: 7) else { return XCTFail("429") }
        XCTAssertEqual(after, 7)
        guard case .server(let message) = mapGroqError(status: 500, message: "boom") else { return XCTFail("500") }
        XCTAssertEqual(message, "boom")
        guard case .server = mapGroqError(status: 400) else { return XCTFail("400") }
    }

    func testRetryAfterHeaderParsing() {
        XCTAssertEqual(HTTPResponseHead(status: 429, headers: ["retry-after": "2"]).retryAfter?.timeInterval, 2)
        XCTAssertEqual(HTTPResponseHead(status: 429, headers: ["retry-after-ms": "1500"]).retryAfter?.timeInterval, 1.5)
        XCTAssertNil(HTTPResponseHead(status: 429, headers: ["retry-after": "soon"]).retryAfter)
        // Capped at 60 s so a huge value can't stall the queue.
        XCTAssertEqual(HTTPResponseHead(status: 429, headers: ["retry-after": "9999"]).retryAfter?.timeInterval, 60)
    }

    func testBackoffDelay() {
        XCTAssertEqual(TranscriptionQueue.backoffDelay(attempt: 1, retryAfter: nil), 1)
        XCTAssertEqual(TranscriptionQueue.backoffDelay(attempt: 2, retryAfter: nil), 2)
        XCTAssertEqual(TranscriptionQueue.backoffDelay(attempt: 3, retryAfter: nil), 4)
        XCTAssertEqual(TranscriptionQueue.backoffDelay(attempt: 9, retryAfter: nil), 60)
        // The server's retry-after wins over the curve.
        XCTAssertEqual(TranscriptionQueue.backoffDelay(attempt: 1, retryAfter: 12), 12)
        XCTAssertEqual(TranscriptionQueue.backoffDelay(attempt: 1, retryAfter: 999), 60)
    }

    // MARK: Queue (retry, backoff, offline, resume)

    func testQueueRetries429ThenSucceeds() async throws {
        let sleep = SleepRecorder()
        let events = Mutex<[TranscriptionQueue.QueueEvent]>([])
        let queue = TranscriptionQueue(network: FakeNetwork(usable: true), sleep: sleep.sleep)
        let calls = Counter()
        let result = try await queue.run({
            if calls.next() < 3 { throw VoiceTranscriptionError.rateLimited(retryAfter: nil) }
            return "done"
        }, onEvent: { event in events.withLock { $0.append(event) } })
        XCTAssertEqual(result, "done")
        XCTAssertEqual(calls.count, 3)
        XCTAssertEqual(sleep.all, [1, 2])
        XCTAssertEqual(events.withLock { $0 },
                       [.retrying(attempt: 1, after: 1), .retrying(attempt: 2, after: 2)])
    }

    func testQueueHonoursRetryAfter() async {
        let sleep = SleepRecorder()
        let queue = TranscriptionQueue(network: FakeNetwork(usable: true), sleep: sleep.sleep)
        let calls = Counter()
        do {
            _ = try await queue.run({
                _ = calls.next()
                throw VoiceTranscriptionError.rateLimited(retryAfter: 9)
            } as @Sendable () async throws -> Void)
            XCTFail("should throw after max attempts")
        } catch let error as VoiceTranscriptionError {
            guard case .rateLimited(let after) = error else { return XCTFail("wrong error \(error)") }
            XCTAssertEqual(after, 9)
        } catch {
            XCTFail("wrong error \(error)")
        }
        XCTAssertEqual(calls.count, TranscriptionQueue.maxAttempts)
        XCTAssertTrue(sleep.all.allSatisfy { $0 == 9 })
    }

    func testQueueGivesUpAfterMaxAttempts() async {
        let sleep = SleepRecorder()
        let queue = TranscriptionQueue(network: FakeNetwork(usable: true), sleep: sleep.sleep)
        let calls = Counter()
        do {
            _ = try await queue.run({
                _ = calls.next()
                throw VoiceTranscriptionError.server(message: "5xx")
            } as @Sendable () async throws -> Void)
            XCTFail("should throw")
        } catch let error as VoiceTranscriptionError {
            guard case .server = error else { return XCTFail("wrong error \(error)") }
        } catch {
            XCTFail("wrong error \(error)")
        }
        XCTAssertEqual(calls.count, TranscriptionQueue.maxAttempts)
        XCTAssertEqual(sleep.all, [1, 2, 4, 8])
    }

    func testQueuePassesThroughAuthAndSizeErrors() async {
        for error in [VoiceTranscriptionError.unauthorized, .tooLarge, .missingKey,
                      .consentRequired(host: "h"), .cancelled] {
            let sleep = SleepRecorder()
            let queue = TranscriptionQueue(network: FakeNetwork(usable: true), sleep: sleep.sleep)
            let calls = Counter()
            do {
                _ = try await queue.run({
                    _ = calls.next()
                    throw error
                } as @Sendable () async throws -> Void)
                XCTFail("should rethrow \(error)")
            } catch let thrown as VoiceTranscriptionError {
                XCTAssertEqual(String(describing: thrown), String(describing: error))
            } catch {
                XCTFail("wrong error \(error)")
            }
            XCTAssertEqual(calls.count, 1, "\(error) must not retry")
            XCTAssertTrue(sleep.all.isEmpty)
        }
    }

    func testQueueWaitsForNetworkWithoutConsumingAttempts() async throws {
        let network = FakeNetwork(usable: false)
        let sleep = SleepRecorder()
        let events = Mutex<[TranscriptionQueue.QueueEvent]>([])
        let queue = TranscriptionQueue(network: network, sleep: sleep.sleep)
        let calls = Counter()
        // The network comes back mid-wait.
        Task {
            try? await Task.sleep(for: .milliseconds(30))
            await network.setUsable()
        }
        let result = try await queue.run({
            if calls.next() == 1 { throw VoiceTranscriptionError.offline }
            return "resumed"
        }, onEvent: { event in events.withLock { $0.append(event) } })
        XCTAssertEqual(result, "resumed")
        XCTAssertEqual(calls.count, 2)
        XCTAssertTrue(sleep.all.isEmpty, "offline waits don't back off")
        XCTAssertEqual(events.withLock { $0 }, [.waitingForNetwork])
    }

    func testQueueTreatsOfflineWithUsableNetworkAsTransient() async throws {
        let sleep = SleepRecorder()
        let queue = TranscriptionQueue(network: FakeNetwork(usable: true), sleep: sleep.sleep)
        let calls = Counter()
        let result = try await queue.run({
            if calls.next() < 3 { throw VoiceTranscriptionError.offline }
            return "ok"
        })
        XCTAssertEqual(result, "ok")
        XCTAssertEqual(sleep.all, [1, 2])
    }

    // MARK: Segmentation (boundary scan, stitch, prompt tail)

    func testEnergiesRMS() {
        let one = AudioSegmenter.energies(samples: [1, -1, 1, -1], windowSize: 4)
        XCTAssertEqual(one.count, 1)
        XCTAssertTrue(abs(one[0] - 1) < 1e-5)
        XCTAssertEqual(AudioSegmenter.energies(samples: [0, 0, 0, 0], windowSize: 2), [0, 0])
        XCTAssertTrue(AudioSegmenter.energies(samples: [], windowSize: 4).isEmpty)
    }

    func testBestBoundaryFindsSilence() {
        // Loud, quiet gap, loud: 0.5 s windows, nominal at 300 s.
        var energies = [Float](repeating: 0.8, count: 700)
        for i in 590..<610 { energies[i] = 0.01 }
        let found = AudioSegmenter.bestBoundary(energies: energies, windowDuration: 0.5, nominal: 300,
                                                searchRadius: 30, limits: 60..<600)
        XCTAssertTrue((294.0...306.0).contains(found), "got \(found)")
    }

    func testBestBoundaryFallsBackToNominal() {
        XCTAssertEqual(AudioSegmenter.bestBoundary(energies: [], windowDuration: 0.5, nominal: 300,
                                                   searchRadius: 30, limits: 60..<600), 300)
        // Nothing in range: clamped nominal.
        XCTAssertEqual(AudioSegmenter.bestBoundary(energies: [0.5], windowDuration: 0.5, nominal: 590,
                                                   searchRadius: 1, limits: 60..<600), 590, accuracy: 0.01)
    }

    func testNominalPartDuration() {
        XCTAssertEqual(AudioSegmenter.nominalPartDuration(fileBytes: 1 << 20, duration: 3600), 600)
        // Dense file: 10 min would exceed 20 MB, so shrink (100 MB in 30 min → 6 min parts).
        XCTAssertEqual(AudioSegmenter.nominalPartDuration(fileBytes: 100 << 20, duration: 1800), 360, accuracy: 5)
        // Absurd density floors at 1 min parts (413-halving takes it further).
        XCTAssertEqual(AudioSegmenter.nominalPartDuration(fileBytes: 2 << 30, duration: 3600), 60, accuracy: 5)
    }

    func testStitchStripsOverlapAndJoins() {
        let a = PartTranscript(text: "Hello world", language: "en", segments: [
            .init(start: 0, end: 4, text: "Hello"),
            .init(start: 4, end: 9, text: "world"),
        ])
        let b = PartTranscript(text: "world again today", language: "en", segments: [
            .init(start: 4, end: 9, text: "world"), // fully inside the overlap window: dropped
            .init(start: 9, end: 14, text: "again"),
            .init(start: 14, end: 15, text: "today."),
        ])
        let stitched = AudioSegmenter.stitch([a, b], overlaps: [nil, 9])
        XCTAssertEqual(stitched.text, "Hello world again today.")
        XCTAssertEqual(stitched.language, "en")
        XCTAssertEqual(stitched.segments.map(\.text), ["Hello", "world", "again", "today."])
    }

    func testStitchGluesPunctuation() {
        XCTAssertEqual(AudioSegmenter.join(["Hello", "world", ".", "Again", "!"]), "Hello world. Again!")
        XCTAssertEqual(AudioSegmenter.join(["  padded  ", "", "  words "]), "padded words")
        XCTAssertEqual(AudioSegmenter.join([]), "")
    }

    func testPromptTail() {
        XCTAssertEqual(AudioSegmenter.promptTail("short"), "short")
        let long = String(repeating: "word ", count: 300)
        let tail = AudioSegmenter.promptTail(long)
        XCTAssertTrue(tail.count <= 800)
        XCTAssertTrue(tail.hasPrefix("word"))
        XCTAssertFalse(tail.hasPrefix(" "))
    }

    // MARK: Part cache (resume)

    private func samplePlan() -> SegmentationPlan {
        SegmentationPlan(parts: [.init(audioRange: 0..<600), .init(audioRange: 595..<900)],
                         overlapEnds: [nil, 600], duration: 900)
    }

    func testPartCacheRoundTripAndMismatch() {
        let cache = PartTranscriptCache(directory: directory.appendingPathComponent("parts"))
        let plan = samplePlan()
        let part = PartTranscript(text: "hello", language: "en",
                                  segments: [.init(start: 0, end: 1, text: "hello")])
        cache.store(part, plan: plan, fileName: "r.m4a", index: 0)
        let loaded = cache.load(matching: plan, fileName: "r.m4a")
        XCTAssertEqual(loaded.count, 2)
        XCTAssertEqual(loaded[0]?.text, "hello")
        XCTAssertNil(loaded[1])
        // A different plan (re-recorded file) invalidates everything.
        let other = SegmentationPlan(parts: [.init(audioRange: 0..<900)], overlapEnds: [nil], duration: 900)
        XCTAssertTrue(cache.load(matching: other, fileName: "r.m4a").allSatisfy { $0 == nil })
        cache.clear(fileName: "r.m4a")
        XCTAssertTrue(cache.load(matching: plan, fileName: "r.m4a").allSatisfy { $0 == nil })
    }

    /// Review fix F5: clear removes cached transcripts (instance and the
    /// static entry `RecordingStore.delete` uses). The protection class
    /// itself is pinned at the source level in DataProtectionAppTests: the
    /// simulator doesn't record protection attributes.
    func testPartCacheClearRemovesFiles() {
        let dir = directory.appendingPathComponent("parts")
        let cache = PartTranscriptCache(directory: dir)
        cache.store(PartTranscript(text: "x", language: nil, segments: []),
                    plan: samplePlan(), fileName: "r.m4a", index: 0)
        let partURL = dir.appendingPathComponent("r.m4a.part0.json")
        XCTAssertTrue(FileManager.default.fileExists(atPath: partURL.path))
        cache.clear(fileName: "r.m4a")
        XCTAssertFalse(FileManager.default.fileExists(atPath: partURL.path))
        cache.store(PartTranscript(text: "x", language: nil, segments: []),
                    plan: samplePlan(), fileName: "r.m4a", index: 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: partURL.path))
        PartTranscriptCache.clearSharedCache(fileName: "r.m4a", in: dir)
        XCTAssertFalse(FileManager.default.fileExists(atPath: partURL.path))
    }

    // MARK: Wire format

    func testMultipartBodyFields() {
        let transcriber = GroqTranscriber(transport: ScriptedTransport(replies: []), secrets: secrets,
                                          modelID: "whisper-large-v3-turbo", language: "es", consentGranted: true)
        let body = transcriber.multipartBody(audio: Data("fake-audio".utf8), fileName: "abc.m4a",
                                             model: "whisper-large-v3-turbo", language: "es", prompt: "tail")
        let text = String(decoding: body.data, as: UTF8.self)
        XCTAssertTrue(text.contains("name=\"file\"; filename=\"abc.m4a\""))
        XCTAssertTrue(text.contains("name=\"model\""))
        XCTAssertTrue(text.contains("whisper-large-v3-turbo"))
        XCTAssertTrue(text.contains("name=\"response_format\""))
        XCTAssertTrue(text.contains("verbose_json"))
        XCTAssertTrue(text.contains("name=\"timestamp_granularities[]\""))
        XCTAssertTrue(text.contains("segment"))
        XCTAssertTrue(text.contains("name=\"language\""))
        XCTAssertTrue(text.contains("name=\"prompt\""))
        XCTAssertTrue(text.hasSuffix("--\(body.boundary)--\r\n"))
    }

    func testVerboseJSONParsing() throws {
        let part = try PartTranscript(verboseJSON: Data(Self.verboseJSON.utf8))
        XCTAssertEqual(part.text, "hello world")
        XCTAssertEqual(part.language, "en")
        XCTAssertEqual(part.segments.map(\.text), ["hello", "world"])
        XCTAssertEqual(part.segments[1].start, 1.0)
        let bare = try PartTranscript(verboseJSON: Data(#"{"text":"  hi  "}"#.utf8))
        XCTAssertEqual(bare.text, "hi")
        XCTAssertTrue(bare.segments.isEmpty)
        XCTAssertThrowsError(try PartTranscript(verboseJSON: Data("nope".utf8)))
    }

    // MARK: Transcribe end to end (scripted transport, real file)

    nonisolated static let verboseJSON = #"{"text":"hello world","language":"en","duration":2.0,"segments":[{"id":0,"start":0.0,"end":1.0,"text":"hello"},{"id":1,"start":1.0,"end":2.0,"text":"world"}]}"#

    /// A real 2 s WAV (hand-written header): exercises plan → export →
    /// upload → stitch against `ScriptedTransport`. The upload still uses
    /// the `.m4a` file name Groq expects.
    private func writeWAV(seconds: Int = 2) throws -> URL {
        let sampleRate = 16000
        let count = seconds * sampleRate
        var data = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: "RIFF".utf8); u32(UInt32(36 + count * 2)); data.append(contentsOf: "WAVE".utf8)
        data.append(contentsOf: "fmt ".utf8); u32(16); u16(1); u16(1); u32(UInt32(sampleRate))
        u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        data.append(contentsOf: "data".utf8); u32(UInt32(count * 2))
        data.append(contentsOf: [UInt8](repeating: 0, count: count * 2))
        let url = directory.appendingPathComponent("\(UUID().uuidString).wav")
        try data.write(to: url)
        return url
    }

    private func transcriber(transport: ScriptedTransport, consentGranted: Bool = true,
                             key: String? = "gsk-test", sleep: SleepRecorder? = nil) -> GroqTranscriber {
        if let key { try? secrets.setSecret(key, for: GroqVoiceSettings.keychainAccount) }
        return GroqTranscriber(transport: transport, secrets: secrets, modelID: "whisper-large-v3-turbo",
                               consentGranted: consentGranted,
                               queue: TranscriptionQueue(network: FakeNetwork(usable: true),
                                                         sleep: (sleep ?? SleepRecorder()).sleep),
                               partCache: PartTranscriptCache(directory: directory.appendingPathComponent("parts")))
    }

    func testTranscribeThrowsConsentRequiredAndMissingKey() async {
        let file = try! writeWAV()
        do {
            _ = try await transcriber(transport: ScriptedTransport(replies: []), consentGranted: false)
                .transcribe(file: file, fileName: "r.m4a") { _, _, _ in }
            XCTFail("consent must be required")
        } catch let error as VoiceTranscriptionError {
            guard case .consentRequired(let host) = error else { return XCTFail("wrong error \(error)") }
            XCTAssertEqual(host, "api.groq.com")
        } catch {
            XCTFail("wrong error \(error)")
        }
        try? secrets.removeSecret(for: GroqVoiceSettings.keychainAccount)
        do {
            _ = try await transcriber(transport: ScriptedTransport(replies: []), key: nil)
                .transcribe(file: file, fileName: "r.m4a") { _, _, _ in }
            XCTFail("key must be required")
        } catch let error as VoiceTranscriptionError {
            guard case .missingKey = error else { return XCTFail("wrong error \(error)") }
        } catch {
            XCTFail("wrong error \(error)")
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "failures keep the audio")
    }

    func testTranscribeFullPipeline() async throws {
        let file = try writeWAV()
        let transport = ScriptedTransport(replies: [.json(Self.verboseJSON)])
        let progress = Mutex<[(Double, Int, Int)]>([])
        let transcript = try await transcriber(transport: transport)
            .transcribe(file: file, fileName: "rec.m4a") { f, i, n in progress.withLock { $0.append((f, i, n)) } }
        XCTAssertEqual(transcript.text, "hello world")
        XCTAssertEqual(transcript.language, "en")
        XCTAssertEqual(transcript.segments.count, 2)
        XCTAssertEqual(transport.requests.count, 1)
        let sent = transport.requests[0]
        XCTAssertEqual(sent.url?.absoluteString, "https://api.groq.com/openai/v1/audio/transcriptions")
        XCTAssertEqual(sent.method, "POST")
        let auth = sent.headers.first { $0.key.lowercased() == "authorization" }?.value
        XCTAssertTrue(auth?.hasPrefix("Bearer ") == true)
        let body = String(decoding: sent.body ?? Data(), as: UTF8.self)
        XCTAssertTrue(body.contains("whisper-large-v3-turbo"))
        XCTAssertTrue(body.contains("verbose_json"))
        XCTAssertEqual(progress.withLock { $0.count }, 1)
        XCTAssertEqual(progress.withLock { $0[0].0 }, 1.0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    }

    func testTranscribeResumesFromCacheWithoutReuploading() async throws {
        let file = try writeWAV()
        let cache = PartTranscriptCache(directory: directory.appendingPathComponent("parts"))
        let plan = try await AudioSegmenter.plan(file: file)
        XCTAssertEqual(plan.parts.count, 1)
        cache.store(PartTranscript(text: "cached words", language: "en", segments: []),
                    plan: plan, fileName: "rec.m4a", index: 0)
        let transport = ScriptedTransport(replies: [.json(Self.verboseJSON)])
        try? secrets.setSecret("gsk-test", for: GroqVoiceSettings.keychainAccount)
        let transcriber = GroqTranscriber(transport: transport, secrets: secrets, modelID: "whisper-large-v3-turbo",
                                          consentGranted: true,
                                          queue: TranscriptionQueue(network: FakeNetwork(usable: true),
                                                                    sleep: SleepRecorder().sleep),
                                          partCache: cache)
        let transcript = try await transcriber.transcribe(file: file, fileName: "rec.m4a") { _, _, _ in }
        XCTAssertEqual(transcript.text, "cached words")
        XCTAssertTrue(transport.requests.isEmpty, "resumed parts are not re-uploaded")
    }

    func testTranscribe401And413() async {
        let file = try! writeWAV()
        let unauth = ScriptedTransport(replies: [
            .json(#"{"error":{"message":"invalid_api_key"}}"#, status: 401),
        ])
        do {
            _ = try await transcriber(transport: unauth).transcribe(file: file, fileName: "r.m4a") { _, _, _ in }
            XCTFail("401 must throw")
        } catch let error as VoiceTranscriptionError {
            guard case .unauthorized = error else { return XCTFail("wrong error \(error)") }
        } catch {
            return XCTFail("wrong error \(error)")
        }
        XCTAssertEqual(unauth.requests.count, 1, "401 never retries")
        // A 2 s part is below the halving floor: 413 surfaces as .tooLarge.
        let large = ScriptedTransport(replies: [
            .json(#"{"error":{"message":"too big"}}"#, status: 413),
        ])
        do {
            _ = try await transcriber(transport: large).transcribe(file: file, fileName: "r.m4a") { _, _, _ in }
            XCTFail("413 must throw")
        } catch let error as VoiceTranscriptionError {
            guard case .tooLarge = error else { return XCTFail("wrong error \(error)") }
        } catch {
            return XCTFail("wrong error \(error)")
        }
        XCTAssertEqual(large.requests.count, 1, "413 below the floor never retries")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "failures keep the audio")
        XCTAssertEqual(try? secrets.secret(for: GroqVoiceSettings.keychainAccount), "gsk-test",
                       "a 401 never clears the key")
    }

    /// Review fix F3: a real 429 must flow through the retry queue (honour
    /// retry-after), not fail past it.
    func testTranscribeRetries429ThenSucceeds() async throws {
        let file = try writeWAV()
        let sleep = SleepRecorder()
        let transport = ScriptedTransport(replies: [
            .json(#"{"error":{"message":"rate limited"}}"#, status: 429, headers: ["retry-after": "3"]),
            .json(Self.verboseJSON),
        ])
        let transcript = try await transcriber(transport: transport, sleep: sleep)
            .transcribe(file: file, fileName: "r.m4a") { _, _, _ in }
        XCTAssertEqual(transcript.text, "hello world")
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(sleep.all, [3])
    }

    func testTranscribeGivesUpAfterMax429s() async {
        let file = try! writeWAV()
        let sleep = SleepRecorder()
        let transport = ScriptedTransport(replies: Array(repeating:
            .json(#"{"error":{"message":"slow down"}}"#, status: 429), count: 6))
        do {
            _ = try await transcriber(transport: transport, sleep: sleep)
                .transcribe(file: file, fileName: "r.m4a") { _, _, _ in }
            XCTFail("sustained 429 must throw")
        } catch let error as VoiceTranscriptionError {
            guard case .rateLimited = error else { return XCTFail("wrong error \(error)") }
        } catch {
            return XCTFail("wrong error \(error)")
        }
        XCTAssertEqual(transport.requests.count, TranscriptionQueue.maxAttempts)
        XCTAssertEqual(sleep.all, [1, 2, 4, 8])
    }

    /// Review fix F4: the queue's offline wait surfaces as
    /// `.waitingForNetwork` on the transcriber's event handler.
    func testTranscribeForwardsWaitingForNetwork() async throws {
        let file = try writeWAV()
        let network = FakeNetwork(usable: false)
        let events = Mutex<[TranscriptionEvent]>([])
        let transport = ScriptedTransport { _, n in
            if n == 0 { throw ProviderError.network("offline") }
            return .json(Self.verboseJSON)
        }
        try? secrets.setSecret("gsk-test", for: GroqVoiceSettings.keychainAccount)
        let transcriber = GroqTranscriber(transport: transport, secrets: secrets, modelID: "whisper-large-v3-turbo",
                                          consentGranted: true,
                                          queue: TranscriptionQueue(network: network, sleep: SleepRecorder().sleep),
                                          partCache: PartTranscriptCache(directory: directory.appendingPathComponent("parts")),
                                          onEvent: { event in events.withLock { $0.append(event) } })
        Task {
            try? await Task.sleep(for: .milliseconds(30))
            await network.setUsable()
        }
        let transcript = try await transcriber.transcribe(file: file, fileName: "r.m4a") { _, _, _ in }
        XCTAssertEqual(transcript.text, "hello world")
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertTrue(events.withLock { $0.contains { if case .waitingForNetwork = $0 { return true }; return false } })
    }

    // MARK: Consent branch in ChatStore

    private func consentStore() throws -> (ChatStore, AgentServices) {
        let settings = ProviderSettings(fileURL: directory.appendingPathComponent("Providers.json"), secrets: secrets)
        let consent = AIDataConsent(fileURL: directory.appendingPathComponent("Consent.json"))
        let attachments = AttachmentStore(directory: directory.appendingPathComponent("Attachments"))
        let services = AgentServices(settings: settings,
                                     connectors: ConnectorLibrary(fileURL: directory.appendingPathComponent("Connectors.json"),
                                                                  secrets: secrets),
                                     skills: SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills")),
                                     elicitations: ElicitationCenter(), attachments: attachments, consent: consent)
        let store = ChatStore(conversations: [Conversation(title: "New chat")],
                              persistence: ConversationStore(directory: directory.appendingPathComponent("Conversations")),
                              attachments: attachments, services: services)
        stores.append(store)
        return (store, services)
    }

    func testResolveConsentTranscribeAllowGrantsAndRetries() throws {
        let (store, services) = try consentStore()
        let conversationID = store.conversations[0].id
        let recordingID = UUID()
        store.pendingConsent = ConsentRequest(host: "api.groq.com", providerName: "Groq", connectorNames: [],
                                              conversationID: conversationID, action: .transcribe(recordingID: recordingID))
        var retried: [UUID] = []
        store.voiceRetryTranscription = { retried.append($0) }
        store.resolveConsent(allow: true)
        XCTAssertTrue(services.consent.isGranted("api.groq.com"))
        XCTAssertEqual(retried, [recordingID])
        XCTAssertNil(store.pendingConsent)
    }

    func testResolveConsentTranscribeDeclineKeepsAudioQueued() throws {
        let (store, services) = try consentStore()
        let conversationID = store.conversations[0].id
        store.pendingConsent = ConsentRequest(host: "api.groq.com", providerName: "Groq", connectorNames: [],
                                              conversationID: conversationID, action: .transcribe(recordingID: UUID()))
        var retried = 0
        store.voiceRetryTranscription = { _ in retried += 1 }
        store.resolveConsent(allow: false)
        XCTAssertFalse(services.consent.isGranted("api.groq.com"))
        XCTAssertEqual(retried, 0)
        XCTAssertNil(store.pendingConsent)
    }
}

private extension VoiceGroqTests.FakeNetwork {
    func setUsable() {
        usable = true
    }
}
