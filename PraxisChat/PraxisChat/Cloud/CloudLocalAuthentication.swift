#if DEBUG
import Foundation

extension CloudServices {
    var canSignInLocally: Bool {
        ["localhost", "127.0.0.1", "::1", "[::1]"].contains(serverURL.host?.lowercased() ?? "")
    }

    /// Uses the API's actual development identity endpoint, never fabricated credentials.
    func signInLocally() async throws {
        guard canSignInLocally else { throw CloudAPIError.invalidServer }
        struct Input: Encodable { let type = "auth.dev" }
        let session: CloudSession = try await client.send("/v1/auth/dev", method: "POST", body: JSONEncoder().encode(Input()))
        guard let token = session.bearerToken, !token.isEmpty else { throw CloudSessionError.missingToken }
        try await client.tokens.setToken(token, for: client.configuration.origin)
        await acceptSignedInSession(session)
    }
}
#endif
