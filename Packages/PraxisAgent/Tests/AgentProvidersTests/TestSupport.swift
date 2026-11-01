import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentProviders

struct FixtureMissing: Error { let name: String }
struct NoRawPayload: Error {}

/// The stored provider payload of an assistant message as JSON.
func rawJSON(_ message: Message) throws -> JSONValue {
    guard let raw = message.raw else { throw NoRawPayload() }
    return try JSONValue(parsing: raw.data)
}

/// Anthropic raw payloads are a `content` block array.
func rawBlocks(_ message: Message) throws -> [JSONValue] {
    guard let blocks = try rawJSON(message).arrayValue else { throw NoRawPayload() }
    return blocks
}

enum Fixture {
    static func data(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Fixtures") else {
            throw FixtureMissing(name: name)
        }
        return try Data(contentsOf: url)
    }

    static func text(_ name: String) throws -> String { String(decoding: try data(name), as: UTF8.self) }

    static func sse(_ name: String, chunkSize: Int = 7) throws -> ScriptedTransport.Reply {
        .sse(try text(name), chunkSize: chunkSize)
    }

    static func json(_ name: String) throws -> ScriptedTransport.Reply { .json(try text(name)) }
}

let testKey = "sk-test-0123456789"

func anthropicEndpoint(_ capabilities: Capabilities? = nil, options: AnthropicOptions? = nil, key: String = testKey) -> ProviderEndpoint {
    var e = ProviderPreset.anthropic.endpoint(apiKey: key)!
    if let capabilities { e.capabilities = capabilities }
    if let options { e.anthropic = options }
    return e
}

func openAIEndpoint(_ capabilities: Capabilities? = nil, options: OpenAIOptions? = nil, key: String = testKey) -> ProviderEndpoint {
    var e = ProviderPreset.openAI.endpoint(apiKey: key)!
    if let capabilities { e.capabilities = capabilities }
    if let options { e.openAI = options }
    return e
}

func request(_ messages: [Message], system: String = "You are helpful.", tools: [ToolSpec] = [],
             effort: Effort = .medium, maxTokens: Int = 4096, webSearch: Bool = false) -> ProviderRequest {
    ProviderRequest(model: "test-model", system: system, messages: messages, tools: tools, maxTokens: maxTokens,
                    effort: effort, serverWebSearch: webSearch)
}

let weatherTool = ToolSpec(name: "get_weather", description: "Weather for a city",
                           inputSchema: ["type": "object", "properties": ["location": ["type": "string"]], "required": ["location"]])

/// Runs a stream to the end, returning every event (throws like the stream).
func collect(_ stream: AsyncThrowingStream<ProviderEvent, Error>) async throws -> [ProviderEvent] {
    var out: [ProviderEvent] = []
    for try await e in stream { out.append(e) }
    return out
}

/// Events received before the stream threw, plus the error.
func collectUntilError(_ stream: AsyncThrowingStream<ProviderEvent, Error>) async -> ([ProviderEvent], Error?) {
    var out: [ProviderEvent] = []
    do {
        for try await e in stream { out.append(e) }
        return (out, nil)
    } catch {
        return (out, error)
    }
}

func completed(_ events: [ProviderEvent]) -> ProviderResponse? {
    for e in events { if case .completed(let r) = e { return r } }
    return nil
}

/// Compact, comparable rendering of an event.
func describe(_ e: ProviderEvent) -> String {
    switch e {
    case .textDelta(let i, let t): return "text[\(i)] \(t)"
    case .reasoningDelta(let i, let t): return "reasoning[\(i)] \(t)"
    case .toolCallStarted(let i, let id, let name): return "tool[\(i)] \(id) \(name)"
    case .toolCallDelta(let i, let json): return "args[\(i)] \(json)"
    case .serverToolStarted(let i, let id, let name, let input): return "server[\(i)] \(id) \(name) \(input?.encodedString() ?? "nil")"
    case .serverToolFinished(let i, let id, let summary, let isError): return "serverDone[\(i)] \(id) \(summary) \(isError)"
    case .blockFinished(let i): return "end[\(i)]"
    case .usage: return "usage"
    case .completed: return "completed"
    }
}

func texts(_ events: [ProviderEvent], index: Int? = nil) -> String {
    events.compactMap { if case .textDelta(let i, let t) = $0, index == nil || i == index { return t }; return nil }.joined()
}

func reasoning(_ events: [ProviderEvent]) -> String {
    events.compactMap { if case .reasoningDelta(_, let t) = $0 { return t }; return nil }.joined()
}

func arguments(_ events: [ProviderEvent], index: Int) -> String {
    events.compactMap { if case .toolCallDelta(let i, let j) = $0, i == index { return j }; return nil }.joined()
}

/// Streams one fixture through a provider and returns the final response.
func streamFixture(_ name: String, flavor: ProviderFlavor, chunkSize: Int = 7,
                   endpoint: ProviderEndpoint? = nil) async throws -> (events: [ProviderEvent], response: ProviderResponse?) {
    let transport = ScriptedTransport(replies: [try Fixture.sse(name, chunkSize: chunkSize)])
    let e = endpoint ?? (flavor == .anthropicMessages ? anthropicEndpoint() : openAIEndpoint())
    let provider = ProviderFactory.make(e, transport: transport)
    let events = try await collect(provider.stream(request([.user("hi")])))
    return (events, completed(events))
}

/// Request body sent through `ScriptedTransport` (what actually hit the wire).
func sentBody(_ transport: ScriptedTransport, _ n: Int = 0) -> JSONValue? {
    transport.requests.indices.contains(n) ? transport.requests[n].json : nil
}

func bodyJSON(_ provider: AnthropicProvider, _ r: ProviderRequest) throws -> JSONValue {
    try JSONValue(parsing: provider.requestBody(r))
}

func bodyJSON(_ provider: OpenAIChatProvider, _ r: ProviderRequest) throws -> JSONValue {
    try JSONValue(parsing: provider.requestBody(r))
}

extension JSONValue {
    /// Counts occurrences of a key anywhere in the tree.
    func count(key: String) -> Int {
        switch self {
        case .object(let o): return (o[key] == nil ? 0 : 1) + o.values.reduce(0) { $0 + $1.count(key: key) }
        case .array(let a): return a.reduce(0) { $0 + $1.count(key: key) }
        default: return 0
        }
    }
}
