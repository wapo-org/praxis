import Foundation
import AgentCore

/// A tool as listed by `tools/list`. Codable so the app can freeze the
/// list into a conversation.
public struct MCPToolDefinition: Sendable, Codable, Hashable {
    public var name: String
    public var title: String?
    public var description: String
    public var inputSchema: JSONValue
    public var outputSchema: JSONValue?
    public var annotations: MCPToolAnnotations

    public init(name: String, title: String? = nil, description: String = "", inputSchema: JSONValue = ["type": "object"],
                outputSchema: JSONValue? = nil, annotations: MCPToolAnnotations = MCPToolAnnotations()) {
        self.name = name
        self.title = title
        self.description = description
        self.inputSchema = inputSchema
        self.outputSchema = outputSchema
        self.annotations = annotations
    }

    init?(json: JSONValue) {
        guard let name = json["name"]?.stringValue, !name.isEmpty else { return nil }
        let a = json["annotations"]
        self.init(
            name: name,
            title: json["title"]?.stringValue,
            description: json["description"]?.stringValue ?? "",
            inputSchema: json["inputSchema"].flatMap { $0.objectValue != nil ? $0 : nil } ?? ["type": "object"],
            outputSchema: json["outputSchema"],
            annotations: MCPToolAnnotations(title: a?["title"]?.stringValue,
                                            readOnlyHint: a?["readOnlyHint"]?.boolValue,
                                            destructiveHint: a?["destructiveHint"]?.boolValue,
                                            idempotentHint: a?["idempotentHint"]?.boolValue,
                                            openWorldHint: a?["openWorldHint"]?.boolValue))
    }

    /// Spec display precedence: `title`, `annotations.title`, `name`.
    public var displayTitle: String { title ?? annotations.title ?? name }
}

/// Behaviour hints. Untrusted unless the user trusts the server.
/// Spec defaults: readOnly false, destructive true, idempotent false,
/// openWorld true.
public struct MCPToolAnnotations: Sendable, Codable, Hashable {
    public var title: String?
    public var readOnlyHint: Bool?
    public var destructiveHint: Bool?
    public var idempotentHint: Bool?
    public var openWorldHint: Bool?

    public init(title: String? = nil, readOnlyHint: Bool? = nil, destructiveHint: Bool? = nil,
                idempotentHint: Bool? = nil, openWorldHint: Bool? = nil) {
        self.title = title
        self.readOnlyHint = readOnlyHint
        self.destructiveHint = destructiveHint
        self.idempotentHint = idempotentHint
        self.openWorldHint = openWorldHint
    }

    public var traits: ToolTraits {
        var t: ToolTraits = []
        let readOnly = readOnlyHint ?? false
        if readOnly {
            t.insert(.readOnly)
        } else if destructiveHint ?? true {
            // destructiveHint is only meaningful when not read-only.
            t.insert(.destructive)
        }
        if idempotentHint ?? false { t.insert(.idempotent) }
        if openWorldHint ?? true { t.insert(.openWorld) }
        return t
    }
}

/// The result of `tools/call`.
public struct MCPCallResult: Sendable, Hashable {
    public var content: [MCPContent]
    public var structuredContent: JSONValue?
    public var isError: Bool

    public init(content: [MCPContent], structuredContent: JSONValue? = nil, isError: Bool = false) {
        self.content = content
        self.structuredContent = structuredContent
        self.isError = isError
    }

    init(json: JSONValue) {
        self.init(content: (json["content"]?.arrayValue ?? []).map(MCPContent.init(json:)),
                  structuredContent: json["structuredContent"],
                  isError: json["isError"]?.boolValue ?? false)
    }

    /// Model-facing output: text and images as blocks; audio and binary
    /// resources as short text stubs; `structuredContent` as compact JSON
    /// only when no text block already carries it.
    public func toolOutput() -> ToolOutput {
        var blocks: [ToolResultContent] = []
        for item in content {
            switch item {
            case .text(let t):
                blocks.append(.text(t))
            case .image(let media):
                blocks.append(.image(media))
            case .audio(let mime, let bytes):
                blocks.append(.text("[audio \(mime), \(bytes) bytes — audio isn't shown to the model]"))
            case .resourceLink(let uri, let name, let title, let description, let mime):
                var line = "[resource link] \(title ?? name) — \(uri)"
                if let mime { line += " (\(mime))" }
                if let description, !description.isEmpty { line += "\n\(description)" }
                blocks.append(.text(line))
            case .resource(let uri, let mime, let text, let blob):
                if let text {
                    blocks.append(.text("[resource \(uri)]\n\(text)"))
                } else if let blob, let mime, mime.hasPrefix("image/") {
                    blocks.append(.image(MediaData(mediaType: mime, data: blob, name: uri)))
                } else {
                    blocks.append(.text("[binary resource \(uri)\(mime.map { ", \($0)" } ?? ""), \(blob?.count ?? 0) bytes]"))
                }
            case .unsupported(let type):
                blocks.append(.text("[unsupported \(type) content]"))
            }
        }
        if let structured = structuredContent, !structured.isNull, !blocks.contains(where: { $0.text != nil }) {
            blocks.append(.text(structured.encodedString()))
        }
        if blocks.isEmpty { blocks = [.text(isError ? "The tool failed without a message." : "(no output)")] }
        return ToolOutput(content: blocks, isError: isError)
    }
}

public enum MCPContent: Sendable, Hashable {
    case text(String)
    case image(MediaData)
    case audio(mimeType: String, byteCount: Int)
    case resourceLink(uri: String, name: String, title: String?, description: String?, mimeType: String?)
    /// Embedded resource: `text` or decoded `blob`.
    case resource(uri: String, mimeType: String?, text: String?, blob: Data?)
    case unsupported(type: String)

    public var textValue: String? {
        if case .text(let t) = self { return t }
        return nil
    }

    init(json: JSONValue) {
        let type = json["type"]?.stringValue ?? "unknown"
        switch type {
        case "text":
            self = .text(json["text"]?.stringValue ?? "")
        case "image":
            if let data = json["data"]?.stringValue.flatMap({ Data(base64Encoded: $0, options: .ignoreUnknownCharacters) }) {
                self = .image(MediaData(mediaType: json["mimeType"]?.stringValue ?? "image/png", data: data))
            } else {
                self = .unsupported(type: "image (undecodable)")
            }
        case "audio":
            let bytes = json["data"]?.stringValue.flatMap { Data(base64Encoded: $0, options: .ignoreUnknownCharacters) }?.count ?? 0
            self = .audio(mimeType: json["mimeType"]?.stringValue ?? "audio", byteCount: bytes)
        case "resource_link":
            self = .resourceLink(uri: json["uri"]?.stringValue ?? "", name: json["name"]?.stringValue ?? "resource",
                                 title: json["title"]?.stringValue, description: json["description"]?.stringValue,
                                 mimeType: json["mimeType"]?.stringValue)
        case "resource":
            let r = json["resource"]
            self = .resource(uri: r?["uri"]?.stringValue ?? "", mimeType: r?["mimeType"]?.stringValue,
                             text: r?["text"]?.stringValue,
                             blob: r?["blob"]?.stringValue.flatMap { Data(base64Encoded: $0, options: .ignoreUnknownCharacters) })
        default:
            self = .unsupported(type: type)
        }
    }
}

// MARK: - Elicitation

/// The app shows a form sheet or a URL consent sheet. Implementations
/// must name the requesting server, let the user decline, and for URLs
/// show the full URL and open it only after consent, in a browser the app
/// can't inspect (SFSafariViewController / ASWebAuthenticationSession).
public protocol MCPElicitationHandler: Sendable {
    func elicit(_ request: MCPElicitation) async -> MCPElicitationResult
}

public struct MCPElicitation: Sendable, Hashable {
    public enum Kind: Sendable, Hashable {
        /// Flat object schema of primitive fields (spec-restricted subset).
        case form(schema: JSONValue)
        /// Out-of-band interaction; the client never sees what's entered.
        case url(URL)
    }

    public var serverID: String
    public var serverName: String
    public var message: String
    public var kind: Kind

    public init(serverID: String, serverName: String, message: String, kind: Kind) {
        self.serverID = serverID
        self.serverName = serverName
        self.message = message
        self.kind = kind
    }

    /// Parses `elicitation/create` params; nil for unknown modes.
    init?(params: JSONValue, server: MCPServerConfig) {
        let message = params["message"]?.stringValue ?? ""
        switch params["mode"]?.stringValue ?? "form" {
        case "form":
            self.init(serverID: server.id, serverName: server.name, message: message,
                      kind: .form(schema: params["requestedSchema"] ?? ["type": "object", "properties": [:]]))
        case "url":
            guard let raw = params["url"]?.stringValue, let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
                  ["https", "http"].contains(scheme) else { return nil }
            self.init(serverID: server.id, serverName: server.name, message: message, kind: .url(url))
        default:
            return nil
        }
    }
}

public enum MCPElicitationResult: Sendable, Hashable {
    /// Form content (an object of primitives); nil for URL mode.
    case accept(JSONValue?)
    case decline
    case cancel

    var json: JSONValue {
        switch self {
        case .accept(let content?): return ["action": "accept", "content": content]
        case .accept(nil): return ["action": "accept"]
        case .decline: return ["action": "decline"]
        case .cancel: return ["action": "cancel"]
        }
    }
}
