import Foundation
import AgentCore

struct CloudAuthInput: Encodable, Sendable {
    let type = "auth.input"
    let email: String
    let password: String
    let name: String?
}
struct CloudUser: Codable, Sendable, Equatable {
    let id: String
    let name: String
    let email: String?
}
struct CloudSession: Decodable, Sendable {
    let user: CloudUser
    let expiresAt: String
    let bearerToken: String?
}
struct CloudRun: Codable, Sendable {
    let id: String
    let chatId: String
    let status: String
    let outcome: String?
    let error: String?
    let lastEventId: Int
    let clientTurnId: String?
}
struct CloudChatInput: Encodable, Sendable {
    let type = "chat.input"
    var id: String
    var title: String
    var mode: String
    var providerId: String?
    var modelId: String?
    var effort: String?
    var connectorIds: [String]
    var disabledConnectorIds: [String]
}
struct CloudChatIdentity: Decodable, Sendable { let id: String; var title: String? = nil }
struct CloudStartRun: Encodable, Sendable {
    let type = "run.start"
    var chatId: String
    var text: String
    var providerId: String?
    var modelId: String?
    var mode: String
    var effort: String
    var attachmentIds: [String]
    var webSearch: Bool
    var idempotencyKey: String
    var clientTurnId: String
    var script: String?
}
struct CloudApprovalDecision: Encodable, Sendable {
    let type = "approval.decision"
    var approvalId: String
    var decision: String
}
struct CloudElicitationResponse: Encodable, Sendable {
    let type = "elicitation.response"
    var elicitationId: String
    var action: String
    var content: JSONValue?
}
struct CloudUploadRequest: Encodable, Sendable {
    let type = "upload.request"
    let name: String
    let mediaType: String
    let size: Int
    let chatId: String
}
struct CloudUploadURL: Decodable, Sendable {
    enum Method: String, Decodable, Sendable { case POST, PUT }
    let uploadUrl: URL
    let method: Method?
    let expiresAt: String
}
struct CloudStorageReceipt: Decodable, Sendable { let storageId: String }
struct CloudUploadComplete: Encodable, Sendable {
    let type = "upload.complete"
    let storageId: String
    let name: String
    let mediaType: String
    let size: Int
    let chatId: String
}
struct CloudAttachment: Decodable, Sendable { let id: String }
