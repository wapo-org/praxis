import XCTest
import Synchronization
@testable import PraxisChat

@MainActor
final class CloudFeatureCatalogTests: XCTestCase {
    nonisolated private static let skill = #"{"type":"skill","id":"s","name":"example","description":"Updated","document":"Use this","enabled":false,"updatedAt":"2026-11-01T00:00:00Z","registryId":"r","registryEntryId":"e","registryDigest":"sha256:new"}"#
    nonisolated private static let updates = #"{"type":"page","items":[{"type":"skill.update","skillId":"s","registryId":"r","entryId":"e","digest":"sha256:new","updateAvailable":true}],"nextCursor":null}"#
    nonisolated private static let registry = #"{"type":"page","items":[{"type":"connector.registry.entry","id":"server","description":"Remote tools","input":{"type":"connector.input","name":"Example","url":"https://mcp.test/{tenant}","transport":"streamableHttp","enabled":true,"trusted":false,"disabledTools":[]},"headerNames":["X-Key"],"requiresConfiguration":true},{"type":"connector.registry.entry","id":"server","description":"Legacy address","input":{"type":"connector.input","name":"Example","url":"https://mcp.test/sse","transport":"sse","enabled":true,"trusted":false,"disabledTools":[]},"headerNames":[],"requiresConfiguration":false}],"nextCursor":"opaque+/="}"#
    private func body(_ request: URLRequest) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: cloudNetBody(request)) as? [String: Any])
    }
    func testUpdatesUseAuthoritativeIdentityAndReplaceOnlyAfterSuccess() async throws {
        let failures = Mutex(false)
        let client = try cloudNetClient { request in
            switch request.url!.path {
            case "/v1/skills/updates": return CloudNetReply(Self.updates)
            case "/v1/skills/s/update":
                XCTAssertEqual(request.httpMethod, "POST")
                return failures.withLock { $0 } ? CloudNetReply(#"{"code":"digest_mismatch","message":"Changed archive"}"#, status: 400) : CloudNetReply(Self.skill)
            default: XCTFail("Unexpected route"); return CloudNetReply("{}")
            }
        }
        let services = CloudServices(client: client)
        try await services.checkSkillUpdates()
        XCTAssertEqual(services.skillUpdates.first?.skillId, "s")
        failures.withLock { $0 = true }
        do { try await services.updateSkill("s"); XCTFail("Must surface digest mismatch") } catch { XCTAssertEqual((error as? CloudAPIError)?.code, "digest_mismatch") }
        XCTAssertEqual(services.skillUpdates.count, 1); XCTAssertTrue(services.skills.isEmpty)
        failures.withLock { $0 = false }
        try await services.updateSkill("s")
        XCTAssertTrue(services.skillUpdates.isEmpty)
        XCTAssertEqual(services.skills.first?.registryEntryId, "e")
        XCTAssertEqual(services.skills.first?.enabled, false, "Updating preserves the server's enabled state")
    }
    func testArchiveUploadUsesPOSTWithoutCrossOriginBearerAndShowsDroppedReport() async throws {
        let steps = Mutex([String]())
        let client = try cloudNetClient(defaultHeaders: ["Authorization":"Bearer must-not-leak"]) { request in
            steps.withLock { $0.append(request.url!.path) }
            let object = request.url!.path == "/once" ? [:] : try JSONSerialization.jsonObject(with: cloudNetBody(request)) as! [String: Any]
            switch request.url!.path {
            case "/v1/uploads":
                XCTAssertEqual(object["name"] as? String, "example.tar"); XCTAssertNil(object["chatId"])
                return CloudNetReply(#"{"uploadUrl":"https://storage.test/once","method":"POST","expiresAt":"2026-11-02T00:00:00Z"}"#)
            case "/once":
                XCTAssertEqual(request.httpMethod, "POST"); XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "")
                XCTAssertEqual(cloudNetBody(request), Data([1,2,3]))
                return CloudNetReply(#"{"storageId":"storage"}"#)
            case "/v1/uploads/complete":
                XCTAssertEqual(object["storageId"] as? String, "storage"); XCTAssertNil(object["chatId"])
                return CloudNetReply(#"{"id":"attachment"}"#)
            case "/v1/skills/import":
                XCTAssertEqual(object["type"] as? String, "skill.import"); XCTAssertEqual(object["attachmentId"] as? String, "attachment")
                return CloudNetReply("{\"type\":\"skill.import.result\",\"skill\":\(Self.skill),\"dropped\":[\"run.sh\"]}")
            default: XCTFail("Unexpected route"); return CloudNetReply("{}")
            }
        }
        let services = CloudServices(client: client)
        let result = try await services.importSkillArchive(bytes: Data([1,2,3]), name: "example.tar")
        XCTAssertEqual(result.summary, "Imported example. Left out: run.sh")
        XCTAssertEqual(services.skills.map(\.id), ["s"])
        XCTAssertEqual(steps.withLock { $0 }, ["/v1/uploads","/once","/v1/uploads/complete","/v1/skills/import"])
    }
    func testArchiveValidationRejectsEmptyOversizedAndWrongExtensionBeforeHTTP() async throws {
        let client = try cloudNetClient { _ in XCTFail("Invalid archive must not upload"); return CloudNetReply("{}") }
        let services = CloudServices(client: client)
        for (data, name) in [(Data(), "x.zip"), (Data([1]), "x.md"), (Data(repeating: 1, count: 25_000_001), "x.tar")] {
            do { _ = try await services.importSkillArchive(bytes: data, name: name); XCTFail("Invalid input") }
            catch { XCTAssertTrue(error is CloudSkillArchiveError) }
        }
        XCTAssertTrue(CloudSkillArchive.isArchive("Skill.TAR.GZ"))
        XCTAssertEqual(CloudSkillArchive.mediaType("Skill.zip"), "application/zip")
    }
    func testArchiveServerRejectionNeverInstallsSkill() async throws {
        let client = try cloudNetClient { request in
            switch request.url!.path {
            case "/v1/uploads": return CloudNetReply(#"{"uploadUrl":"https://cloud.test/once","method":"PUT","expiresAt":"later"}"#)
            case "/once": return CloudNetReply(#"{"storageId":"storage"}"#)
            case "/v1/uploads/complete": return CloudNetReply(#"{"id":"attachment"}"#)
            default: return CloudNetReply(#"{"code":"invalid_archive","message":"Unsafe archive"}"#, status: 400)
            }
        }
        let services = CloudServices(client: client)
        do { _ = try await services.importSkillArchive(bytes: Data([1]), name: "unsafe.zip"); XCTFail("No fake import success") }
        catch { XCTAssertEqual((error as? CloudAPIError)?.code, "invalid_archive") }
        XCTAssertTrue(services.skills.isEmpty)
    }
    func testMissingUploadReceiptStopsBeforeImport() async throws {
        let client = try cloudNetClient { request in
            if request.url!.path == "/v1/uploads" { return CloudNetReply(#"{"uploadUrl":"https://storage.test/once","method":"POST","expiresAt":"later"}"#) }
            XCTAssertEqual(request.url!.path, "/once")
            return CloudNetReply("{}")
        }
        let services = CloudServices(client: client)
        do { _ = try await services.importSkillArchive(bytes: Data([1]), name: "x.zip"); XCTFail("Receipt is required") } catch { }
        XCTAssertTrue(services.skills.isEmpty)
    }
    func testProbeSendsModelIDAndOnlyFeedsTestedCapabilityToggles() async throws {
        let client = try cloudNetClient { request in
            XCTAssertEqual(request.url!.path, "/v1/providers/provider/test"); XCTAssertEqual(request.httpMethod, "POST")
            let object = try JSONSerialization.jsonObject(with: cloudNetBody(request)) as! [String: Any]
            XCTAssertEqual(object["modelId"] as? String, "model/opaque")
            return CloudNetReply(#"{"type":"provider.test.result","ok":true,"models":[],"probe":{"tools":false,"vision":true,"streaming":true,"reasoningEfforts":["low","high"]}}"#)
        }
        let result = try await CloudServices(client: client).testProvider("provider", modelID: "model/opaque")
        var old = CloudCatalogCapabilities(); old.streamUsage = false; old.documents = true
        let detected = try XCTUnwrap(result.probe).applying(to: old)
        XCTAssertFalse(detected.tools); XCTAssertTrue(detected.vision); XCTAssertTrue(detected.reasoningEffort)
        XCTAssertTrue(detected.documents); XCTAssertFalse(detected.streamUsage)
        XCTAssertTrue(result.summary.contains("Tools: unconfirmed"))
    }
    func testProbeFailurePreservesTypedServerErrorAndNeverClaimsSuccess() async throws {
        let client = try cloudNetClient { _ in CloudNetReply(#"{"type":"provider.test.result","ok":false,"models":[],"error":{"code":"timeout","message":"Timed out reaching provider"}}"#) }
        let result = try await CloudServices(client: client).testProvider("p", modelID: "m")
        XCTAssertFalse(result.ok); XCTAssertNil(result.probe)
        XCTAssertEqual(result.error?.code, "timeout"); XCTAssertEqual(result.summary, "Timed out reaching provider")
    }
    func testRegistrySearchEncodesQueryAndCursorAndKeepsDistinctAddresses() async throws {
        let client = try cloudNetClient { request in
            XCTAssertEqual(request.url!.path, "/v1/connectors/registry")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!
            XCTAssertEqual(query.first { $0.name == "q" }?.value, "docs & tools")
            XCTAssertEqual(query.first { $0.name == "cursor" }?.value, "opaque+/=")
            return CloudNetReply(Self.registry)
        }
        let page = try await CloudServices(client: client).connectorRegistry(query: "docs & tools", cursor: "opaque+/=")
        XCTAssertEqual(page.items.count, 2); XCTAssertNotEqual(page.items[0].selectionID, page.items[1].selectionID)
        XCTAssertTrue(page.items[0].requiresConfiguration); XCTAssertEqual(page.items[0].headerNames, ["X-Key"])
        XCTAssertEqual(page.nextCursor, "opaque+/=")
    }
    func testRegistryAddCarriesConfiguredHeadersAndDisplaysActualHealthFailure() async throws {
        let client = try cloudNetClient { request in
            XCTAssertEqual(request.url!.path, "/v1/connectors"); XCTAssertEqual(request.httpMethod, "POST")
            let object = try JSONSerialization.jsonObject(with: cloudNetBody(request)) as! [String: Any]
            XCTAssertEqual(object["extraHeaders"] as? [String:String], ["X-Key":"private"])
            return CloudNetReply(#"{"type":"connector","id":"c","name":"Example","url":"https://mcp.test/tenant","transport":"streamableHttp","enabled":true,"trusted":false,"disabledTools":[],"authStatus":"none","status":"unreachable","error":"Connection refused","updatedAt":"now"}"#)
        }
        let services = CloudServices(client: client)
        let connector = try await services.saveConnector(input: CloudCatalogConnectorInput(name: "Example", url: "https://mcp.test/tenant", extraHeaders: ["X-Key":"private"]))
        XCTAssertEqual(connector.presentationStatus, "Unreachable"); XCTAssertEqual(connector.error, "Connection refused")
        XCTAssertEqual(services.connectors.first?.id, "c")
    }
}
