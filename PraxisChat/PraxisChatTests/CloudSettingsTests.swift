import XCTest
import Synchronization
import AgentCore
@testable import PraxisChat

@MainActor
final class CloudSettingsTests: XCTestCase {
    private func fixture() throws -> (CloudTestBackend, CloudServices) {
        let backend = CloudTestBackend()
        let client = CloudAPIClient(configuration: try CloudServerConfiguration(baseURL: CloudTestBackend.baseURL),
                                    session: backend.makeSession(), tokens: CloudSessionStore(inMemory: true))
        return (backend, CloudServices(client: client))
    }

    private func model(_ id: String, provider: String = "p", pinned: Bool = false, favorite: Bool = false) -> CloudCatalogModel {
        CloudCatalogModel(id: id, providerId: provider, displayName: id, capabilities: .init(), reasoningEfforts: ["low", "high"], pinned: pinned, favorite: favorite)
    }

    private func page(_ models: [CloudCatalogModel], cursor: String? = nil) throws -> String {
        let items = try JSONSerialization.jsonObject(with: JSONEncoder().encode(models))
        let data = try JSONSerialization.data(withJSONObject: ["type": "page", "items": items, "nextCursor": cursor as Any? ?? NSNull()])
        return String(decoding: data, as: UTF8.self)
    }

    func testRestoreLoadsAccountAndEveryCatalogThroughInjectedSession() async throws {
        let (backend, services) = try fixture(); defer { backend.shutdown() }
        await services.reload()
        XCTAssertEqual(services.account?.id, "stub-user")
        XCTAssertEqual(services.providers.map(\.id), ["stub-provider"])
        XCTAssertEqual(services.models.map(\.id), ["stub-model"])
        XCTAssertEqual(services.pinnedModelIDs, services.favoriteModels.map(\.selectionID))
        XCTAssertNil(services.lastError)
        let paths = Set(backend.recordedRequests().map(\.path))
        for path in ["/v1/auth/session", "/v1/providers", "/v1/connectors", "/v1/skills", "/v1/skill-registries", "/v1/consents", "/v1/preferences", "/v1/models"] {
            XCTAssertTrue(paths.contains(path), path)
        }
    }

    func testSessionCallbackSignOutClearsAccountScopedCatalogsAndToken() async throws {
        let (backend, services) = try fixture(); defer { backend.shutdown() }
        var accounts: [String?] = []
        services.onSessionChanged = { accounts.append($0?.id) }
        await services.reload()
        try await services.signIn(email: "cloud@example.test", password: "fixture-password")
        let savedToken = try await services.client.tokens.token(for: services.client.configuration.origin)
        XCTAssertEqual(savedToken, CloudTestBackend.token)
        try await services.signOut()
        XCTAssertEqual(accounts, ["stub-user", "stub-user", nil])
        XCTAssertFalse(services.isSignedIn)
        XCTAssertTrue(services.providers.isEmpty && services.models.isEmpty && services.favoriteModels.isEmpty)
        XCTAssertTrue(services.connectors.isEmpty && services.skills.isEmpty && services.registries.isEmpty && services.consents.isEmpty)
        XCTAssertNil(services.preferences)
        let clearedToken = try await services.client.tokens.token(for: services.client.configuration.origin)
        XCTAssertNil(clearedToken)
    }

    func testRepeatedReloadOfSameAccountDoesNotResetReplica() async throws {
        let (backend, services) = try fixture(); defer { backend.shutdown() }
        var changes = 0
        services.onSessionChanged = { _ in changes += 1 }
        await services.reload(); await services.reload()
        XCTAssertEqual(changes, 1)
    }

    func testUnauthenticatedReloadClearsExistingCatalogAndNotifies() async throws {
        let (backend, services) = try fixture(); defer { backend.shutdown() }
        await services.reload()
        var changes: [String?] = []
        services.onSessionChanged = { changes.append($0?.id) }
        try await services.client.signOut()
        await services.reload()
        XCTAssertEqual(changes.count, 1)
        XCTAssertNil(changes[0])
        XCTAssertNil(services.account)
        XCTAssertTrue(services.models.isEmpty)
    }

    func testVoicePreferencesUseWriteOnlyServerKeyAndFreshConfiguredState() async throws {
        let (backend, services) = try fixture(); defer { backend.shutdown() }
        await services.reload()
        XCTAssertFalse(services.isConfigured)
        try await services.savePreferences(.init(voice: .init(model: "whisper-large-v3", language: "en", apiKey: "write-only-fixture")))
        XCTAssertTrue(services.isConfigured)
        XCTAssertEqual(services.preferences?.voice.model, "whisper-large-v3")
        XCTAssertEqual(services.preferences?.voice.language, "en")
        let patch = try XCTUnwrap(backend.recordedRequests().first { $0.method == "PATCH" && $0.path == "/v1/preferences" })
        let sent = try JSONSerialization.jsonObject(with: patch.body) as! [String: Any]
        XCTAssertEqual((sent["voice"] as? [String: String])?["apiKey"], "write-only-fixture")
        await services.reload()
        XCTAssertTrue(services.isConfigured)
        XCTAssertNil(services.lastError)
    }

    func testVisionPreferencesRetainProviderScopedSelectionAndOffSwitch() async throws {
        let (backend, services) = try fixture(); defer { backend.shutdown() }
        await services.reload()
        try await services.savePreferences(.init(vision: .init(providerId: "provider/one", modelId: "vision/model", enabled: true)))
        XCTAssertEqual(services.preferences?.vision.providerId, "provider/one")
        XCTAssertEqual(services.preferences?.vision.modelId, "vision/model")
        try await services.savePreferences(.init(vision: .init(enabled: false)))
        XCTAssertEqual(services.preferences?.vision.enabled, false)
        XCTAssertEqual(services.preferences?.vision.modelId, "vision/model")
    }

    func testModelSelectionIDsCannotCollideAcrossProvidersOrSlashes() {
        let a = model("a/b", provider: "p")
        let b = model("b", provider: "p/a")
        let c = model("a/b", provider: "other")
        XCTAssertEqual(Set([a.selectionID, b.selectionID, c.selectionID]).count, 3)
        XCTAssertEqual(a.aiModel(providerName: "Provider").id, a.selectionID)
        XCTAssertEqual(a.aiModel(providerName: "Provider").effortLevels, [.low, .high])
    }

    func testServerModelSearchEncodesQueryAndKeepsProviderFilter() async throws {
        let requests = Mutex<[URLRequest]>([])
        let reply = try page([model("remote")])
        let client = try cloudNetClient { request in requests.withLock { $0.append(request) }; return CloudNetReply(reply) }
        let services = CloudServices(client: client)
        try await services.searchModels(query: " a&b + café? ", providerID: "provider/a?x")
        let url = try XCTUnwrap(requests.withLock { $0.first?.url })
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(query.first { $0.name == "q" }?.value, "a&b + café?")
        XCTAssertEqual(query.first { $0.name == "providerId" }?.value, "provider/a?x")
        XCTAssertEqual(query.first { $0.name == "limit" }?.value, "50")
        XCTAssertEqual(services.models.map(\.id), ["remote"])
    }

    func testModelPagesAppendAndDeduplicateByProviderModelPair() async throws {
        let a = model("shared", provider: "one"), b = model("shared", provider: "two")
        let first = try page([a], cursor: "opaque?&=")
        let second = try page([a, b])
        let requests = Mutex<[URLRequest]>([])
        let client = try cloudNetClient { request in
            requests.withLock { $0.append(request) }
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            return CloudNetReply(query?.contains { $0.name == "cursor" } == true ? second : first)
        }
        let services = CloudServices(client: client)
        try await services.searchModels(query: "same")
        try await services.loadMoreModels()
        XCTAssertEqual(services.models.map(\.selectionID), [a.selectionID, b.selectionID])
        XCTAssertNil(services.nextModelCursor)
        let url = try XCTUnwrap(requests.withLock { $0.last?.url })
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "cursor" }?.value, "opaque?&=")
    }

    func testRepeatedModelCursorFailsInsteadOfLooping() async throws {
        let response = try page([model("one")], cursor: "same")
        let services = CloudServices(client: try cloudNetClient { _ in CloudNetReply(response) })
        try await services.searchModels(query: "")
        do { try await services.loadMoreModels(); XCTFail("Repeated cursor must fail") }
        catch { XCTAssertTrue(error is CloudSettingsError) }
        XCTAssertFalse(services.loadingModels)
    }

    func testAllPagesExhaustsOpaqueConfigurationCursors() async throws {
        let first = #"{"type":"page","items":[{"type":"consent","host":"one.test","allowed":true}],"nextCursor":"page2"}"#
        let second = #"{"type":"page","items":[{"type":"consent","host":"two.test","allowed":false}],"nextCursor":null}"#
        let client = try cloudNetClient { request in CloudNetReply(request.url!.query!.contains("cursor=") ? second : first) }
        let rows: [CloudCatalogConsent] = try await CloudServices.allPages(client, "/v1/consents")
        XCTAssertEqual(rows.map(\.host), ["one.test", "two.test"])
    }

    func testAllPagesRejectsRepeatedCursor() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(#"{"type":"page","items":[],"nextCursor":"loop"}"#) }
        do {
            let _: [CloudCatalogConsent] = try await CloudServices.allPages(client, "/v1/consents")
            XCTFail("Repeated cursor must fail")
        } catch { XCTAssertTrue(error is CloudSettingsError) }
    }

    func testPinAndFavoriteMutationUsesOpaqueModelIDsAndServerResponse() async throws {
        let updated = model("model/a", provider: "provider?b", pinned: true, favorite: true)
        let response = String(decoding: try JSONEncoder().encode(updated), as: UTF8.self)
        let requests = Mutex<[URLRequest]>([])
        let client = try cloudNetClient { request in requests.withLock { $0.append(request) }; return CloudNetReply(response) }
        let services = CloudServices(client: client)
        try await services.setModelPreference(model("model/a", provider: "provider?b"), pinned: true, favorite: true)
        XCTAssertEqual(services.favoriteModels, [updated])
        let request = try XCTUnwrap(requests.withLock { $0.first })
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/v1/models/preferences")
        let data = try requestBody(request)
        let input = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(input["type"] as? String, "model.preference")
        XCTAssertEqual(input["providerId"] as? String, "provider?b")
        XCTAssertEqual(input["modelId"] as? String, "model/a")
    }

    func testRemoteURLValidationRejectsCredentialsAndProcesses() {
        for value in ["stdio://node", "file:///tmp/server", "https://user:secret@example.test/mcp", "not a url", "https:///", "https://example.test/#fragment"] {
            XCTAssertThrowsError(try CloudSettingsValidation.remoteURL(value), value)
        }
        XCTAssertNoThrow(try CloudSettingsValidation.remoteURL("https://example.test/mcp"))
    }

    func testOAuthCallbackRequiresStateAndExactRegisteredRoute() throws {
        XCTAssertNoThrow(try CloudOAuthAuthorizer.validateCallback(URL(string: "praxis-app://oauth/callback?state=safe")!, expectedState: "safe"))
        for callback in ["praxis-app://oauth/callback?state=other", "https://oauth/callback?state=safe", "praxis-app://evil/callback?state=safe", "praxis-app://oauth/callback?state=safe&error=denied", "praxis-app://oauth/callback?state=safe&state=safe"] {
            XCTAssertThrowsError(try CloudOAuthAuthorizer.validateCallback(URL(string: callback)!, expectedState: "safe"), callback)
        }
    }

    func testOAuthPresentsHTTPSAuthorizationInRegisteredAppSession() async throws {
        let url = URL(string: "https://oauth.example.test/authorize?state=token")!
        let authorization = CloudCatalogOAuthAuthorization(type: "oauth.authorization", url: url, state: "token")
        let authorizer = CloudOAuthAuthorizer { receivedURL, scheme in
            XCTAssertEqual(receivedURL, url); XCTAssertEqual(scheme, "praxis-app")
            return URL(string: "praxis-app://oauth/callback?state=token")!
        }
        let callback = try await authorizer.authorize(authorization)
        XCTAssertEqual(callback.scheme, "praxis-app")
    }

    func testMultipartPreventsFilenameHeaderInjectionAndKeepsFields() {
        let body = CloudVoiceTranscriber.multipart(audio: Data([1, 2, 3]), fileName: "unsafe\r\n\".m4a", model: "whisper", language: "en", prompt: "previous words")
        let text = String(decoding: body.data, as: UTF8.self)
        XCTAssertTrue(body.contentType.hasPrefix("multipart/form-data; boundary="))
        XCTAssertFalse(text.contains("unsafe\r\n"))
        XCTAssertTrue(text.contains("filename=\"unsafe.m4a\""))
        XCTAssertTrue(text.contains("name=\"model\"\r\n\r\nwhisper"))
        XCTAssertTrue(text.contains("name=\"language\"\r\n\r\nen"))
        XCTAssertTrue(text.contains("previous words"))
    }

    func testCloudVoiceErrorMappingPreservesAuthConsentSizeOfflineAndCancel() {
        let cases: [(Int, (VoiceTranscriptionError) -> Bool)] = [
            (401, { if case .unauthorized = $0 { true } else { false } }),
            (403, { if case .consentRequired(let host) = $0 { host == "api.groq.com" } else { false } }),
            (413, { if case .tooLarge = $0 { true } else { false } }),
            (429, { if case .rateLimited = $0 { true } else { false } }),
        ]
        for (status, check) in cases { XCTAssertTrue(check(CloudVoiceTranscriber.mapError(CloudAPIError.http(status: status, error: nil)))) }
        if case .offline = CloudVoiceTranscriber.mapError(URLError(.notConnectedToInternet)) { } else { XCTFail("offline mapping") }
        if case .cancelled = CloudVoiceTranscriber.mapError(CancellationError()) { } else { XCTFail("cancellation mapping") }
    }

    func testSkillImportReadsBoundedUTF8DocumentAndReleasesPath() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("SKILL.md")
        let document = "---\nname: Test\ndescription: Test skill\n---\nDo the task."
        try document.write(to: file, atomically: true, encoding: .utf8)
        let input = try CloudSettingsSkillImport.read(file)
        XCTAssertEqual(input.document, document)
        XCTAssertFalse(input.document.contains(directory.path))
        try Data(repeating: 65, count: 500_001).write(to: file)
        XCTAssertThrowsError(try CloudSettingsSkillImport.read(file))
    }

    func testCloudVoiceTranscribesRealAudioUsingOnlyCloudSessionAndKeepsOriginal() async throws {
        let (backend, services) = try fixture(); defer { backend.shutdown() }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("recording.wav")
        try wav().write(to: file)
        let progress = Mutex<[Double]>([])
        let transcriber = CloudVoiceTranscriber(client: services.client, model: "whisper-large-v3-turbo", language: "en",
                                               partCache: PartTranscriptCache(directory: directory.appendingPathComponent("parts")))
        let result = try await transcriber.transcribe(file: file, fileName: "recording.m4a") { fraction, _, _ in progress.withLock { $0.append(fraction) } }
        XCTAssertEqual(result.text, "Cloud transcription fixture")
        XCTAssertEqual(progress.withLock { $0.last }, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        let uploads = backend.recordedRequests().filter { $0.path == "/v1/transcribe" }
        XCTAssertEqual(uploads.count, 1)
        XCTAssertTrue(String(decoding: uploads[0].body, as: UTF8.self).contains("name=\"file\""))
    }

    private func requestBody(_ request: URLRequest) throws -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }; result.append(contentsOf: buffer.prefix(count))
        }
        return result
    }

    private func wav() -> Data {
        let sampleRate = 16_000, count = 32_000
        var data = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: "RIFF".utf8); u32(UInt32(36 + count * 2)); data.append(contentsOf: "WAVEfmt ".utf8)
        u32(16); u16(1); u16(1); u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        data.append(contentsOf: "data".utf8); u32(UInt32(count * 2)); data.append(contentsOf: [UInt8](repeating: 0, count: count * 2))
        return data
    }
}
