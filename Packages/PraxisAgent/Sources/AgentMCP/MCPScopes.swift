import Foundation

/// Which OAuth scopes Praxis asks for by default — least privilege, with
/// the user free to widen the list (`MCPServerConfig.oauthScopes`).
///
/// The rules, in order:
/// 1. A `scope` the server's 401/403 `WWW-Authenticate` challenge names is
///    what that request needs: ask for exactly that (MCP's scope selection
///    strategy).
/// 2. Otherwise, a least-privilege set the authorization server's own
///    guidance recommends, when the server lists those scopes
///    (`leastPrivilege`, keyed by issuer host). Only scopes the server
///    lists are requested, so an unrelated server on the same issuer
///    falls through to rule 3.
/// 3. Otherwise every scope the protected-resource metadata lists
///    (`scopes_supported`), as the MCP spec suggests.
///
/// Some servers answer a tool call's 401 with `resource_metadata` for
/// that tool rather than the whole server (Google's Gmail MCP server:
/// `/.well-known/oauth-protected-resource/<tool>`). Its `scopes_supported`
/// are alternatives — any one lets the tool run — so step-up adds one of
/// them (`narrowest`), not all: the full list would include the broadest
/// scope (`https://mail.google.com/`).
public enum MCPScopeSelection {
    /// Issuer host → scopes its own documentation recommends for MCP use.
    /// Google: the Gmail MCP server guide
    /// (developers.google.com/workspace/gmail/api/guides/configure-mcp-server)
    /// configures `gmail.readonly` + `gmail.compose`. Listing the server's
    /// full set instead would also grant full mailbox access and
    /// `gmail.metadata`, which makes Gmail refuse search queries.
    public static let leastPrivilege: [String: [String]] = [
        "accounts.google.com": [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.compose",
        ],
    ]

    /// The scopes to ask for when the user hasn't chosen any.
    /// - Parameters:
    ///   - supported: `scopes_supported` from the protected-resource metadata.
    ///   - challenged: the `scope` of a `WWW-Authenticate` challenge, if any.
    ///   - issuer: the authorization server.
    public static func defaults(supported: [String], challenged: [String]? = nil, issuer: String?) -> [String] {
        if let challenged, !challenged.isEmpty { return unique(challenged) }
        let preferred = recommended(supported: supported, issuer: issuer)
        return preferred.isEmpty ? unique(supported) : preferred
    }

    /// The issuer's recommended scopes that `supported` lists, in the
    /// recommendation's order; empty when there's no recommendation or
    /// the server lists none of it.
    public static func recommended(supported: [String], issuer: String?) -> [String] {
        guard let host = issuer.flatMap(host(of:)), let preferred = leastPrivilege[host] else { return [] }
        let listed = Set(supported)
        return preferred.filter(listed.contains)
    }

    /// Alternatives (any one suffices) from narrowest to broadest: the
    /// issuer's recommended scopes first, then the rest in reverse listed
    /// order — servers seen in the wild list the broadest scope first.
    public static func narrowestFirst(_ alternatives: [String], issuer: String?) -> [String] {
        let preferred = recommended(supported: alternatives, issuer: issuer)
        return preferred + unique(alternatives).reversed().filter { !preferred.contains($0) }
    }

    /// Step-up for a refused tool whose metadata lists `alternatives`:
    /// the scopes to add to `requested`. Nothing when one of them is
    /// already asked for but not granted (the user unticked it on the
    /// consent screen — ask again); the next-narrowest one when the
    /// granted alternatives still weren't enough.
    static func stepUp(alternatives: [String], requested: [String], granted: Set<String>, issuer: String?) -> [String] {
        let ordered = narrowestFirst(alternatives, issuer: issuer)
        let held = ordered.filter { granted.contains($0) }
        if held.isEmpty {
            if ordered.contains(where: requested.contains) { return [] }
            return ordered.first.map { [$0] } ?? []
        }
        return ordered.first { !requested.contains($0) && !granted.contains($0) }.map { [$0] } ?? []
    }

    static func host(of issuer: String) -> String? {
        (URL(string: issuer)?.host() ?? issuer).lowercased().nilIfEmpty
    }

    private static func unique(_ scopes: [String]) -> [String] {
        var seen = Set<String>()
        return scopes.filter { seen.insert($0).inserted }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
