import Foundation

/// Shared by chat attachments and skill archive imports. One-time upload
/// origins never receive the API session credential.
enum CloudFileUpload {
    static func send(client: CloudAPIClient, bytes: Data, name: String, mediaType: String, chatID: String? = nil, hidden: Bool = false) async throws -> String {
        let upload: CloudUploadURL = try await client.send("/v1/uploads", method: "POST", body: JSONEncoder().encode(CloudUploadRequest(name: name, mediaType: mediaType, size: bytes.count, chatId: chatID)))
        guard let originURL = URL(string: "/", relativeTo: upload.uploadUrl)?.absoluteURL,
              (try? CloudServerConfiguration(baseURL: originURL)) != nil else { throw CloudAPIError.invalidServer }
        var request = URLRequest(url: upload.uploadUrl)
        request.httpMethod = upload.method?.rawValue ?? "POST"; request.httpBody = bytes
        request.setValue(mediaType, forHTTPHeaderField: "Content-Type")
        request.httpShouldHandleCookies = false
        // Local API upload routes require the API bearer. A Convex one-time
        // URL is a different origin and must never receive that credential,
        // including any Authorization supplied by session default headers.
        let uploadOrigin = try CloudServerConfiguration(baseURL: originURL).origin
        let token = uploadOrigin == client.configuration.origin
            ? try await client.tokens.token(for: client.configuration.origin) : nil
        request.setValue(token.map { "Bearer " + $0 } ?? "", forHTTPHeaderField: "Authorization")
        let (data, response) = try await client.session.data(for: request, delegate: CloudRedirectGuard())
        try CloudAPIClient.validate(response, data: data)
        let storage = try JSONDecoder().decode(CloudStorageReceipt.self, from: data)
        guard !storage.storageId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw CloudAPIError.invalidResponse }
        let complete = CloudUploadComplete(storageId: storage.storageId, name: name, mediaType: mediaType, size: bytes.count, chatId: chatID, hiddenFromCode: hidden)
        let saved: CloudAttachment = try await client.send("/v1/uploads/complete", method: "POST", body: JSONEncoder().encode(complete))
        return saved.id
    }
}
