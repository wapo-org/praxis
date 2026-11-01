import Foundation
import AgentCore

/// A server from the official MCP registry that can be reached by URL.
/// Packages-only entries (npm/pypi/docker — would run on the device) are
/// never produced.
public struct MCPRegistryEntry: Sendable, Hashable, Identifiable {
    public struct Remote: Sendable, Hashable {
        public var urlTemplate: String
        public var transportHint: MCPEra?
        public var headers: [MCPHeaderTemplate]
        /// URL variables and header placeholders / values to ask for.
        public var inputs: [MCPInstallInput]
    }

    /// Reverse-DNS registry name, e.g. `io.github.owner/server`.
    public var name: String
    public var title: String?
    public var description: String
    public var version: String?
    public var websiteURL: URL?
    public var repositoryURL: URL?
    public var remotes: [Remote]
    /// Registry status (`active`, `deprecated`, …).
    public var status: String?

    public var id: String { name }

    /// `title`, else the last path component of the name.
    public var displayName: String {
        if let title, !title.isEmpty { return title }
        return name.split(separator: "/").last.map(String.init) ?? name
    }

    public func candidate(for remote: Remote) -> MCPInstallCandidate {
        MCPInstallCandidate(name: displayName, urlTemplate: remote.urlTemplate, headers: remote.headers, inputs: remote.inputs,
                            transportHint: remote.transportHint, note: "registry")
    }

    /// Parses one `servers[]` item (`{"server": {…}, "_meta": {…}}`).
    /// Remotes with unsupported types are dropped; the entry keeps an empty
    /// `remotes` list when none is usable (callers filter those out).
    init?(json: JSONValue) {
        let server = json["server"] ?? json
        guard let name = server["name"]?.stringValue else { return nil }
        self.name = name
        self.title = server["title"]?.stringValue
        self.description = server["description"]?.stringValue ?? ""
        self.version = server["version"]?.stringValue
        self.websiteURL = server["websiteUrl"]?.stringValue.flatMap(URL.init(string:))
        self.repositoryURL = server["repository"]?["url"]?.stringValue.flatMap(URL.init(string:))
        self.status = json["_meta"]?["io.modelcontextprotocol.registry/official"]?["status"]?.stringValue
        self.remotes = (server["remotes"]?.arrayValue ?? []).compactMap(Self.remote)
    }

    private static func remote(_ json: JSONValue) -> Remote? {
        let hint: MCPEra?
        switch json["type"]?.stringValue?.lowercased() {
        case "streamable-http"?: hint = nil
        case "sse"?: hint = .legacySSE
        default: return nil
        }
        guard let url = json["url"]?.stringValue, !url.isEmpty else { return nil }
        let probe = Placeholders.fill(url) { _ in "x" } ?? url
        guard let parsed = URL(string: probe), (try? MCPInstaller.validate(parsed)) != nil else { return nil }

        var inputs: [MCPInstallInput] = []
        let variables = json["variables"]?.objectValue ?? [:]
        for key in Placeholders.keys(in: url) {
            inputs.append(input(key: key, location: .url, json: variables[key]))
        }
        var headers: [MCPHeaderTemplate] = []
        for h in json["headers"]?.arrayValue ?? [] {
            guard let headerName = h["name"]?.stringValue, !headerName.isEmpty else { continue }
            let isSecret = h["isSecret"]?.boolValue ?? MCPInstaller.looksSecret(header: headerName, value: "")
            // A fixed value is used as is unless it's declared secret (then
            // it is only a default for the user's own value).
            if let template = h["value"]?.stringValue, !Placeholders.keys(in: template).isEmpty || h["isSecret"]?.boolValue != true {
                // Fixed value or a template like "Bearer {api_key}".
                headers.append(MCPHeaderTemplate(name: headerName, value: template, isSecret: isSecret))
                let headerVars = h["variables"]?.objectValue ?? [:]
                for key in Placeholders.keys(in: template) where !inputs.contains(where: { $0.key == key }) {
                    var i = input(key: key, location: .header(headerName), json: headerVars[key])
                    i.isSecret = i.isSecret || isSecret
                    if i.description == nil { i.description = h["description"]?.stringValue }
                    if h["isRequired"]?.boolValue == false { i.isRequired = false }
                    inputs.append(i)
                }
            } else {
                // The whole header value is user input.
                let key = headerName
                headers.append(MCPHeaderTemplate(name: headerName, value: "{\(key)}", isSecret: isSecret))
                inputs.append(MCPInstallInput(key: key, location: .header(headerName), description: h["description"]?.stringValue,
                                              isRequired: h["isRequired"]?.boolValue ?? false, isSecret: isSecret,
                                              defaultValue: h["default"]?.stringValue ?? h["value"]?.stringValue,
                                              choices: h["choices"]?.arrayValue?.compactMap(\.stringValue) ?? []))
            }
        }
        return Remote(urlTemplate: url, transportHint: hint, headers: headers, inputs: inputs)
    }

    private static func input(key: String, location: MCPInstallInput.Location, json: JSONValue?) -> MCPInstallInput {
        MCPInstallInput(key: key, location: location, description: json?["description"]?.stringValue,
                        isRequired: json?["isRequired"]?.boolValue ?? true, isSecret: json?["isSecret"]?.boolValue ?? false,
                        defaultValue: json?["default"]?.stringValue,
                        choices: json?["choices"]?.arrayValue?.compactMap(\.stringValue) ?? [])
    }
}

public struct MCPRegistryPage: Sendable, Hashable {
    public var entries: [MCPRegistryEntry]
    /// Pass back to `list(cursor:)`; nil on the last page.
    public var nextCursor: String?
}

/// Read-only client for `registry.modelcontextprotocol.io` (`GET
/// /v0.1/servers`, cursor pagination). Pages are filtered client-side, so
/// a page can hold fewer than `limit` entries — keep paging on
/// `nextCursor`, not on the count.
public struct MCPRegistryClient: Sendable {
    public static let officialBaseURL = URL(string: "https://registry.modelcontextprotocol.io")!

    private let transport: any HTTPTransport
    private let baseURL: URL

    public init(transport: any HTTPTransport = URLSessionTransport(), baseURL: URL = MCPRegistryClient.officialBaseURL) {
        self.transport = transport
        self.baseURL = baseURL
    }

    /// One page of the latest versions, optionally filtered by a
    /// case-insensitive name substring.
    public func list(search: String? = nil, cursor: String? = nil, limit: Int = 50) async throws -> MCPRegistryPage {
        var components = URLComponents(url: baseURL.appending(path: "v0.1/servers"), resolvingAgainstBaseURL: false)
        var query = [URLQueryItem(name: "version", value: "latest"), URLQueryItem(name: "limit", value: String(limit))]
        if let search, !search.isEmpty { query.append(URLQueryItem(name: "search", value: search)) }
        if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
        components?.queryItems = query
        guard let url = components?.url else { throw MCPError.protocolViolation("bad registry URL") }
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, head) = try await transport.data(request, limit: 8 << 20)
        guard head.isSuccess else { throw MCPError.http(status: head.status, message: MCPWire.snippet(data)) }
        guard let json = try? JSONValue(parsing: data) else { throw MCPError.protocolViolation("the registry reply wasn't JSON") }
        return Self.page(json)
    }

    static func page(_ json: JSONValue) -> MCPRegistryPage {
        let entries = (json["servers"]?.arrayValue ?? []).compactMap(MCPRegistryEntry.init(json:))
            .filter { !$0.remotes.isEmpty && $0.status != "deleted" }
        let next = json["metadata"]?["nextCursor"]?.stringValue
        return MCPRegistryPage(entries: entries, nextCursor: next?.isEmpty == true ? nil : next)
    }
}
