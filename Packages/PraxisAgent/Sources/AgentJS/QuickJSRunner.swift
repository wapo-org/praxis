import Foundation
import AgentCore
import CQuickJS

/// Runs model-written JavaScript in QuickJS-NG with hard limits.
///
/// Every run gets a fresh runtime and context (~0.5 ms), so nothing leaks
/// between runs except the per-conversation `kv` store kept here (and saved
/// to `Configuration.kvStorage` after each run that changed it). The actor
/// runs on its own thread (`EngineExecutor`); JS values never leave it.
/// Concurrent runs interleave on that thread while they await I/O.
///
/// Limits are enforced from inside the engine: an interrupt handler checks
/// the wall deadline, CPU budget and task cancellation every few thousand
/// bytecodes (so `while (true) {}` stops promptly), and a custom allocator
/// enforces the memory cap.
public actor QuickJSRunner {
    public struct Configuration: Sendable {
        /// Used by `fetch`. Defaults to an ephemeral URLSession (no cookies,
        /// cache or credentials shared with the rest of the app).
        public var transport: any HTTPTransport
        /// Nil = `min(128 MB, 25% of os_proc_available_memory())`.
        public var memoryLimit: Int?
        /// Engine stack budget. ~500 frames of a simple recursive function
        /// per 512 KB.
        public var maxStackSize: Int
        public var maxFetches: Int
        public var maxResponseBytes: Int
        public var requestTimeout: Duration
        public var maxToolCalls: Int
        public var maxConcurrentToolCalls: Int
        /// Allow `fetch` to localhost / RFC 1918 / link-local literals.
        public var allowPrivateNetwork: Bool
        public var maxConsoleLines: Int
        public var maxConsoleBytes: Int
        /// Cap on one console line and on strings nested in the result.
        public var maxStringBytes: Int
        public var maxResultBytes: Int
        public var maxKVBytes: Int
        /// Where each conversation's `kv` store is saved (`kv.json` in its
        /// scratch directory). Nil keeps stores in memory only.
        public var kvStorage: ScratchStore?

        public init(transport: any HTTPTransport = QuickJSRunner.defaultTransport, memoryLimit: Int? = nil,
                    maxStackSize: Int = 512 << 10, maxFetches: Int = 20, maxResponseBytes: Int = 10 << 20,
                    requestTimeout: Duration = .seconds(15), maxToolCalls: Int = 25, maxConcurrentToolCalls: Int = 4,
                    allowPrivateNetwork: Bool = false, maxConsoleLines: Int = 200, maxConsoleBytes: Int = 16 << 10,
                    maxStringBytes: Int = 4 << 10, maxResultBytes: Int = 32 << 10, maxKVBytes: Int = 1 << 20,
                    kvStorage: ScratchStore? = nil) {
            self.transport = transport
            self.memoryLimit = memoryLimit
            self.maxStackSize = maxStackSize
            self.maxFetches = maxFetches
            self.maxResponseBytes = maxResponseBytes
            self.requestTimeout = requestTimeout
            self.maxToolCalls = maxToolCalls
            self.maxConcurrentToolCalls = maxConcurrentToolCalls
            self.allowPrivateNetwork = allowPrivateNetwork
            self.maxConsoleLines = maxConsoleLines
            self.maxConsoleBytes = maxConsoleBytes
            self.maxStringBytes = maxStringBytes
            self.maxResultBytes = maxResultBytes
            self.maxKVBytes = maxKVBytes
            self.kvStorage = kvStorage
        }
    }

    /// Ephemeral session for script traffic: nothing persisted, nothing
    /// shared with provider or MCP connections.
    public static let defaultTransport: any HTTPTransport = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 30
        c.timeoutIntervalForResource = 60
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.urlCredentialStorage = nil
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        // Redirects get the same public-host check as the original URL.
        return URLSessionTransport(session: URLSession(configuration: c), allowRedirect: FetchRequest.allowsRedirect)
    }()

    public nonisolated let configuration: Configuration
    private nonisolated let executor: EngineExecutor
    public nonisolated var unownedExecutor: UnownedSerialExecutor { executor.asUnownedSerialExecutor() }

    private var stores: [String: KVStore] = [:]
    private var preludeBytecode: [UInt8]?

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
        // Room for the engine's own stack budget plus host and Swift frames.
        self.executor = EngineExecutor(name: "PraxisAgent.QuickJS", stackSize: max(4 << 20, configuration.maxStackSize * 4))
    }

    static let kvFileName = "kv.json"

    /// Drops a conversation's `kv` store, saved copy included (e.g. when
    /// the conversation is deleted).
    public func removeStore(conversationID: String) {
        stores[conversationID] = nil
        configuration.kvStorage?.remove(conversationID: conversationID, name: Self.kvFileName)
    }

    private func store(for conversationID: String) -> KVStore {
        if let store = stores[conversationID] { return store }
        let saved = configuration.kvStorage?.read(conversationID: conversationID, name: Self.kvFileName)
        let store = saved.map(KVStore.init(decoding:)) ?? KVStore()
        stores[conversationID] = store
        return store
    }

    /// Saves a changed store; an emptied one removes its file. A failed
    /// write keeps the store dirty, so the next run tries again.
    private func save(_ store: KVStore, conversationID: String) {
        guard store.isDirty, let storage = configuration.kvStorage else { return }
        if store.values.isEmpty {
            storage.remove(conversationID: conversationID, name: Self.kvFileName)
            store.isDirty = false
        } else if (try? storage.write(store.encoded(), conversationID: conversationID, name: Self.kvFileName)) != nil {
            store.isDirty = false
        }
    }

    /// Runs `code` as the body of an async function. Never throws: every
    /// failure (including cancellation) is reported in `JSRunResult.error`.
    ///
    /// - Parameters:
    ///   - context: mode (fetch rules), live console/trace emission, files
    ///     for `fs`, `callTool` for `tools.*`, conversation for `kv`.
    ///   - hostTools: tools exposed as `tools.<name>(args)`.
    public func run(_ code: String, options: JSRunOptions = JSRunOptions(), context: ToolContext,
                    hostTools: [ToolSpec] = []) async -> JSRunResult {
        let start = cqjs_now_ns()
        let timeoutNs = Self.nanoseconds(options.timeout)
        let cpuNs = Self.nanoseconds(options.effectiveCPUBudget)
        guard let limitsGuard = RunGuard(memoryLimit: configuration.memoryLimit ?? Self.defaultMemoryLimit(),
                                         deadlineNs: start &+ timeoutNs, cpuBudgetNs: cpuNs) else {
            return JSRunResult(error: JSRunError(kind: .internal, name: "InternalError", message: "Couldn't allocate the run."))
        }
        let (events, continuation) = AsyncStream.makeStream(of: HostEvent.self)
        return await withTaskCancellationHandler {
            await execute(code, start: start, deadline: start &+ timeoutNs, context: context, hostTools: hostTools,
                          limitsGuard: limitsGuard, events: events, continuation: continuation)
        } onCancel: {
            limitsGuard.cancel()
            continuation.yield(.wake)
        }
    }

    private func execute(_ code: String, start: UInt64, deadline: UInt64, context: ToolContext, hostTools: [ToolSpec],
                         limitsGuard: RunGuard, events: AsyncStream<HostEvent>, continuation: AsyncStream<HostEvent>.Continuation) async -> JSRunResult {
        let store = store(for: context.conversationID)
        defer { save(store, conversationID: context.conversationID) }
        let c = configuration
        let limits = JSSession.Limits(
            maxFetches: c.maxFetches, maxResponseBytes: c.maxResponseBytes, requestTimeout: c.requestTimeout,
            maxToolCalls: c.maxToolCalls, maxConcurrentToolCalls: max(1, c.maxConcurrentToolCalls),
            allowPrivateNetwork: c.allowPrivateNetwork, maxConsoleLines: c.maxConsoleLines, maxConsoleBytes: c.maxConsoleBytes,
            maxStringBytes: c.maxStringBytes, maxKVBytes: c.maxKVBytes, maxKVKeys: 10_000, maxTimers: 10_000)
        guard let session = JSSession(guard: limitsGuard, maxStackSize: c.maxStackSize, limits: limits, context: context,
                                      transport: c.transport, kv: store, toolNames: Set(hostTools.map(\.name)),
                                      events: continuation) else {
            continuation.finish()
            return JSRunResult(error: JSRunError(kind: .internal, name: "InternalError", message: "Couldn't start the JavaScript engine."))
        }
        defer { session.close() }

        var result = JSRunResult()
        result.error = await drive(session, code: code, deadline: deadline, events: events, result: &result)
        if result.error == nil || result.error?.kind == .thrown { session.reportUnhandledRejections() }
        if session.droppedConsoleLines > 0 {
            context.emit(.output(["… \(session.droppedConsoleLines) more console lines not shown"]))
        }
        result.console = session.console
        result.droppedConsoleLines = session.droppedConsoleLines
        result.stringsTruncated = result.stringsTruncated || session.stringsTruncated
        result.duration = .nanoseconds(Int64(cqjs_now_ns() - start))
        result.cpuTime = .nanoseconds(Int64(cqjs_guard_cpu_ns(limitsGuard.raw)))
        result.peakMemoryBytes = cqjs_guard_peak_memory(limitsGuard.raw)
        result.fetchCount = session.fetchCount
        result.toolCallCount = session.toolCallCount
        return result
    }

    /// The event loop: drain microtasks, check the main promise, fire due
    /// timers, otherwise wait for an I/O completion, a timer or the deadline.
    private func drive(_ session: JSSession, code: String, deadline: UInt64, events: AsyncStream<HostEvent>,
                       result: inout JSRunResult) async -> JSRunError? {
        if Task.isCancelled { return JSRunError(kind: .cancelled, name: "AbortError", message: "The run was cancelled.") }
        if let failure = session.loadPrelude(bytecode: &preludeBytecode) {
            if session.isTripped { return session.tripError() }
            return JSRunError(kind: .internal, name: "InternalError", message: "The JavaScript prelude failed: \(failure)")
        }
        if case .failed(let error) = session.start(code: code) { return error }

        var iterator = events.makeAsyncIterator()
        var wake: Task<Void, Never>?
        defer { wake?.cancel() }
        while true {
            session.drainJobs()
            if session.isTripped { return session.tripError() }
            switch session.mainState {
            case .fulfilled:
                switch session.resultJSON() {
                case .failure(let error):
                    return error
                case .success((let json, let cut)):
                    result.stringsTruncated = cut
                    if let json, json.utf8.count > configuration.maxResultBytes {
                        result.resultJSON = Self.truncatedResult(json, cap: configuration.maxResultBytes)
                        result.resultTruncated = true
                    } else {
                        result.resultJSON = json
                    }
                    return nil
                }
            case .rejected:
                return session.rejectionError()
            case .pending:
                break
            }
            if session.fireDueTimers(now: cqjs_now_ns()) { continue }
            if cqjs_guard_poll(session.limitsGuard.raw) != CQJS_TRIP_NONE { return session.tripError() }
            guard session.hasPendingWork else {
                return JSRunError(kind: .unsettled, name: "Error",
                                  message: "The code never finished: it awaits a promise that nothing can settle (no timers or requests are pending).")
            }

            // Sleep until the next timer or the deadline, unless I/O finishes first.
            let now = cqjs_now_ns()
            let target = min(session.nextTimerDeadline ?? .max, deadline)
            wake?.cancel()
            let continuation = session.events
            wake = Task {
                do {
                    try await Task.sleep(for: .nanoseconds(Int64(min(target &- min(target, now), UInt64(Int64.max)))))
                    continuation.yield(.wake)
                } catch {}
            }
            guard let event = await iterator.next(isolation: self) else {
                // The stream ends only when this task is cancelled.
                return JSRunError(kind: .cancelled, name: "AbortError", message: "The run was cancelled.")
            }
            if case .completed(let id, let value) = event { session.complete(id: id, value) }
        }
    }

    /// A JSON string holding the head of `json` plus a marker, at most `cap`
    /// bytes once encoded. Re-encoding escapes quotes, so the head shrinks
    /// until the encoded form fits.
    static func truncatedResult(_ json: String, cap: Int) -> String {
        let marker = "…[truncated: the result was \(FetchRequest.size(json.utf8.count)) of JSON]"
        var budget = max(0, cap - marker.utf8.count - 2)
        while true {
            let encoded = JSONValue.string(JSSession.prefix(json, bytes: budget) + marker).encodedString()
            let excess = encoded.utf8.count - cap
            if excess <= 0 || budget == 0 { return encoded }
            budget = max(0, budget - excess)
        }
    }

    static func nanoseconds(_ d: Duration) -> UInt64 {
        let c = d.components
        guard c.seconds >= 0 else { return 0 }
        return UInt64(c.seconds) &* 1_000_000_000 &+ UInt64(max(0, c.attoseconds / 1_000_000_000))
    }

    /// Upper bound of the default limit. The tool description quotes this,
    /// not the live figure, so the frozen spec doesn't change between runs.
    static let memoryCap = 128 << 20

    /// `min(128 MB, 25% of what the process may still allocate)`, never below
    /// 16 MB. `os_proc_available_memory()` exists only on iOS; elsewhere
    /// (macOS, some simulators) it reports 0 and the 128 MB cap applies.
    static func defaultMemoryLimit() -> Int {
        let cap = memoryCap
        let available = Int(cqjs_available_memory())
        guard available > 0 else { return cap }
        return max(16 << 20, min(cap, available / 4))
    }
}
