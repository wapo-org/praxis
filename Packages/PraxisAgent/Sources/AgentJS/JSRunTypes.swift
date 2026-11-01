import Foundation

/// Per-run knobs. Engine-wide limits live in `QuickJSRunner.Configuration`.
public struct JSRunOptions: Sendable, Hashable {
    /// Wall-clock limit for the whole run, including awaited I/O and timers.
    public var timeout: Duration
    /// Time spent actually executing JavaScript. Nil = `min(timeout, 10 s)`.
    public var cpuBudget: Duration?

    public init(timeout: Duration = .seconds(5), cpuBudget: Duration? = nil) {
        self.timeout = timeout
        self.cpuBudget = cpuBudget
    }

    var effectiveCPUBudget: Duration { cpuBudget ?? min(timeout, .seconds(10)) }
}

public struct JSConsoleLine: Sendable, Hashable, Codable {
    public enum Level: String, Sendable, Hashable, Codable, CaseIterable {
        case log, info, warn, error, debug
    }
    public var level: Level
    public var text: String
    public init(level: Level, text: String) {
        self.level = level
        self.text = text
    }
}

/// Why a run failed. Line/column are 1-based in the caller's code (the
/// async-function wrapper is subtracted).
public struct JSRunError: Error, Sendable, Hashable {
    public enum Kind: String, Sendable, Hashable, Codable {
        /// The code didn't parse.
        case syntax
        /// The code threw (or its promise rejected) and nothing caught it.
        case thrown
        /// Wall-clock `timeout` elapsed.
        case timeout
        /// CPU budget exhausted (a busy loop).
        case cpuBudget
        case outOfMemory
        case stackOverflow
        /// The calling task was cancelled.
        case cancelled
        /// The function never returned: it awaits a promise nothing can settle.
        case unsettled
        /// The engine itself failed (couldn't create a runtime, etc.).
        case `internal`
    }

    public var kind: Kind
    public var name: String
    public var message: String
    public var line: Int?
    public var column: Int?
    public var stack: String?

    public init(kind: Kind, name: String, message: String, line: Int? = nil, column: Int? = nil, stack: String? = nil) {
        self.kind = kind
        self.name = name
        self.message = message
        self.line = line
        self.column = column
        self.stack = stack
    }
}

public struct JSRunResult: Sendable, Hashable {
    /// Captured console output, capped (see `QuickJSRunner.Configuration`).
    public var console: [JSConsoleLine]
    /// Console lines dropped after the cap.
    public var droppedConsoleLines: Int
    /// JSON text of the returned value; nil when the code returned
    /// `undefined` or failed. Capped: see `resultTruncated`.
    public var resultJSON: String?
    /// The result exceeded its cap; `resultJSON` is then a JSON string
    /// holding the head of the full JSON text plus a marker.
    public var resultTruncated: Bool
    public var error: JSRunError?
    public var duration: Duration
    public var cpuTime: Duration
    public var peakMemoryBytes: Int
    public var fetchCount: Int
    public var toolCallCount: Int

    /// Anything was cut: console, result or a nested string.
    public var truncated: Bool { droppedConsoleLines > 0 || resultTruncated || stringsTruncated }
    var stringsTruncated: Bool

    init(console: [JSConsoleLine] = [], droppedConsoleLines: Int = 0, resultJSON: String? = nil, resultTruncated: Bool = false,
         stringsTruncated: Bool = false, error: JSRunError? = nil, duration: Duration = .zero, cpuTime: Duration = .zero,
         peakMemoryBytes: Int = 0, fetchCount: Int = 0, toolCallCount: Int = 0) {
        self.console = console
        self.droppedConsoleLines = droppedConsoleLines
        self.resultJSON = resultJSON
        self.resultTruncated = resultTruncated
        self.stringsTruncated = stringsTruncated
        self.error = error
        self.duration = duration
        self.cpuTime = cpuTime
        self.peakMemoryBytes = peakMemoryBytes
        self.fetchCount = fetchCount
        self.toolCallCount = toolCallCount
    }
}
