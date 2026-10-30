import Foundation
import Synchronization
import XCTest
import AgentCore
@testable import PraxisChat

@MainActor
final class CloudStoreWiringTests: XCTestCase {
    private func makeStore() throws -> ChatStore {
        let backend = CloudTestBackend(scenario: .text)
        let client = CloudAPIClient(configuration: try CloudServerConfiguration(baseURL: CloudTestBackend.baseURL),
                                    session: backend.makeSession(), tokens: CloudSessionStore(inMemory: true))
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return ChatStore.makeCloudStore(client: client, conversations: [Conversation(title: "Cloud")], replicaRoot: root)
    }

    func testCloudConstructionSharesServicesVoiceAndElicitationWithoutNativeGraph() async throws {
        let store = try makeStore()
        XCTAssertEqual(store.engineKind, .cloud)
        XCTAssertNil(store.services)
        XCTAssertNotNil(store.cloudServices)
        XCTAssertNotNil(store.voice)
        XCTAssertTrue(store.elicitationCenter === store.cloudElicitations)
        await store.cloudServices?.loadIfNeeded()
        XCTAssertTrue(store.cloudServices?.isSignedIn == true)
        XCTAssertFalse(store.availableModels.isEmpty)
        XCTAssertEqual(store.model.id, store.availableModels.first?.id)
        XCTAssertEqual(store.trayConnectors.map(\.id), store.cloudServices?.connectors.map(\.id))
        await store.settle()
    }

    func testCloudModelSelectionAndEffortUseCatalogCapabilities() async throws {
        let store = try makeStore()
        let cloud = try XCTUnwrap(store.cloudServices)
        await cloud.loadIfNeeded()
        let model = try XCTUnwrap(cloud.models.last)
        store.model = cloud.adapter(model)
        XCTAssertEqual(store.model.id, model.selectionID)
        XCTAssertEqual(store.supportedEfforts, EffortLevels.map(model.reasoningEfforts))
        if let connector = cloud.connectors.first {
            store.setConnector(connector.id, isOn: false)
            XCTAssertEqual(store.trayConnectors.first { $0.id == connector.id }?.isOn, false)
            store.setConnector(connector.id, isOn: true)
            XCTAssertEqual(store.trayConnectors.first { $0.id == connector.id }?.isOn, connector.enabled)
        }
        await store.settle()
    }

    func testStorePassesPersistedTurnIDAndOpaqueRemoteChatIDIntoRun() async throws {
        let captured = Mutex<ChatRunRequest?>(nil)
        let engine = ScriptedChatEngine { request in
            captured.withLock { $0 = request }
            return [.event(.finished(.completed))]
        }
        let conversation = Conversation(title: "Remote", cloudChatID: "opaque/server-chat")
        let store = ChatStore(engine: engine, conversations: [conversation])
        store.send(text: "Stable identity")
        await waitUntil { captured.withLock { $0 != nil } }
        let request = try XCTUnwrap(captured.withLock { $0 })
        XCTAssertEqual(request.turnID, conversation.turns.first?.id)
        XCTAssertEqual(request.cloudChatID, "opaque/server-chat")
        XCTAssertEqual(request.conversationID, conversation.id)
        await store.settle()
    }
}
