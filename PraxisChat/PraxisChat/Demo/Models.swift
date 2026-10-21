import Foundation
import SwiftUI

// MARK: Settings

enum ChatMode: String, CaseIterable, Identifiable {
    case auto, ask, plan, build
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var placeholder: String {
        switch self {
        case .auto: return "Plan, ask, build..."
        case .ask: return "Ask anything..."
        case .plan: return "Plan it out..."
        case .build: return "Build something..."
        }
    }
}

enum Effort: String, CaseIterable, Identifiable {
    case low, medium, high, max
    var id: String { rawValue }
    var title: String { rawValue.capitalized }
    var detail: String {
        switch self {
        case .low: return "Quick answers, minimal tool use"
        case .medium: return "Balanced: a few tools, checked once"
        case .high: return "Thorough: plans first, verifies after"
        case .max: return "Exhaustive: plans, verifies, retries"
        }
    }
    /// Target wall-clock for a run (spec §10: ~3s Low → ~15s Max).
    var runSeconds: Double {
        switch self {
        case .low: return 3; case .medium: return 6; case .high: return 10; case .max: return 15
        }
    }
    var stepScale: Double {
        switch self {
        case .low: return 0.45; case .medium: return 0.7; case .high: return 1.0; case .max: return 1.35
        }
    }
}

struct AIModel: Identifiable, Equatable {
    let id: String
    let name: String
    let tagline: String
    let speed: Int        // 1...5 dots
    let intelligence: Int // 1...5 dots
    /// Streaming speed multiplier (spec §10: model scales streaming speed).
    let streamMultiplier: Double
}

struct Connector: Identifiable, Equatable {
    let id: String
    let name: String
    let monogram: String
    var isOn: Bool
}

// MARK: Attachments

struct Attachment: Identifiable, Equatable, Hashable {
    let id: UUID
    var kind: Kind
    var name: String
    var imageData: Data?
    enum Kind: Equatable, Hashable { case photo, file, screenshot, camera }
    init(kind: Kind, name: String, imageData: Data? = nil) {
        id = UUID(); self.kind = kind; self.name = name; self.imageData = imageData
    }
}

// MARK: Transcript

enum StepKind: String, Equatable {
    case integration, command, edits, webSearch, webFetch, readFile, think
    var lucide: String {
        switch self {
        case .integration: return "link-2"
        case .command: return "terminal"
        case .edits: return "pencil"
        case .webSearch: return "search"
        case .webFetch: return "globe"
        case .readFile: return "file-text"
        case .think: return "lightbulb"
        }
    }
}

enum TraceKind: Equatable { case skill, api, image }

struct Trace: Identifiable, Equatable {
    let id = UUID()
    var kind: TraceKind
    var text: String
    var thumbnailData: Data?
}

struct CommandData: Identifiable, Equatable {
    let id = UUID()
    var code: String
    var lines: [String] = []
    var exitCode: Int?
    var duration: TimeInterval = 0
    var isRunning: Bool = false
    var isExpanded: Bool = false
}

struct Step: Identifiable, Equatable {
    let id = UUID()
    var kind: StepKind
    var runningSummary: String
    var finalSummary: String
    var traces: [Trace] = []
    var command: CommandData?
    var isRunning: Bool = false
}

struct ActivityData: Identifiable, Equatable {
    let id = UUID()
    var steps: [Step] = []
    var isRunning: Bool = false
    var isStopped: Bool = false
    var elapsed: TimeInterval = 0
    /// nil = untouched (auto-collapse wins); non-nil = user's choice wins (§10).
    var userExpanded: Bool?
    var isExpanded: Bool = false
    var label: String {
        if isStopped { return "Stopped after \(DurationFormatter.format(elapsed))" }
        if isRunning { return "Currently working…" }
        return "Worked for \(DurationFormatter.format(elapsed))"
    }
}

enum Block: Identifiable, Equatable {
    case activity(ActivityData)
    case markdown(id: UUID, source: String, isStreaming: Bool)
    var id: UUID {
        switch self {
        case .activity(let a): return a.id
        case .markdown(let id, _, _): return id
        }
    }
}

struct Turn: Identifiable, Equatable {
    let id = UUID()
    var userText: String
    var attachments: [Attachment] = []
    var blocks: [Block] = []
    var isRunning: Bool = false
    var isFinished: Bool = false
    var feedback: Feedback = .none
    enum Feedback: Equatable { case none, up, down }
}

struct Conversation: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var updatedAt: Date = Date()
    var turns: [Turn] = []
    var isPinned: Bool = false
}

enum DurationFormatter {
    static func format(_ t: TimeInterval) -> String {
        let s = Int(t.rounded())
        if s < 60 { return "\(s)s" }
        return "\(s / 60)m \(s % 60)s"
    }
    static func live(_ t: TimeInterval) -> String {
        String(format: "%.1fs", t)
    }
}
