import XCTest
import AgentCore
@testable import PraxisChat

/// Polls the main actor until `condition` holds (runs settle through a
/// detached reader and main-actor drains, so tests wait on state).
@MainActor
func waitUntil(timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line,
               _ condition: () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
        if Date() > deadline {
            XCTFail("timed out waiting for condition", file: file, line: line)
            return
        }
        try? await Task.sleep(for: .milliseconds(5))
    }
}

func tool(_ id: String, _ category: ToolCategory, name: String = "tool", arguments: JSONValue? = nil,
          source: ToolSource = .builtin) -> ToolActivity {
    ToolActivity(id: id, name: name, source: source,
                 presentation: ToolPresentation(category: category, runningTitle: "Running \(id)…",
                                                finishedTitle: "Ran \(id)"),
                 arguments: arguments)
}

extension Turn {
    var activities: [ActivityData] {
        blocks.compactMap { if case .activity(let a) = $0 { return a }; return nil }
    }
    var compactionMarkers: [CompactionMarker] {
        blocks.compactMap { if case .compaction(let m) = $0 { return m }; return nil }
    }

    var markdownSources: [String] {
        blocks.compactMap { if case .markdown(_, let s, _) = $0 { return s }; return nil }
    }
}

func temporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("PraxisChatTests-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

@MainActor
extension ChatStore {
    /// Settles the store at the end of a test: waits (bounded, silent)
    /// for any running turn to finish, then drains queued persistence
    /// writes, so `tearDown` can remove the temp directory without a
    /// late write landing in a deleted folder.
    ///
    /// Prefer this over `flushPersistence()` as the last line of any
    /// store-based test: a bare flush only waits for writes that are
    /// already queued, while a run that just finished may still have
    /// saves on the way.
    func settle(timeout: TimeInterval = 5) async {
        let deadline = Date().addingTimeInterval(timeout)
        while isRunning, Date() <= deadline {
            try? await Task.sleep(for: .milliseconds(5))
        }
        await flushPersistence()
    }
}
