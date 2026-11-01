import XCTest
@testable import PraxisChat

@MainActor
final class CloudBootstrapTests: XCTestCase {
    func testCancelledViewTaskCannotAbandonInitialAccountRestore() async throws {
        let backend = CloudTestBackend(); defer { backend.shutdown() }
        let client = CloudAPIClient(configuration: try .init(baseURL: CloudTestBackend.baseURL), session: backend.makeSession(), tokens: .init(inMemory: true))
        let services = CloudServices(client: client)
        let viewTask = Task { await services.loadIfNeeded() }
        viewTask.cancel()
        await viewTask.value
        XCTAssertTrue(services.isSignedIn)
        XCTAssertFalse(services.models.isEmpty)
        XCTAssertNil(services.lastError)
    }
}
