import Foundation

extension CloudServices {
    /// Small configuration lists exhaust opaque cursor pages. A repeated
    /// cursor is an explicit server error, never an infinite request loop.
    nonisolated static func allPages<Item: Decodable & Sendable>(_ client: CloudAPIClient, _ path: String, filters: [URLQueryItem] = []) async throws -> [Item] {
        var result: [Item] = []
        var cursor: String?
        var seen: Set<String> = []
        repeat {
            try Task.checkCancellation()
            var query = filters + [URLQueryItem(name: "limit", value: "100")]
            if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
            let page: CloudCatalogPage<Item> = try await client.send(CloudCatalogPath.list(path, query: query))
            result.append(contentsOf: page.items)
            cursor = page.nextCursor
            if let cursor, !seen.insert(cursor).inserted { throw CloudSettingsError.repeatedCursor }
        } while cursor != nil
        return result
    }
}

enum CloudSettingsError: Error, LocalizedError {
    case invalidRemoteURL, repeatedCursor, emptyPrompt, invalidOAuthCallback, invalidSkill
    var errorDescription: String? {
        switch self {
        case .invalidRemoteURL: "Enter an HTTP or HTTPS URL without embedded credentials."
        case .repeatedCursor: "The server returned a repeated page. Try refreshing."
        case .emptyPrompt: "This prompt did not return any text."
        case .invalidOAuthCallback: "The connector sign-in callback could not be verified."
        case .invalidSkill: "Choose a UTF-8 SKILL.md document smaller than 500 KB."
        }
    }
}

enum CloudSettingsValidation {
    static func remoteURL(_ text: String) throws {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), ["https", "http"].contains(scheme),
              url.host != nil, url.user == nil, url.password == nil, url.fragment == nil else { throw CloudSettingsError.invalidRemoteURL }
    }
}
