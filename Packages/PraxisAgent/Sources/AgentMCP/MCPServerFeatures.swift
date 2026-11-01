import Foundation
import AgentCore

/// What a server said it supports (`capabilities` from `server/discover`
/// or `initialize`), reduced to what this client acts on.
public struct MCPServerFeatures: Sendable, Codable, Hashable {
    public var tools: Bool
    public var toolsListChanged: Bool
    public var resources: Bool
    public var resourcesListChanged: Bool
    /// Per-resource `notifications/resources/updated` (legacy
    /// `resources/subscribe`, modern `resourceSubscriptions`).
    public var resourcesSubscribe: Bool
    public var prompts: Bool
    public var promptsListChanged: Bool

    public init(tools: Bool = true, toolsListChanged: Bool = false, resources: Bool = false, resourcesListChanged: Bool = false,
                resourcesSubscribe: Bool = false, prompts: Bool = false, promptsListChanged: Bool = false) {
        self.tools = tools
        self.toolsListChanged = toolsListChanged
        self.resources = resources
        self.resourcesListChanged = resourcesListChanged
        self.resourcesSubscribe = resourcesSubscribe
        self.prompts = prompts
        self.promptsListChanged = promptsListChanged
    }

    public init(capabilities: JSONValue) {
        func flag(_ section: String, _ key: String) -> Bool { capabilities[section]?[key]?.boolValue ?? false }
        func has(_ section: String) -> Bool { capabilities[section]?.objectValue != nil }
        self.init(tools: has("tools"), toolsListChanged: flag("tools", "listChanged"),
                  resources: has("resources"), resourcesListChanged: flag("resources", "listChanged"),
                  resourcesSubscribe: flag("resources", "subscribe"),
                  prompts: has("prompts"), promptsListChanged: flag("prompts", "listChanged"))
    }

    /// Anything worth keeping a change-notification stream open for.
    var wantsNotifications: Bool { toolsListChanged || resourcesListChanged || resourcesSubscribe || promptsListChanged }
}

// MARK: - Resources

/// An entry from `resources/list`.
public struct MCPResource: Sendable, Codable, Hashable {
    public var uri: String
    public var name: String
    public var title: String?
    public var description: String?
    public var mimeType: String?
    public var size: Int?

    public init(uri: String, name: String, title: String? = nil, description: String? = nil, mimeType: String? = nil, size: Int? = nil) {
        self.uri = uri
        self.name = name
        self.title = title
        self.description = description
        self.mimeType = mimeType
        self.size = size
    }

    init?(json: JSONValue) {
        guard let uri = json["uri"]?.stringValue, !uri.isEmpty else { return nil }
        self.init(uri: uri, name: json["name"]?.stringValue ?? uri, title: json["title"]?.stringValue,
                  description: json["description"]?.stringValue, mimeType: json["mimeType"]?.stringValue,
                  size: json["size"]?.intValue)
    }
}

/// An entry from `resources/templates/list` (RFC 6570 URI template).
public struct MCPResourceTemplate: Sendable, Codable, Hashable {
    public var uriTemplate: String
    public var name: String
    public var title: String?
    public var description: String?
    public var mimeType: String?

    public init(uriTemplate: String, name: String, title: String? = nil, description: String? = nil, mimeType: String? = nil) {
        self.uriTemplate = uriTemplate
        self.name = name
        self.title = title
        self.description = description
        self.mimeType = mimeType
    }

    init?(json: JSONValue) {
        guard let template = json["uriTemplate"]?.stringValue, !template.isEmpty else { return nil }
        self.init(uriTemplate: template, name: json["name"]?.stringValue ?? template, title: json["title"]?.stringValue,
                  description: json["description"]?.stringValue, mimeType: json["mimeType"]?.stringValue)
    }
}

/// A page of `resources/list` (templates only on the first page).
public struct MCPResourcePage: Sendable, Hashable {
    public var resources: [MCPResource]
    public var templates: [MCPResourceTemplate]
    public var nextCursor: String?
    public init(resources: [MCPResource], templates: [MCPResourceTemplate] = [], nextCursor: String? = nil) {
        self.resources = resources
        self.templates = templates
        self.nextCursor = nextCursor
    }
}

/// One item of a `resources/read` result: text or decoded binary.
public struct MCPResourceContents: Sendable, Hashable {
    public var uri: String
    public var mimeType: String?
    public var text: String?
    public var blob: Data?

    public init(uri: String, mimeType: String? = nil, text: String? = nil, blob: Data? = nil) {
        self.uri = uri
        self.mimeType = mimeType
        self.text = text
        self.blob = blob
    }

    init(json: JSONValue) {
        self.init(uri: json["uri"]?.stringValue ?? "", mimeType: json["mimeType"]?.stringValue,
                  text: json["text"]?.stringValue,
                  blob: json["blob"]?.stringValue.flatMap { Data(base64Encoded: $0, options: .ignoreUnknownCharacters) })
    }

    /// Model-facing blocks: text as is, images as image content, other
    /// binary as a short stub (UTF-8 text-like blobs are decoded).
    func toolContent() -> [ToolResultContent] {
        if let text { return [.text("[resource \(uri)\(mimeType.map { ", \($0)" } ?? "")]\n\(text)")] }
        guard let blob else { return [.text("[resource \(uri): empty]")] }
        let mime = mimeType?.lowercased() ?? ""
        if mime.hasPrefix("image/") { return [.image(MediaData(mediaType: mime, data: blob, name: uri))] }
        if Self.isTextual(mime), let decoded = String(data: blob, encoding: .utf8) {
            return [.text("[resource \(uri), \(mime)]\n\(decoded)")]
        }
        return [.text("[binary resource \(uri)\(mime.isEmpty ? "" : ", \(mime)"), \(blob.count) bytes — not shown to the model]")]
    }

    static func isTextual(_ mime: String) -> Bool {
        mime.hasPrefix("text/") || mime.hasSuffix("+json") || mime.hasSuffix("+xml")
            || ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/javascript",
                "application/sql", "application/toml"].contains(mime)
    }
}

// MARK: - Prompts

/// An entry from `prompts/list`.
public struct MCPPrompt: Sendable, Codable, Hashable, Identifiable {
    public struct Argument: Sendable, Codable, Hashable {
        public var name: String
        public var title: String?
        public var description: String?
        public var required: Bool
        public init(name: String, title: String? = nil, description: String? = nil, required: Bool = false) {
            self.name = name
            self.title = title
            self.description = description
            self.required = required
        }
    }

    public var name: String
    public var title: String?
    public var description: String?
    public var arguments: [Argument]

    public var id: String { name }
    public var displayTitle: String { title ?? name }

    public init(name: String, title: String? = nil, description: String? = nil, arguments: [Argument] = []) {
        self.name = name
        self.title = title
        self.description = description
        self.arguments = arguments
    }

    init?(json: JSONValue) {
        guard let name = json["name"]?.stringValue, !name.isEmpty else { return nil }
        let args = (json["arguments"]?.arrayValue ?? []).compactMap { item -> Argument? in
            guard let n = item["name"]?.stringValue, !n.isEmpty else { return nil }
            return Argument(name: n, title: item["title"]?.stringValue, description: item["description"]?.stringValue,
                            required: item["required"]?.boolValue ?? false)
        }
        self.init(name: name, title: json["title"]?.stringValue, description: json["description"]?.stringValue, arguments: args)
    }
}

/// The result of `prompts/get`.
public struct MCPPromptResult: Sendable, Hashable {
    public struct Message: Sendable, Hashable {
        /// `user` or `assistant`.
        public var role: String
        public var content: MCPContent
        public init(role: String, content: MCPContent) {
            self.role = role
            self.content = content
        }
    }

    public var description: String?
    public var messages: [Message]

    public init(description: String? = nil, messages: [Message]) {
        self.description = description
        self.messages = messages
    }

    init(json: JSONValue) {
        let messages = (json["messages"]?.arrayValue ?? []).map { item in
            // Older servers sent `content` as an array; accept both.
            let content = item["content"]?.arrayValue?.first ?? item["content"] ?? [:]
            return Message(role: item["role"]?.stringValue ?? "user", content: MCPContent(json: content))
        }
        self.init(description: json["description"]?.stringValue, messages: messages)
    }

    /// Text to put in the composer. A prompt with assistant turns keeps
    /// them labelled, so nothing is silently attributed to the user.
    public var composerText: String {
        let mixed = messages.contains { $0.role != "user" }
        let parts: [String] = messages.compactMap { message in
            let text: String?
            switch message.content {
            case .text(let t): text = t
            case .resource(let uri, _, let body?, _): text = "[\(uri)]\n\(body)"
            case .resourceLink(let uri, let name, let title, _, _): text = "\(title ?? name): \(uri)"
            default: text = nil
            }
            guard let text, !text.isEmpty else { return nil }
            return mixed ? "\(message.role == "user" ? "User" : "Assistant"): \(text)" : text
        }
        return parts.joined(separator: "\n\n")
    }

    /// Images in the prompt's messages (the app can attach them).
    public var images: [MediaData] {
        messages.compactMap { message in
            switch message.content {
            case .image(let media): return media
            case .resource(_, let mime?, nil, let blob?) where mime.hasPrefix("image/"): return MediaData(mediaType: mime, data: blob)
            default: return nil
            }
        }
    }
}

// MARK: - Events

/// What a client tells the app outside of a request's result: the server
/// wants credentials, or a change notification arrived.
public enum MCPClientEvent: Sendable, Hashable {
    /// A call failed because the server needs (new) credentials. Offer
    /// "Sign in" for this server.
    case authorizationRequired(MCPAuthRequirement)
    /// `notifications/tools/list_changed`: the tool cache was dropped.
    case toolsListChanged
    case promptsListChanged
    case resourcesListChanged
    /// `notifications/resources/updated` for a subscribed resource.
    case resourceUpdated(uri: String)
}

/// What the server's protected-resource metadata (RFC 9728) says about
/// signing in, found even when the server answers without credentials.
public struct MCPSignInOffer: Sendable, Hashable {
    /// `.oauthAutomatic` (Dynamic Client Registration works) or
    /// `.oauthNeedsClientCredentials` (bring your own client ID), or
    /// `.unsupported` (e.g. no PKCE).
    public var requirement: MCPAuthRequirement
    public var issuer: String
    /// `scopes_supported` from the protected-resource metadata.
    public var scopes: [String]
    /// What sign-in asks for unless the user picks otherwise: a
    /// least-privilege subset of `scopes` (`MCPScopeSelection.defaults`).
    public var recommendedScopes: [String]

    public init(requirement: MCPAuthRequirement, issuer: String, scopes: [String], recommendedScopes: [String]? = nil) {
        self.requirement = requirement
        self.issuer = issuer
        self.scopes = scopes
        self.recommendedScopes = recommendedScopes ?? scopes
    }
}
