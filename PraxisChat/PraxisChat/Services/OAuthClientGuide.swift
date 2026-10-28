import Foundation

/// Setup copy for servers whose sign-in can't register Praxis by itself
/// (no Dynamic Client Registration): the user creates an OAuth client and
/// pastes its ID. Nothing is hosted: the redirect is an app scheme that
/// `ASWebAuthenticationSession` catches.
///
/// Google gets its exact console steps: an iOS-type client whose redirect
/// is the reversed client ID (`com.googleusercontent.apps.<id>:/oauthredirect`).
struct OAuthClientGuide {
    static let defaultRedirect = "praxischat://oauth/callback"
    private static let googleSuffix = ".apps.googleusercontent.com"

    let issuer: String?

    var host: String? { issuer.flatMap { URL(string: $0)?.host() } ?? issuer }
    var isGoogle: Bool { host?.lowercased() == "accounts.google.com" }

    static var bundleID: String { Bundle.main.bundleIdentifier ?? "com.praxis.chat" }

    /// Google iOS client ID → its redirect; nil for anything else.
    static func redirect(forClientID id: String) -> String? {
        guard id.hasSuffix(googleSuffix) else { return nil }
        let prefix = id.dropLast(googleSuffix.count)
        guard !prefix.isEmpty, prefix.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else { return nil }
        return "com.googleusercontent.apps.\(prefix):/oauthredirect"
    }

    /// "a b, c\nd" → ["a", "b", "c", "d"]; nil when empty.
    static func scopes(from text: String) -> [String]? {
        let list = text.split(whereSeparator: { $0 == " " || $0 == "," || $0.isNewline }).map(String.init)
        return list.isEmpty ? nil : list
    }

    var intro: String {
        if isGoogle {
            return "Google doesn't let apps register themselves for sign-in, so you create a sign-in client for Praxis once, in your own Google Cloud project. It takes a few minutes and nothing is hosted anywhere."
        }
        let who = host.map { "\($0) doesn't" } ?? "This server's sign-in doesn't"
        return "\(who) let apps register themselves for sign-in. Create an OAuth app once in its developer settings, then enter its client ID here."
    }

    /// Markdown-capable steps.
    var steps: [String] {
        if isGoogle {
            return [
                "Open **console.cloud.google.com**, pick or create a project, and under APIs & Services enable the APIs this server uses (for Gmail: **Gmail API** and **Gmail MCP API**).",
                "**Google Auth Platform → Branding**: give the app a name. **Audience**: choose External (or Internal for a Workspace org) and add your Google account under **Test users**.",
                "**Data Access → Add or remove scopes**: add the scopes listed below.",
                "**Clients → Create client**, application type **iOS**, bundle ID \(Self.bundleID) (shown below).",
                "Copy the **client ID** (it ends in .apps.googleusercontent.com) and paste it here. iOS clients have no secret; the redirect fills itself in.",
            ]
        }
        return [
            "In \(host ?? "the provider")'s developer settings, create an OAuth app — a public or native app that uses PKCE.",
            "Set its redirect URL to **\(Self.defaultRedirect)**. If the provider gives you its own app-scheme redirect instead (like com.example.app:/oauth), enter that below.",
            "Paste the client ID, and the client secret if it gave you one.",
        ]
    }

    /// - Parameter narrowed: the prefill is a least-privilege subset of
    ///   what the server lists (`MCPSignInOffer.recommendedScopes`).
    func footnote(narrowed: Bool) -> String {
        if isGoogle && narrowed {
            return "Prefilled with the least access Google's Gmail MCP guide uses: gmail.readonly (read and search) and gmail.compose (drafts). Add more below only if a tool needs them — gmail.metadata makes Gmail refuse searches. Tokens stay in this iPhone's Keychain."
        }
        if narrowed {
            return "Prefilled with the least access the server's tools need; add more below if you want to. Tokens stay in this iPhone's Keychain."
        }
        return "Scopes are prefilled with what the server asks for; remove ones you don't want to grant. Tokens stay in this iPhone's Keychain."
    }

    /// The scopes to prefill: the least-privilege recommendation when
    /// there is one, else everything advertised.
    static func prefill(recommended: [String], advertised: [String]) -> [String] {
        recommended.isEmpty ? advertised : recommended
    }

    /// Advertised scopes the field doesn't hold yet, in the server's order.
    static func unrequested(_ advertised: [String], field text: String) -> [String] {
        let held = Set(scopes(from: text) ?? [])
        return advertised.filter { !held.contains($0) }
    }

    /// "https://www.googleapis.com/auth/gmail.modify" → "gmail.modify";
    /// "https://mail.google.com/" → "mail.google.com"; others unchanged.
    static func shortName(_ scope: String) -> String {
        guard let url = URL(string: scope), url.scheme == "https" || url.scheme == "http", let host = url.host() else { return scope }
        let last = url.lastPathComponent
        return last.isEmpty || last == "/" ? host : last
    }
}
