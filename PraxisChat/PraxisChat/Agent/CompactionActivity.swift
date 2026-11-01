import Foundation
import AgentCore

/// A context compaction in the thread: `TurnReducer` turns
/// `AgentEvent.compaction` into a `CompactionMarker` block (a thin
/// divider row, `CompactionMarkerRow`). The transcript itself is
/// untouched; the record the next requests use is persisted by the store
/// (`ChatRunRequest.onCompaction`), and the marker keeps its own copy of
/// the summary to show.
enum CompactionActivity {
    /// The loop's `failed` reason when the run was stopped mid-summary.
    static let cancelledReason = "Cancelled"

    /// Folds one update into the turn's marker for `key`. Returns false
    /// when there was nothing to change.
    static func apply(_ update: CompactionUpdate, key: String, to turn: inout Turn, at now: Date) -> Bool {
        switch update {
        case .started:
            turn.blocks.append(.compaction(CompactionMarker(key: key, state: .running, date: now)))
            return true
        case .finished(let record):
            return updateMarker(key, in: &turn) { marker in
                marker.state = .done
                marker.summary = record.summary
                marker.tokensBefore = record.tokensBefore
                marker.tokensAfter = record.tokensAfter
            }
        case .failed(let reason) where reason == cancelledReason:
            let count = turn.blocks.count
            turn.blocks.removeAll { if case .compaction(let m) = $0 { return m.key == key }; return false }
            return turn.blocks.count != count
        case .failed(let reason):
            return updateMarker(key, in: &turn) { $0.state = .failed(reason) }
        }
    }

    /// A stopped run leaves no half-done marker behind.
    static func dropRunningMarkers(in turn: inout Turn) {
        turn.blocks.removeAll { if case .compaction(let m) = $0 { return m.state == .running }; return false }
    }

    private static func updateMarker(_ key: String, in turn: inout Turn, _ body: (inout CompactionMarker) -> Void) -> Bool {
        guard let index = turn.blocks.lastIndex(where: { if case .compaction(let m) = $0 { return m.key == key }; return false }),
              case .compaction(var marker) = turn.blocks[index] else { return false }
        body(&marker)
        turn.blocks[index] = .compaction(marker)
        return true
    }

    // MARK: Copy

    static func title(_ marker: CompactionMarker) -> String {
        switch marker.state {
        case .running: return "Summarizing earlier messages…"
        case .done: return "Earlier messages summarized"
        case .failed: return "Couldn't summarize earlier messages"
        }
    }

    /// "~120K → ~9K tokens"; nil when the sizes aren't known.
    static func sizes(before: Int, after: Int) -> String? {
        guard before > 0, after > 0 else { return nil }
        func k(_ n: Int) -> String { n >= 1_000 ? "\(n / 1_000)K" : "\(n)" }
        return "~\(k(before)) → ~\(k(after)) tokens"
    }

    static func accessibilityLabel(_ marker: CompactionMarker) -> String {
        switch marker.state {
        case .running: return "Summarizing earlier messages to save context"
        case .done:
            let size = sizes(before: marker.tokensBefore, after: marker.tokensAfter).map { ", \($0)" } ?? ""
            return "Earlier messages summarized\(size)"
        case .failed(let reason): return "Couldn't summarize earlier messages. \(reason)"
        }
    }
}
