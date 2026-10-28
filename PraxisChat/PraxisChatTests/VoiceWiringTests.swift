import XCTest
import AgentCore
import AgentMCP
import AgentTestSupport
@testable import PraxisChat

/// Final `voice` integration (VOICE_PLAN §10): the production wiring —
/// `GroqVoiceSettings.makeTranscriber` behind `LiveGroqTranscriber` — proved
/// end to end with a scripted transport. The load-bearing behaviour is the
/// consent allow-path: a grant AFTER controller creation must take effect on
/// the retry (a stale snapshot would loop the consent sheet forever).
/// No Groq key here; none requested.
@MainActor
final class VoiceWiringTests: XCTestCase {
    private var directory: URL!
    private var secrets: InMemorySecretStore!

    override func setUp() async throws {
        directory = temporaryDirectory()
        secrets = InMemorySecretStore()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
    }

    /// A real 2 s WAV (hand-written header), same shape as voice-groq's.
    private func writeWAV() throws -> URL {
        let sampleRate = 16000
        let count = 2 * sampleRate
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

    /// Deny-then-grant through the live factory: the first call throws
    /// `.consentRequired` (audio kept, no request sent); after the grant the
    /// retry uploads and stitches — proving the snapshot is fresh per call.
    func testLiveFactoryHonorsGrantOnRetry() async throws {
        let file = try writeWAV()
        let fileName = "\(UUID().uuidString).m4a"
        try secrets.setSecret("gsk-test", for: GroqVoiceSettings.keychainAccount)
        let transport = ScriptedTransport(replies: [
            .json(#"{"text":"hello world","language":"en","duration":2.0,"segments":[{"id":0,"start":0.0,"end":2.0,"text":"hello world"}]}"#),
        ])
        let settings = GroqVoiceSettings(fileURL: nil, secrets: secrets, transport: transport)
        let consent = AIDataConsent(fileURL: nil)
        let live = LiveGroqTranscriber {
            settings.makeTranscriber(consentGranted: consent.isGranted(GroqEndpoints.host))
        }

        do {
            _ = try await live.transcribe(file: file, fileName: fileName) { _, _, _ in }
            XCTFail("first call must require consent")
        } catch let error as VoiceTranscriptionError {
            guard case .consentRequired(let host) = error else { return XCTFail("wrong error \(error)") }
            XCTAssertEqual(host, "api.groq.com")
        }
        XCTAssertEqual(transport.requests.count, 0, "nothing uploads before consent")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "failures keep the audio")

        consent.grant(GroqEndpoints.host, providerName: "Groq")
        let transcript = try await live.transcribe(file: file, fileName: fileName) { _, _, _ in }
        XCTAssertEqual(transcript.text, "hello world")
        XCTAssertEqual(transport.requests.count, 1)
        let sent = transport.requests[0]
        XCTAssertEqual(sent.url?.absoluteString, "https://api.groq.com/openai/v1/audio/transcriptions")
        let auth = sent.headers.first { $0.key.lowercased() == "authorization" }?.value
        XCTAssertEqual(auth, "Bearer gsk-test")
        let body = String(decoding: sent.body ?? Data(), as: UTF8.self)
        XCTAssertTrue(body.contains("whisper-large-v3-turbo"), "selected model id is sent")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
    }

    /// A model change in Settings reaches the very next upload (no restart,
    /// no stale snapshot).
    func testLiveFactoryPicksUpModelChange() async throws {
        let file = try writeWAV()
        try secrets.setSecret("gsk-test", for: GroqVoiceSettings.keychainAccount)
        let transport = ScriptedTransport(replies: [
            .json(#"{"text":"one","segments":[]}"#),
            .json(#"{"text":"two","segments":[]}"#),
        ])
        let settings = GroqVoiceSettings(fileURL: nil, secrets: secrets, transport: transport)
        let consent = AIDataConsent(fileURL: nil)
        consent.grant(GroqEndpoints.host, providerName: "Groq")
        let live = LiveGroqTranscriber {
            settings.makeTranscriber(consentGranted: consent.isGranted(GroqEndpoints.host))
        }

        _ = try await live.transcribe(file: file, fileName: "\(UUID()).m4a") { _, _, _ in }
        settings.selectModel("whisper-large-v3")
        _ = try await live.transcribe(file: file, fileName: "\(UUID()).m4a") { _, _, _ in }

        XCTAssertEqual(transport.requests.count, 2)
        let bodies = transport.requests.map { String(decoding: $0.body ?? Data(), as: UTF8.self) }
        XCTAssertTrue(bodies[0].contains("whisper-large-v3-turbo"))
        XCTAssertTrue(bodies[1].contains("name=\"model\"\r\n\r\nwhisper-large-v3\r\n"),
                      "second upload uses the newly selected model")
        XCTAssertFalse(bodies[1].contains("whisper-large-v3-turbo"))
    }

    /// `production()` wires the real settings (not the unconfigured stub)
    /// when no DEBUG transcript seam is set.
    func testProductionUsesLiveSettings() {
        XCTAssertNil(UserDefaults.standard.string(forKey: "PraxisFakeTranscript"),
                     "precondition: no fake-transcript seam in unit tests")
        let settings = ProviderSettings(fileURL: directory.appendingPathComponent("Providers.json"), secrets: secrets)
        let services = AgentServices(
            settings: settings,
            connectors: ConnectorLibrary(fileURL: directory.appendingPathComponent("Connectors.json"),
                                         secrets: secrets, transport: ScriptedTransport(replies: [])),
            skills: SkillLibrary(importedDirectory: directory.appendingPathComponent("Skills")),
            elicitations: ElicitationCenter())
        let store = ChatStore(services: services)
        let controller = VoiceInputController.production(chatStore: store, services: services)
        XCTAssertTrue(controller.settings is GroqVoiceSettings)
        XCTAssertTrue(controller.transcriber is LiveGroqTranscriber)
        XCTAssertFalse(controller.settings.isConfigured, "no key in a fresh test store")
    }
}
