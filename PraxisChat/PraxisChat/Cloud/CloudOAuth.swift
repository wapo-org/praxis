import Foundation

protocol CloudOAuthAuthorizing: Sendable {
    func authorize(_ authorization: CloudCatalogOAuthAuthorization) async throws -> URL
}

/// The API owns discovery, DCR/CIMD, PKCE and tokens. This adapter only
/// presents the authorization URL and verifies the app callback. Reuses the
/// cancellation-safe ASWebAuthenticationSession presenter, with no MCP client.
struct CloudOAuthAuthorizer: CloudOAuthAuthorizing {
    var present: @Sendable (URL, String) async throws -> URL = { url, scheme in
        try await WebAuthenticationPresenter().authorize(url: url, callbackScheme: scheme)
    }

    func authorize(_ authorization: CloudCatalogOAuthAuthorization) async throws -> URL {
        guard authorization.url.scheme?.lowercased() == "https",
              authorization.url.host != nil, authorization.url.user == nil,
              authorization.url.password == nil, !authorization.state.isEmpty else {
            throw CloudSettingsError.invalidOAuthCallback
        }
        let callback = try await present(authorization.url, "praxis-app")
        try Task.checkCancellation()
        try Self.validateCallback(callback, expectedState: authorization.state)
        return callback
    }

    static func validateCallback(_ url: URL, expectedState: String) throws {
        guard url.scheme?.lowercased() == "praxis-app", url.host == "oauth", url.path == "/callback",
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.queryItems?.filter({ $0.name == "state" }).count == 1,
              parts.queryItems?.first(where: { $0.name == "state" })?.value == expectedState,
              parts.queryItems?.contains(where: { $0.name == "error" }) != true else {
            throw CloudSettingsError.invalidOAuthCallback
        }
    }
}
