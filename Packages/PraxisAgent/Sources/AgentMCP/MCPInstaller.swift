import Foundation
import AgentCore

/// A value the user must supply before a server can be installed: a URL
/// `{variable}`, a header placeholder, or a whole header value.
public struct MCPInstallInput: Sendable, Hashable, Identifiable {
    public enum Location: Sendable, Hashable {
        case url
        case header(String)
    }

    /// Placeholder name (`tenant` for `{tenant}` / `${tenant}` / `${input:tenant}`).
    public var key: String
    public var location: Location
    public var description: String?
    public var isRequired: Bool
    /// Stored in the `SecretStore`, never in the config.
    public var isSecret: Bool
    public var defaultValue: String?
    public var choices: [String]

    public var id: String { key }

    public init(key: String, location: Location, description: String? = nil, isRequired: Bool = true, isSecret: Bool = false,
                defaultValue: String? = nil, choices: [String] = []) {
        self.key = key
        self.location = location
        self.description = description
        self.isRequired = isRequired
        self.isSecret = isSecret
        self.defaultValue = defaultValue
        self.choices = choices
    }
}

/// A header as declared by a config or registry entry; `value` may contain
/// placeholders.
public struct MCPHeaderTemplate: Sendable, Hashable {
    public var name: String
    public var value: String
    public var isSecret: Bool
    public init(name: String, value: String, isSecret: Bool) {
        self.name = name
        self.value = value
        self.isSecret = isSecret
    }
}

/// A server that can be installed once its inputs are filled in.
public struct MCPInstallCandidate: Sendable, Hashable {
    public var name: String
    /// May contain `{variables}` — see `inputs`.
    public var urlTemplate: String
    public var headers: [MCPHeaderTemplate]
    public var inputs: [MCPInstallInput]
    public var transportHint: MCPEra?
    /// Where the candidate came from, e.g. "mcp-remote" for an unwrapped
    /// `npx mcp-remote <url>` entry. Display only.
    public var note: String?

    public init(name: String, urlTemplate: String, headers: [MCPHeaderTemplate] = [], inputs: [MCPInstallInput] = [],
                transportHint: MCPEra? = nil, note: String? = nil) {
        self.name = name
        self.urlTemplate = urlTemplate
        self.headers = headers
        self.inputs = inputs
        self.transportHint = transportHint
        self.note = note
    }

    /// The URL when it has no placeholders.
    public var url: URL? {
        Placeholders.keys(in: urlTemplate).isEmpty ? URL(string: urlTemplate) : nil
    }

    /// Builds the config. Secret header values are written to `secrets`
    /// under keys derived from the server id; the config only references
    /// them. Throws `MCPInstallError` for missing inputs or a bad URL.
    public func makeConfig(id: String = UUID().uuidString, values: [String: String] = [:], secrets: any SecretStore,
                           trusted: Bool = false) throws -> MCPServerConfig {
        func value(_ key: String) -> String? {
            if let v = values[key], !v.isEmpty { return v }
            return inputs.first { $0.key == key }?.defaultValue
        }
        let missing = inputs.filter { $0.isRequired && value($0.key) == nil }.map(\.key)
        guard missing.isEmpty else { throw MCPInstallError.missingInputs(missing) }

        let filled = Placeholders.fill(urlTemplate) { key in
            value(key).map { $0.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? $0 }
        }
        guard let filled, let url = URL(string: filled) else { throw MCPInstallError.invalidURL(urlTemplate) }
        try MCPInstaller.validate(url)

        var built: [MCPHeader] = []
        for template in headers {
            guard let text = Placeholders.fill(template.value, value: value) else { continue } // optional & absent
            let trimmed = text.trimmingCharacters(in: .whitespaces)
            // A bare "Bearer " left by an unfilled optional token isn't a header.
            if trimmed.isEmpty || trimmed.lowercased() == "bearer" { continue }
            if template.isSecret {
                let key = "mcp.header|\(id)|\(template.name.lowercased())"
                try secrets.setSecret(trimmed, for: key)
                built.append(MCPHeader(name: template.name, value: .secret(key: key)))
            } else {
                built.append(MCPHeader(name: template.name, value: .plain(trimmed)))
            }
        }
        return MCPServerConfig(id: id, name: name, url: url, headers: built,
                               auth: built.contains { if case .secret = $0.value { return true }; return false } ? .headers : .none,
                               trusted: trusted, transportHint: transportHint)
    }
}

public enum MCPInstallError: Error, Sendable, Hashable, LocalizedError {
    case invalidURL(String)
    case unsupportedScheme(String)
    case missingInputs([String])
    case invalidConfig(String)
    /// No payload: the URL itself holds the secret, so it must not be echoed.
    case credentialsInURL

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let s): return "“\(s)” isn't a valid server URL."
        case .credentialsInURL: return "Server URLs can't contain user:password@ credentials — put secrets in headers instead."
        case .unsupportedScheme(let s): return "MCP servers must be reached over https (got “\(s)”)."
        case .missingInputs(let keys): return "Fill in: \(keys.joined(separator: ", "))."
        case .invalidConfig(let m): return "That config couldn't be read: \(m)"
        }
    }
}

/// An entry the installer skipped, with a reason for the user.
public struct MCPInstallRejection: Error, Sendable, Hashable {
    public var name: String
    public var reason: String
    public init(name: String, reason: String) {
        self.name = name
        self.reason = reason
    }
}

public struct MCPImportResult: Sendable, Hashable {
    public var candidates: [MCPInstallCandidate]
    public var rejected: [MCPInstallRejection]
}

/// Turns what the user pastes into install candidates. Remote-only: an
/// entry that would start a process on the device (`command`, stdio,
/// npm/pypi/docker packages) is rejected with a reason — never run.
public enum MCPInstaller {
    public static let localProcessReason = "runs a local process — not supported on iPhone"

    /// A single pasted URL (`https://mcp.example.com/mcp`, possibly with
    /// `{variables}`).
    public static func parse(url raw: String, name: String? = nil) throws -> MCPInstallCandidate {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let probe = Placeholders.fill(text) { _ in "x" } ?? text
        guard let url = URL(string: probe), url.host() != nil else { throw MCPInstallError.invalidURL(text) }
        try validate(url)
        let inputs = Placeholders.keys(in: text).map { MCPInstallInput(key: $0, location: .url) }
        return MCPInstallCandidate(name: name ?? defaultName(for: url), urlTemplate: text, inputs: inputs,
                                   transportHint: url.path().hasSuffix("/sse") ? .legacySSE : nil)
    }

    /// Pasted JSON: `{"mcpServers": {…}}` (Claude Desktop, `.mcp.json`,
    /// Cursor), `{"servers": {…}}` / `{"mcp": {"servers": {…}}}` (VS Code),
    /// a bare name → entry map, a single entry, or a registry `server.json`.
    public static func parse(config text: String) throws -> MCPImportResult {
        let json: JSONValue
        do { json = try JSONValue(parsing: text) } catch { throw MCPInstallError.invalidConfig("not valid JSON") }
        guard let root = json.objectValue else { throw MCPInstallError.invalidConfig("expected a JSON object") }

        if root["remotes"] != nil || root["packages"] != nil {
            return MCPRegistryEntry(json: ["server": json]).map(importResult) ?? MCPImportResult(candidates: [], rejected: [])
        }
        if isEntry(root) { return collect([(nil, json)]) }

        let map = root["mcpServers"]?.objectValue ?? root["servers"]?.objectValue ?? root["mcp"]?["servers"]?.objectValue ?? root
        let entries = map.sorted { $0.key < $1.key }.map { (Optional($0.key), $0.value) }
        let result = collect(entries)
        if result.candidates.isEmpty && result.rejected.isEmpty {
            throw MCPInstallError.invalidConfig("no MCP servers found")
        }
        return result
    }

    static func importResult(_ entry: MCPRegistryEntry) -> MCPImportResult {
        guard !entry.remotes.isEmpty else {
            return MCPImportResult(candidates: [], rejected: [MCPInstallRejection(name: entry.displayName, reason: localProcessReason)])
        }
        return MCPImportResult(candidates: entry.remotes.map { entry.candidate(for: $0) }, rejected: [])
    }

    private static func isEntry(_ o: [String: JSONValue]) -> Bool {
        o["url"]?.stringValue != nil || o["serverUrl"]?.stringValue != nil || o["command"] != nil
    }

    private static func collect(_ entries: [(String?, JSONValue)]) -> MCPImportResult {
        var candidates: [MCPInstallCandidate] = []
        var rejected: [MCPInstallRejection] = []
        for (name, value) in entries {
            switch entry(name: name, value) {
            case .success(let c): candidates.append(c)
            case .failure(let r): rejected.append(r)
            }
        }
        return MCPImportResult(candidates: candidates, rejected: rejected)
    }

    private static func entry(name: String?, _ value: JSONValue) -> Result<MCPInstallCandidate, MCPInstallRejection> {
        let label = name ?? "server"
        guard let o = value.objectValue else { return .failure(MCPInstallRejection(name: label, reason: "not a server entry")) }
        let type = o["type"]?.stringValue?.lowercased() ?? o["transport"]?.stringValue?.lowercased()

        if let command = o["command"]?.stringValue {
            // `npx mcp-remote https://…` only proxies a remote server: we
            // can talk to that URL directly without running anything.
            let args = o["args"]?.arrayValue?.compactMap(\.stringValue) ?? []
            if let unwrapped = unwrapRemoteProxy(command: command, args: args, name: label) { return .success(unwrapped) }
            return .failure(MCPInstallRejection(name: label, reason: localProcessReason))
        }
        if type == "stdio" { return .failure(MCPInstallRejection(name: label, reason: localProcessReason)) }

        guard let rawURL = o["url"]?.stringValue ?? o["serverUrl"]?.stringValue else {
            return .failure(MCPInstallRejection(name: label, reason: "has no server URL"))
        }
        let hint: MCPEra?
        switch type {
        case nil, "http", "streamable-http", "streamablehttp", "streamable_http": hint = nil
        case "sse": hint = .legacySSE
        case let other?: return .failure(MCPInstallRejection(name: label, reason: "uses the “\(other)” transport, which isn't supported"))
        }

        var headers: [MCPHeaderTemplate] = []
        for (k, v) in (o["headers"]?.objectValue ?? [:]).sorted(by: { $0.key < $1.key }) {
            guard let s = v.stringValue else { continue }
            headers.append(MCPHeaderTemplate(name: k, value: s, isSecret: looksSecret(header: k, value: s)))
        }
        return candidate(name: name, urlTemplate: rawURL, headers: headers, hint: hint, note: nil)
    }

    private static func candidate(name: String?, urlTemplate: String, headers: [MCPHeaderTemplate], hint: MCPEra?,
                                  note: String?) -> Result<MCPInstallCandidate, MCPInstallRejection> {
        let label = name ?? "server"
        let probe = Placeholders.fill(urlTemplate) { _ in "x" } ?? urlTemplate
        guard let url = URL(string: probe), url.host() != nil else {
            return .failure(MCPInstallRejection(name: label, reason: "“\(urlTemplate)” isn't a valid URL"))
        }
        if url.user() != nil || url.password() != nil {
            return .failure(MCPInstallRejection(name: label, reason: "contains user:password@ credentials — move secrets to headers"))
        }
        do { try validate(url) } catch {
            return .failure(MCPInstallRejection(name: label, reason: "uses \(url.scheme ?? "an unknown scheme"):// — only https is supported"))
        }
        var inputs = Placeholders.keys(in: urlTemplate).map { MCPInstallInput(key: $0, location: .url) }
        for h in headers {
            for key in Placeholders.keys(in: h.value) where !inputs.contains(where: { $0.key == key }) {
                inputs.append(MCPInstallInput(key: key, location: .header(h.name), isSecret: h.isSecret))
            }
        }
        return .success(MCPInstallCandidate(name: name ?? defaultName(for: url), urlTemplate: urlTemplate, headers: headers,
                                            inputs: inputs, transportHint: hint, note: note))
    }

    /// `npx [-y] mcp-remote <url> [--header "Name: value"]…`
    private static func unwrapRemoteProxy(command: String, args: [String], name: String) -> MCPInstallCandidate? {
        let launcher = (command as NSString).lastPathComponent.lowercased()
        guard ["npx", "bunx", "pnpx", "pnpm", "yarn"].contains(launcher),
              let proxyIndex = args.firstIndex(where: { $0 == "mcp-remote" || $0.hasPrefix("mcp-remote@") }),
              let raw = args[(proxyIndex + 1)...].first(where: { $0.hasPrefix("https://") }) else { return nil }
        var headers: [MCPHeaderTemplate] = []
        var i = proxyIndex + 1
        while i < args.count {
            if args[i] == "--header", i + 1 < args.count, let colon = args[i + 1].firstIndex(of: ":") {
                let k = args[i + 1][..<colon].trimmingCharacters(in: .whitespaces)
                let v = args[i + 1][args[i + 1].index(after: colon)...].trimmingCharacters(in: .whitespaces)
                headers.append(MCPHeaderTemplate(name: k, value: v, isSecret: looksSecret(header: k, value: v)))
                i += 2
            } else {
                i += 1
            }
        }
        let hint: MCPEra? = args.contains("sse-only") || args.contains("--transport=sse-only") ? .legacySSE : nil
        guard case .success(let c) = candidate(name: name, urlTemplate: raw, headers: headers, hint: hint, note: "mcp-remote")
        else { return nil }
        return c
    }

    /// Only https; plain http is accepted for loopback (simulator / dev).
    /// Userinfo is refused everywhere: it would persist secrets in cleartext.
    static func validate(_ url: URL) throws {
        guard url.user() == nil, url.password() == nil else { throw MCPInstallError.credentialsInURL }
        switch url.scheme?.lowercased() {
        case "https"?: return
        case "http"? where ["localhost", "127.0.0.1", "::1"].contains(url.host()?.lowercased() ?? ""): return
        default: throw MCPInstallError.unsupportedScheme(url.scheme ?? "")
        }
    }

    static func looksSecret(header: String, value: String) -> Bool {
        let h = header.lowercased()
        if ["authorization", "proxy-authorization", "cookie"].contains(h) { return true }
        return ["key", "token", "secret", "auth", "password", "session"].contains { h.contains($0) }
    }

    /// "mcp.linear.app" → "Linear"; "example.com/github/mcp" → "Example".
    static func defaultName(for url: URL) -> String {
        let labels = (url.host() ?? "server").split(separator: ".").map(String.init)
        let generic: Set<String> = ["mcp", "api", "www", "server", "app", "com", "io", "dev", "ai", "net", "org", "co", "cloud"]
        let pick = labels.dropLast().first { !generic.contains($0.lowercased()) } ?? labels.first ?? "server"
        return pick.prefix(1).uppercased() + pick.dropFirst()
    }
}

// MARK: - Placeholders

/// `{name}` (registry), `${name}` / `${env:NAME}` / `${input:id}` (client
/// configs). Values are never read from the environment on device: every
/// placeholder becomes an input the user fills in.
enum Placeholders {
    private struct Match { var range: Range<String.Index>; var key: String }

    private static func matches(in s: String) -> [Match] {
        var out: [Match] = []
        var i = s.startIndex
        while i < s.endIndex {
            let dollar = s[i] == "$" && s.index(after: i) < s.endIndex && s[s.index(after: i)] == "{"
            if s[i] == "{" || dollar {
                let open = dollar ? s.index(after: i) : i
                guard let close = s[open...].firstIndex(of: "}") else { break }
                var key = String(s[s.index(after: open)..<close])
                for prefix in ["env:", "input:"] where key.hasPrefix(prefix) { key.removeFirst(prefix.count) }
                let valid = !key.isEmpty && key.unicodeScalars.allSatisfy {
                    CharacterSet.alphanumerics.contains($0) || "_-.".unicodeScalars.contains($0)
                }
                if valid { out.append(Match(range: i..<s.index(after: close), key: key)) }
                i = s.index(after: close)
            } else {
                i = s.index(after: i)
            }
        }
        return out
    }

    static func keys(in s: String) -> [String] {
        var seen = Set<String>()
        return matches(in: s).map(\.key).filter { seen.insert($0).inserted }
    }

    /// Nil when a placeholder has no value.
    static func fill(_ s: String, value: (String) -> String?) -> String? {
        var out = ""
        var cursor = s.startIndex
        for m in matches(in: s) {
            guard let v = value(m.key) else { return nil }
            out += s[cursor..<m.range.lowerBound]
            out += v
            cursor = m.range.upperBound
        }
        return out + s[cursor...]
    }
}
