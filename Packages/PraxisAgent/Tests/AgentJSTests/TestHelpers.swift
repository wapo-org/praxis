import Foundation
import Synchronization
import AgentCore
@testable import AgentJS

/// Collects everything a run emits through `ToolContext.emit`.
final class EmitLog: Sendable {
    private let items = Mutex<[ToolProgress]>([])
    var all: [ToolProgress] { items.withLock { $0 } }
    var outputLines: [String] { all.flatMap { if case .output(let l) = $0 { return l }; return [] } }
    var traces: [String] { all.compactMap { if case .trace(.network, let t) = $0 { return t }; return nil } }
    func record(_ p: ToolProgress) { items.withLock { $0.append(p) } }
}

func makeContext(_ conversation: String = "c1", mode: AgentMode = .auto, log: EmitLog? = nil,
                 files: (any VirtualFileSystem)? = nil,
                 callTool: (@Sendable (String, JSONValue) async throws -> ToolOutput)? = nil) -> ToolContext {
    ToolContext(conversationID: conversation, mode: mode, emit: { log?.record($0) }, files: files, callTool: callTool)
}

/// In-memory attachments.
struct StubFiles: VirtualFileSystem {
    var files: [String: Data]
    func list() async -> [String] { files.keys.sorted() }
    func read(_ path: String, maxBytes: Int) async throws -> Data {
        guard let data = files[path] else { throw CocoaError(.fileNoSuchFile) }
        return data.prefix(maxBytes)
    }
}

extension JSRunResult {
    /// The result parsed back into a JSON tree.
    var value: JSONValue? { resultJSON.flatMap { try? JSONValue(parsing: $0) } }
}

/// Elapsed wall time of `body`.
func measure<T>(_ body: () async throws -> T) async rethrows -> (T, Duration) {
    let clock = ContinuousClock()
    let start = clock.now
    let value = try await body()
    return (value, clock.now - start)
}
