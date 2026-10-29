import Foundation
import AgentCore

// Mirrors cloud/packages/protocol. These are presentation/catalog values;
// authentication, transport and run DTOs belong to CloudProtocol (C-net).
struct CloudCatalogPage<Item: Decodable & Sendable>: Decodable, Sendable {
    var type: String
    var items: [Item]
    var nextCursor: String?
}

struct CloudCatalogCapabilities: Codable, Sendable, Equatable {
    var type = "capabilities"
    var tools = true
    var parallelToolCalls = false
    var vision = false
    var documents = false
    var imagesInToolResults = false
    var reasoningEffort = false
    var streamUsage = false
    var explicitPromptCaching = false
    var serverWebSearch = false
    var midConversationSystem = false
    var serverCompaction = false
    var toolSearch = false
}

struct CloudCatalogProvider: Codable, Identifiable, Sendable, Equatable {
    var type = "provider"
    var id: String
    var name: String
    var flavor: String
    var baseUrl: String
    var maskedKey: String
    var capabilities: CloudCatalogCapabilities
    var updatedAt: String
}

/// Never persisted. Only the editor's short-lived request owns apiKey.
struct CloudCatalogProviderInput: Encodable, Sendable {
    var type = "provider.input"
    var name: String
    var flavor: String
    var baseUrl: String
    var apiKey: String?
    var capabilities: CloudCatalogCapabilities?
    var extraHeaders: [String: String]?
}

struct CloudCatalogModel: Codable, Identifiable, Sendable, Equatable {
    var type = "model"
    var id: String
    var providerId: String
    var displayName: String
    var contextWindow: Int?
    var maxOutputTokens: Int?
    var capabilities: CloudCatalogCapabilities
    var reasoningEfforts: [String]
    var pinned: Bool
    var favorite: Bool

    /// Provider IDs and model IDs are opaque. A JSON pair avoids collisions
    /// even when a model ID contains slashes or is offered by two providers.
    var selectionID: String {
        let pair = (try? JSONEncoder().encode([providerId, id])) ?? Data()
        return "cloud:" + pair.base64EncodedString()
    }

    func aiModel(providerName: String?) -> AIModel {
        AIModel(id: selectionID, name: displayName,
                tagline: providerName ?? providerId, speed: 0, intelligence: 0,
                streamMultiplier: 1,
                effortLevels: reasoningEfforts.compactMap(Effort.init(rawValue:)))
    }
}

struct CloudCatalogModelPreference: Encodable, Sendable {
    var type = "model.preference"
    var providerId: String
    var modelId: String
    var pinned: Bool?
    var favorite: Bool?
}

struct CloudCatalogConnector: Codable, Identifiable, Sendable, Equatable {
    var type = "connector"
    var id: String
    var name: String
    var url: String
    var transport: String
    var enabled: Bool
    var trusted: Bool
    var disabledTools: [String]
    var authStatus: String
    var updatedAt: String

    func adapter(isOn: Bool) -> Connector {
        Connector(id: id, name: name, monogram: String(name.prefix(1)).uppercased(),
                  isOn: enabled && isOn, lockedReason: enabled ? nil : "Off in Settings")
    }
}

struct CloudCatalogConnectorInput: Encodable, Sendable {
    var type = "connector.input"
    var name: String
    var url: String
    var transport = "streamableHttp"
    var enabled = true
    var trusted = false
    var disabledTools: [String] = []
    var token: String?
}

struct CloudCatalogConnectorPatch: Encodable, Sendable {
    var type = "connector.patch"
    var name: String?
    var url: String?
    var transport: String?
    var enabled: Bool?
    var trusted: Bool?
    var disabledTools: [String]?
    var token: String?
}

struct CloudCatalogTool: Decodable, Identifiable, Sendable, Equatable {
    var type: String
    var name: String
    var description: String
    var id: String { name }
}

struct CloudCatalogConsent: Codable, Identifiable, Sendable, Equatable {
    var type = "consent"
    var host: String
    var allowed: Bool
    var updatedAt: String?
    var id: String { host }
}

struct CloudCatalogSkill: Codable, Identifiable, Sendable, Equatable {
    var type = "skill"
    var id: String
    var name: String
    var description: String
    var document: String
    var enabled: Bool
    var updatedAt: String
}

struct CloudCatalogSkillInput: Encodable, Sendable {
    var type = "skill.input"
    var name: String
    var description: String
    var document: String
    var enabled = true
}

struct CloudCatalogRegistry: Codable, Identifiable, Sendable, Equatable {
    var type = "skill.registry"
    var id: String
    var name: String
    var url: String
    var enabled: Bool
}

struct CloudCatalogRegistryInput: Encodable, Sendable {
    var type = "skill.registry.input"
    var name: String
    var url: String
    var enabled = true
}

struct CloudCatalogProbe: Decodable, Sendable {
    var type: String
    var ok: Bool
    var models: [CloudCatalogModel]
}

struct CloudCatalogOAuthAuthorization: Decodable, Sendable {
    var type: String
    var url: URL
    var state: String
}

// The v0 document specifies MCP resource/prompt routes, retaining MCP's
// typed names, arguments and text content. Unknown optional fields are ignored.
struct CloudCatalogPrompt: Decodable, Identifiable, Sendable, Equatable {
    struct Argument: Decodable, Sendable, Equatable {
        var name: String
        var title: String?
        var description: String?
        var required: Bool?
    }
    var name: String
    var title: String?
    var description: String?
    var arguments: [Argument]?
    var id: String { name }
    var displayTitle: String { title ?? name }
}

struct CloudCatalogPromptResult: Decodable, Sendable {
    struct Message: Decodable, Sendable {
        struct Content: Decodable, Sendable { var type: String; var text: String? }
        var role: String
        var content: Content
    }
    var messages: [Message]
    var composerText: String { messages.compactMap(\.content.text).joined(separator: "\n\n") }
}

struct CloudCatalogResource: Decodable, Identifiable, Sendable, Equatable {
    var uri: String
    var name: String
    var title: String?
    var description: String?
    var mimeType: String?
    var id: String { uri }
}

struct CloudCatalogResourceResult: Decodable, Sendable {
    struct Content: Decodable, Sendable {
        var uri: String
        var mimeType: String?
        var text: String?
    }
    var contents: [Content]
}

struct CloudCatalogTranscription: Decodable, Sendable {
    struct Segment: Decodable, Sendable { var start: Double; var end: Double; var text: String }
    var type: String
    var text: String
    var language: String?
    var segments: [Segment]
}

/// Encodes path components and query items separately; model/tool IDs and
/// search text must never escape into another API route or filter.
enum CloudCatalogPath {
    static func component(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? ""
    }
    static func list(_ path: String, query: [URLQueryItem] = []) -> String {
        var parts = URLComponents()
        parts.percentEncodedPath = path
        parts.queryItems = query.isEmpty ? nil : query
        return parts.string ?? path
    }
}

struct CloudCatalogRegistryEntry: Decodable, Identifiable, Sendable {
    var type: String
    var id: String
    var name: String
    var description: String
    var url: String?
}

struct CloudCatalogPreferences: Decodable, Sendable {
    struct Vision: Decodable, Sendable {
        var providerId: String?
        var modelId: String?
        var enabled: Bool
    }
    struct Voice: Decodable, Sendable {
        var model: String
        var language: String?
        var configured: Bool
    }
    var type: String
    var vision: Vision
    var voice: Voice
    var updatedAt: String
}

struct CloudCatalogPreferencesInput: Encodable, Sendable {
    struct Vision: Encodable, Sendable { var providerId: String?; var modelId: String?; var enabled: Bool? }
    struct Voice: Encodable, Sendable { var model: String?; var language: String?; var apiKey: String? }
    var type = "preferences.input"
    var vision: Vision?
    var voice: Voice?
}
