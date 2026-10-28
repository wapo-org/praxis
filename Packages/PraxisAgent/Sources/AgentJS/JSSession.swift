import Foundation
import AgentCore
import CQuickJS
import Security

/// Native functions on the prelude's `__host` object. `magic` in the C
/// trampoline is the raw value.
enum HostFunction: Int32, CaseIterable {
    case log = 1, timerSet, timerClear, randomBytes, utf8Encode, utf8Decode
    case kvGet, kvSet, kvDelete, kvKeys, parseURL
    case fetch, fsList, fsRead, callTool

    var jsName: String {
        switch self {
        case .log: return "log"
        case .timerSet: return "timerSet"
        case .timerClear: return "timerClear"
        case .randomBytes: return "randomBytes"
        case .utf8Encode: return "utf8Encode"
        case .utf8Decode: return "utf8Decode"
        case .kvGet: return "kvGet"
        case .kvSet: return "kvSet"
        case .kvDelete: return "kvDelete"
        case .kvKeys: return "kvKeys"
        case .parseURL: return "parseURL"
        case .fetch: return "fetch"
        case .fsList: return "fsList"
        case .fsRead: return "fsRead"
        case .callTool: return "callTool"
        }
    }
}

/// Error raised into JavaScript by a host function.
struct HostFailure: Error, Sendable {
    enum Kind: Sendable { case error, type, range }
    var kind: Kind
    var name: String?
    var message: String

    init(_ kind: Kind, name: String? = nil, _ message: String) {
        self.kind = kind
        self.name = name
        self.message = message
    }

    init(name: String? = nil, _ message: String) {
        self.init(.error, name: name, message)
    }

    var cKind: CQJSErrorKind {
        switch kind {
        case .error: return CQJS_ERROR
        case .type: return CQJS_TYPE_ERROR
        case .range: return CQJS_RANGE_ERROR
        }
    }
}

/// Outcome of an async host operation, as plain Sendable data. Turned into
/// JS values only back on the engine thread.
enum HostResult: Sendable {
    /// JSON text, parsed into a value.
    case json(String)
    /// Parsed when it's valid JSON, otherwise passed as a string.
    case jsonOrText(String)
    case text(String)
    case bytes(Data)
    /// `meta` (JSON object) with `body` attached as a Uint8Array.
    case response(meta: String, body: Data)
    case failure(HostFailure)
}

enum HostEvent: Sendable {
    case completed(id: Int, HostResult)
    /// A timer or the deadline may be due; re-check.
    case wake
}

/// Owns the C run guard so a cancellation handler on another thread can
/// still reach it after the run has finished.
final class RunGuard: @unchecked Sendable {
    let raw: OpaquePointer
    init?(memoryLimit: Int, deadlineNs: UInt64, cpuBudgetNs: UInt64) {
        guard let g = cqjs_guard_new(memoryLimit, deadlineNs, cpuBudgetNs) else { return nil }
        raw = g
    }
    deinit { cqjs_guard_free(raw) }
    func cancel() { cqjs_guard_cancel(raw) }
}

/// Per-conversation `kv` store. Owned by the runner, touched only on the
/// engine thread. `isDirty` marks changes not yet saved to disk.
final class KVStore {
    var values: [String: String] = [:] { didSet { isDirty = true } }
    var bytes = 0
    var isDirty = false

    init() {}

    /// Restores a saved store (`encoded()`); unreadable data gives an empty one.
    init(decoding data: Data) {
        if let values = try? JSONDecoder().decode([String: String].self, from: data) {
            self.values = values
            bytes = values.reduce(0) { $0 + $1.key.utf8.count + $1.value.utf8.count }
        }
        isDirty = false
    }

    func encoded() -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return (try? encoder.encode(values)) ?? Data("{}".utf8)
    }
}

/// Engine state for one run: runtime, context, pending host operations,
/// timers and captured console. Created, used and destroyed on the engine
/// thread; JS values never leave it.
final class JSSession {
    struct Limits {
        var maxFetches: Int
        var maxResponseBytes: Int
        var requestTimeout: Duration
        var maxToolCalls: Int
        var maxConcurrentToolCalls: Int
        var allowPrivateNetwork: Bool
        var maxConsoleLines: Int
        var maxConsoleBytes: Int
        var maxStringBytes: Int
        var maxKVBytes: Int
        var maxKVKeys: Int
        var maxTimers: Int
    }

    private struct PendingOp {
        var resolve: JSValue
        var reject: JSValue
        var isTool: Bool
    }

    private struct TimerEntry {
        var deadline: UInt64
        var interval: UInt64?
        var seq: Int
    }

    private struct Internals {
        var fireTimer: JSValue
        var serialize: JSValue
        var describeError: JSValue
        var installTools: JSValue
        var logUncaught: JSValue
    }

    let rt: OpaquePointer
    let ctx: OpaquePointer
    let limitsGuard: RunGuard
    let limits: Limits
    let context: ToolContext
    let transport: any HTTPTransport
    let kv: KVStore
    let toolNames: Set<String>
    let events: AsyncStream<HostEvent>.Continuation
    let wrapperLines = 1
    private(set) var userLines = 0

    private var internals: Internals?
    private var pending: [Int: PendingOp] = [:]
    private var tasks: [Int: Task<Void, Never>] = [:]
    private var nextOpID = 1
    private var timers: [Int32: TimerEntry] = [:]
    private var timerSeq = 0
    private var toolQueue: [(id: Int, name: String, arguments: JSONValue)] = []
    private var toolsInFlight = 0
    private var rejections: [(promise: JSValue, reason: JSValue)] = []
    private(set) var mainPromise = cqjs_undefined()

    private(set) var console: [JSConsoleLine] = []
    private var consoleBytes = 0
    private(set) var droppedConsoleLines = 0
    private(set) var stringsTruncated = false
    private(set) var fetchCount = 0
    private(set) var toolCallCount = 0

    init?(guard limitsGuard: RunGuard, maxStackSize: Int, limits: Limits, context: ToolContext, transport: any HTTPTransport,
          kv: KVStore, toolNames: Set<String>, events: AsyncStream<HostEvent>.Continuation) {
        guard let rt = cqjs_new_runtime(limitsGuard.raw, maxStackSize) else { return nil }
        JS_UpdateStackTop(rt)
        guard let ctx = cqjs_new_context(rt) else {
            JS_FreeRuntime(rt)
            return nil
        }
        self.rt = rt
        self.ctx = ctx
        self.limitsGuard = limitsGuard
        self.limits = limits
        self.context = context
        self.transport = transport
        self.kv = kv
        self.toolNames = toolNames
        self.events = events
        JS_SetContextOpaque(ctx, Unmanaged.passUnretained(self).toOpaque())
        JS_SetHostPromiseRejectionTracker(rt, { ctx, promise, reason, isHandled, _ in
            guard let session = JSSession.from(ctx) else { return }
            session.trackRejection(promise: promise, reason: reason, isHandled: isHandled)
        }, nil)
    }

    static func from(_ ctx: OpaquePointer?) -> JSSession? {
        guard let ctx, let raw = JS_GetContextOpaque(ctx) else { return nil }
        return Unmanaged<JSSession>.fromOpaque(raw).takeUnretainedValue()
    }

    /// Frees every JS value and the runtime. Must run on the engine thread.
    func close() {
        for task in tasks.values { task.cancel() }
        tasks.removeAll()
        events.finish()
        for op in pending.values {
            cqjs_free(ctx, op.resolve)
            cqjs_free(ctx, op.reject)
        }
        pending.removeAll()
        for r in rejections {
            cqjs_free(ctx, r.promise)
            cqjs_free(ctx, r.reason)
        }
        rejections.removeAll()
        if let i = internals {
            for v in [i.fireTimer, i.serialize, i.describeError, i.installTools, i.logUncaught] { cqjs_free(ctx, v) }
            internals = nil
        }
        cqjs_free(ctx, mainPromise)
        mainPromise = cqjs_undefined()
        JS_SetContextOpaque(ctx, nil)
        JS_FreeContext(ctx)
        JS_FreeRuntime(rt)
    }

    var trip: CQJSTrip { cqjs_guard_trip(limitsGuard.raw) }
    var isTripped: Bool { trip != CQJS_TRIP_NONE }

    /// Brackets synchronous JS execution: re-anchors the engine's stack
    /// limit to the current stack depth and counts the time against the
    /// CPU budget.
    private func enter<T>(_ body: () -> T) -> T {
        JS_UpdateStackTop(rt)
        cqjs_guard_enter(limitsGuard.raw)
        defer { cqjs_guard_exit(limitsGuard.raw) }
        return body()
    }

    // MARK: Setup

    /// Installs `__host` and runs the prelude (from cached bytecode when
    /// available). Returns an error description on failure.
    func loadPrelude(bytecode cache: inout [UInt8]?) -> String? {
        let global = JS_GetGlobalObject(ctx)
        defer { cqjs_free(ctx, global) }
        let host = JS_NewObject(ctx)
        for fn in HostFunction.allCases {
            let f = fn.jsName.withCString { name in
                cqjs_new_host_function(ctx, hostTrampoline, name, 0, fn.rawValue)
            }
            JS_SetPropertyStr(ctx, host, fn.jsName, f)
        }
        JS_SetPropertyStr(ctx, global, "__host", host)

        let value: JSValue = enter {
            if let cached = cache {
                let fn = cached.withUnsafeBufferPointer { JS_ReadObject(ctx, $0.baseAddress, $0.count, Int32(JS_READ_OBJ_BYTECODE)) }
                if cqjs_is_exception(fn) { return fn }
                return JS_EvalFunction(ctx, fn)
            }
            let fn = Prelude.source.withCString { src in
                Prelude.filename.withCString { cqjs_eval(ctx, src, strlen(src), $0, 1, true) }
            }
            if cqjs_is_exception(fn) { return fn }
            var size = 0
            if let buf = JS_WriteObject(ctx, &size, fn, Int32(JS_WRITE_OBJ_BYTECODE)) {
                cache = Array(UnsafeBufferPointer(start: buf, count: size))
                js_free(ctx, buf)
            }
            return JS_EvalFunction(ctx, fn)
        }
        if cqjs_is_exception(value) {
            let e = JS_GetException(ctx)
            defer { cqjs_free(ctx, e) }
            return string(e) ?? "prelude failed"
        }
        defer { cqjs_free(ctx, value) }
        func member(_ name: String) -> JSValue { JS_GetPropertyStr(ctx, value, name) }
        internals = Internals(fireTimer: member("fireTimer"), serialize: member("serialize"),
                              describeError: member("describeError"), installTools: member("installTools"),
                              logUncaught: member("logUncaught"))
        let names = JSONValue.array(toolNames.sorted().map { .string($0) }).encodedString()
        let arg = newString(names)
        defer { cqjs_free(ctx, arg) }
        let ok = enter { cqjs_call1(ctx, internals!.installTools, arg) }
        if !ok {
            cqjs_free(ctx, JS_GetException(ctx))
            return "couldn't install tools"
        }
        return nil
    }

    enum StartResult {
        case started
        case failed(JSRunError)
    }

    /// Compiles the user's code as the body of an async function and calls
    /// it. The function runs synchronously up to its first `await`.
    func start(code: String) -> StartResult {
        userLines = code.reduce(into: 1) { n, c in if c == "\n" || c == "\r\n" { n += 1 } }
        let wrapped = "(async () => {\n" + code + "\n})()"
        let compiled: JSValue = enter {
            wrapped.withCString { src in
                Self.codeFilename.withCString { cqjs_eval(ctx, src, strlen(src), $0, 1, true) }
            }
        }
        if cqjs_is_exception(compiled) {
            if isTripped { return .failed(tripError()) }
            let e = JS_GetException(ctx)
            defer { cqjs_free(ctx, e) }
            var error = describe(e, kind: .syntax)
            if error.name != "SyntaxError" { error.kind = .thrown }
            error.stack = nil
            return .failed(error)
        }
        let promise = enter { JS_EvalFunction(ctx, compiled) }
        if cqjs_is_exception(promise) {
            if isTripped { return .failed(tripError()) }
            let e = JS_GetException(ctx)
            defer { cqjs_free(ctx, e) }
            return .failed(classify(describe(e, kind: .thrown)))
        }
        mainPromise = promise
        return .started
    }

    static let codeFilename = "code.js"

    // MARK: Loop support

    /// Runs queued promise jobs until none are left (or a limit trips).
    func drainJobs() {
        enter {
            var jobContext: OpaquePointer?
            while !isTripped {
                let r = JS_ExecutePendingJob(rt, &jobContext)
                if r == 0 { break }
                if r < 0 {
                    let e = JS_GetException(ctx)
                    if !isTripped, let log = internals?.logUncaught { _ = cqjs_call1(ctx, log, e) }
                    cqjs_free(ctx, e)
                }
            }
        }
    }

    enum MainState {
        case pending
        case fulfilled
        case rejected
    }

    var mainState: MainState {
        switch JS_PromiseState(ctx, mainPromise) {
        case JS_PROMISE_FULFILLED: return .fulfilled
        case JS_PROMISE_REJECTED: return .rejected
        default: return .pending
        }
    }

    /// Something can still settle the main promise.
    var hasPendingWork: Bool { !pending.isEmpty || !timers.isEmpty }

    var nextTimerDeadline: UInt64? { timers.values.map(\.deadline).min() }

    /// Fires every timer due by now, in deadline order, draining microtasks
    /// after each (as browsers do). Returns whether any fired.
    func fireDueTimers(now: UInt64) -> Bool {
        let due = timers.filter { $0.value.deadline <= now }
            .sorted { ($0.value.deadline, $0.value.seq) < ($1.value.deadline, $1.value.seq) }
        guard !due.isEmpty, let fire = internals?.fireTimer else { return false }
        for (id, entry) in due {
            if isTripped { break }
            guard var current = timers[id], current.seq == entry.seq else { continue }
            if let interval = current.interval {
                timerSeq += 1
                current.deadline = max(now, current.deadline &+ interval)
                current.seq = timerSeq
                timers[id] = current
            } else {
                timers[id] = nil
            }
            let arg = cqjs_int32(ctx, id)
            let ok = enter { cqjs_call1(ctx, fire, arg) }
            if !ok { cqjs_free(ctx, JS_GetException(ctx)) }
            drainJobs()
        }
        return true
    }

    /// Delivers an async host result: resolves or rejects its promise.
    func complete(id: Int, _ result: HostResult) {
        tasks[id] = nil
        guard let op = pending.removeValue(forKey: id) else { return }
        defer {
            cqjs_free(ctx, op.resolve)
            cqjs_free(ctx, op.reject)
        }
        if op.isTool {
            toolsInFlight -= 1
            pumpTools()
        }
        let (value, isError) = makeValue(result)
        defer { cqjs_free(ctx, value) }
        let ok = enter { cqjs_call1(ctx, isError ? op.reject : op.resolve, value) }
        if !ok { cqjs_free(ctx, JS_GetException(ctx)) }
    }

    private func makeValue(_ result: HostResult) -> (JSValue, Bool) {
        switch result {
        case .json(let text):
            let v = parseJSON(text)
            if cqjs_is_exception(v) {
                cqjs_free(ctx, JS_GetException(ctx))
                return (cqjs_new_error(ctx, CQJS_ERROR, nil, "host returned invalid JSON"), true)
            }
            return (v, false)
        case .jsonOrText(let text):
            let v = parseJSON(text)
            if cqjs_is_exception(v) {
                cqjs_free(ctx, JS_GetException(ctx))
                return (newString(text), false)
            }
            return (v, false)
        case .text(let s):
            return (newString(s), false)
        case .bytes(let data):
            return (newBytes(data), false)
        case .response(let meta, let body):
            let v = parseJSON(meta)
            if cqjs_is_exception(v) {
                cqjs_free(ctx, JS_GetException(ctx))
                return (cqjs_new_error(ctx, CQJS_TYPE_ERROR, nil, "fetch failed: bad response metadata"), true)
            }
            JS_SetPropertyStr(ctx, v, "body", newBytes(body))
            return (v, false)
        case .failure(let f):
            return (newError(f), true)
        }
    }

    // MARK: Results

    /// JSON of the fulfilled value (nil for undefined) and whether nested
    /// strings were cut.
    func resultJSON() -> Result<(String?, Bool), JSRunError> {
        guard let serialize = internals?.serialize else { return .success((nil, false)) }
        let value = JS_PromiseResult(ctx, mainPromise)
        defer { cqjs_free(ctx, value) }
        var arg = value
        let out = enter { JS_Call(ctx, serialize, cqjs_undefined(), 1, &arg) }
        defer { cqjs_free(ctx, out) }
        if cqjs_is_exception(out) {
            if isTripped { return .failure(tripError()) }
            let e = JS_GetException(ctx)
            defer { cqjs_free(ctx, e) }
            var error = describe(e, kind: .thrown)
            error.message = "The return value couldn't be serialized: " + error.message
            return .failure(classify(error))
        }
        guard let text = cqjs_is_undefined(out) ? nil : string(out), let flag = text.first else { return .success((nil, false)) }
        return .success((String(text.dropFirst()), flag == "1"))
    }

    /// Why the main promise rejected.
    func rejectionError() -> JSRunError {
        if isTripped { return tripError() }
        let reason = JS_PromiseResult(ctx, mainPromise)
        defer { cqjs_free(ctx, reason) }
        return classify(describe(reason, kind: .thrown))
    }

    /// Reports rejected promises nobody handled (other than the main one)
    /// as console errors, like an engine's "Uncaught (in promise)".
    func reportUnhandledRejections() {
        guard !isTripped else { return }
        let list = rejections
        rejections.removeAll()
        for r in list {
            defer {
                cqjs_free(ctx, r.promise)
                cqjs_free(ctx, r.reason)
            }
            if JS_IsStrictEqual(ctx, r.promise, mainPromise) { continue }
            let e = describe(r.reason, kind: .thrown)
            let text = e.message.isEmpty ? e.name : "\(e.name): \(e.message)"
            record(level: .error, text: "Uncaught (in promise) " + text)
        }
    }

    func tripError() -> JSRunError {
        let g = limitsGuard.raw
        switch trip {
        case CQJS_TRIP_CANCELLED:
            return JSRunError(kind: .cancelled, name: "AbortError", message: "The run was cancelled.")
        case CQJS_TRIP_TIMEOUT:
            return JSRunError(kind: .timeout, name: "TimeoutError", message: "The code didn't finish within its time limit.")
        case CQJS_TRIP_CPU:
            let ms = cqjs_guard_cpu_ns(g) / 1_000_000
            return JSRunError(kind: .cpuBudget, name: "TimeoutError",
                              message: "The code used its CPU budget (\(ms) ms of JavaScript execution); it is probably stuck in a loop.")
        case CQJS_TRIP_MEMORY:
            return JSRunError(kind: .outOfMemory, name: "RangeError", message: "Out of memory: the code exceeded the memory limit.")
        default:
            return JSRunError(kind: .internal, name: "InternalError", message: "The engine stopped unexpectedly.")
        }
    }

    private func classify(_ error: JSRunError) -> JSRunError {
        if isTripped { return tripError() }
        var e = error
        if e.name == "RangeError", e.message == "Maximum call stack size exceeded" { e.kind = .stackOverflow }
        if e.name == "InternalError", e.message == "out of memory" { e.kind = .outOfMemory }
        return e
    }

    /// Name / message / stack of a thrown value, with code.js positions
    /// mapped back to the caller's lines.
    private func describe(_ value: JSValue, kind: JSRunError.Kind) -> JSRunError {
        var fallback: JSRunError { JSRunError(kind: kind, name: "Error", message: string(value) ?? "Unknown error") }
        guard let describeError = internals?.describeError, !isTripped else { return fallback }
        var arg = value
        let out = enter { JS_Call(ctx, describeError, cqjs_undefined(), 1, &arg) }
        defer { cqjs_free(ctx, out) }
        if cqjs_is_exception(out) {
            cqjs_free(ctx, JS_GetException(ctx))
            return fallback
        }
        guard let text = string(out), let json = try? JSONValue(parsing: text) else { return fallback }
        var error = JSRunError(kind: kind, name: json["name"]?.stringValue ?? "Error", message: json["message"]?.stringValue ?? "")
        if let stack = json["stack"]?.stringValue {
            let mapped = mapStack(stack)
            error.stack = mapped.stack
            error.line = mapped.line
            error.column = mapped.column
        }
        return error
    }

    /// Keeps the frames in the caller's code, renumbered, and the first
    /// such position.
    private func mapStack(_ stack: String) -> (stack: String?, line: Int?, column: Int?) {
        let marker = Self.codeFilename + ":"
        var lines: [String] = []
        var position: (Int, Int)?
        for raw in stack.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let range = raw.range(of: marker) else { continue }
            let tail = raw[range.upperBound...]
            let digits = tail.split(separator: ":", maxSplits: 1)
            guard digits.count == 2, let line = Int(digits[0]) else { continue }
            let column = Int(digits[1].prefix { $0.isNumber }) ?? 0
            let userLine = line - wrapperLines
            guard userLine >= 1 else { continue }
            let clamped = min(userLine, userLines)
            if userLine > userLines { continue } // the wrapper's own call frame
            if position == nil { position = (clamped, column) }
            let rest = digits[1].drop { $0.isNumber }
            lines.append(String(raw[..<range.upperBound]) + "\(clamped):\(column)" + rest)
        }
        // Errors thrown by the parser sit on the wrapper's last line.
        if position == nil, let range = stack.range(of: marker) {
            let digits = stack[range.upperBound...].split(separator: ":", maxSplits: 1)
            if digits.count == 2, let line = Int(digits[0]) {
                position = (max(1, min(line - wrapperLines, userLines)), Int(digits[1].prefix { $0.isNumber }) ?? 0)
            }
        }
        let text = lines.prefix(12).joined(separator: "\n")
        return (text.isEmpty ? nil : text, position?.0, position?.1)
    }

    // MARK: Host functions

    fileprivate func call(_ fn: HostFunction, _ args: HostArgs) -> JSValue {
        do {
            return try perform(fn, args)
        } catch let failure as HostFailure {
            return JS_Throw(ctx, newError(failure))
        } catch {
            return JS_Throw(ctx, newError(HostFailure(error.localizedDescription)))
        }
    }

    private func perform(_ fn: HostFunction, _ args: HostArgs) throws -> JSValue {
        switch fn {
        case .log:
            let level = JSConsoleLine.Level.allCases[max(0, min(4, Int(args.double(0) ?? 0)))]
            record(level: level, text: try args.string(1))
            return cqjs_undefined()

        case .timerSet:
            guard timers.count < limits.maxTimers else { throw HostFailure(.range, "Too many active timers (limit \(limits.maxTimers)).") }
            let id = Int32(clamping: Int(args.double(0) ?? 0))
            let ms = max(0, min(args.double(1) ?? 0, 2_147_483_647))
            let repeating = args.bool(2)
            let delay = UInt64((repeating ? max(ms, 1) : ms) * 1_000_000)
            timerSeq += 1
            timers[id] = TimerEntry(deadline: cqjs_now_ns() &+ delay, interval: repeating ? delay : nil, seq: timerSeq)
            return cqjs_undefined()

        case .timerClear:
            timers[Int32(clamping: Int(args.double(0) ?? 0))] = nil
            return cqjs_undefined()

        case .randomBytes:
            let n = max(0, min(Int(args.double(0) ?? 0), 65_536))
            var bytes = [UInt8](repeating: 0, count: n)
            if n > 0, SecRandomCopyBytes(kSecRandomDefault, n, &bytes) != errSecSuccess {
                throw HostFailure("crypto: the system random number generator failed")
            }
            return bytes.withUnsafeBufferPointer { JS_NewUint8ArrayCopy(ctx, $0.baseAddress, n) }

        case .utf8Encode:
            var len = 0
            guard let p = cqjs_to_cstring(ctx, args[0], &len) else { return cqjs_exception() }
            defer { JS_FreeCString(ctx, p) }
            return p.withMemoryRebound(to: UInt8.self, capacity: max(len, 1)) { JS_NewUint8ArrayCopy(ctx, $0, len) }

        case .utf8Decode:
            guard let raw = args.bytes(0) else { throw HostFailure(.type, "Expected an ArrayBuffer or typed array") }
            var bytes = raw
            if !args.bool(2), bytes.count >= 3, bytes[0] == 0xEF, bytes[1] == 0xBB, bytes[2] == 0xBF {
                bytes = UnsafeRawBufferPointer(rebasing: bytes[3...])
            }
            if args.bool(1) {
                guard let s = String(validating: bytes, as: UTF8.self) else {
                    throw HostFailure(.type, "The encoded data was not valid UTF-8")
                }
                return newString(s)
            }
            return newString(String(decoding: bytes, as: UTF8.self))

        case .kvGet:
            guard let value = kv.values[try args.string(0)] else { return cqjs_undefined() }
            return newString(value)

        case .kvSet:
            let key = try args.string(0), value = try args.string(1)
            guard key.utf8.count <= 512 else { throw HostFailure(.range, "kv: keys are limited to 512 bytes") }
            let old = kv.values[key].map { key.utf8.count + $0.utf8.count } ?? 0
            let new = key.utf8.count + value.utf8.count
            if kv.values[key] == nil, kv.values.count >= limits.maxKVKeys {
                throw HostFailure(.range, "kv: the store is full (\(limits.maxKVKeys) keys per conversation)")
            }
            guard kv.bytes - old + new <= limits.maxKVBytes else {
                throw HostFailure(.range, "kv: the store is full (\(limits.maxKVBytes / 1024) KB per conversation)")
            }
            kv.values[key] = value
            kv.bytes += new - old
            return cqjs_undefined()

        case .kvDelete:
            let key = try args.string(0)
            guard let old = kv.values.removeValue(forKey: key) else { return cqjs_bool(false) }
            kv.bytes -= key.utf8.count + old.utf8.count
            return cqjs_bool(true)

        case .kvKeys:
            return newString(JSONValue.array(kv.values.keys.sorted().map { .string($0) }).encodedString())

        case .parseURL:
            let input = try args.string(0)
            let base = cqjs_is_undefined(args[1]) ? nil : try args.string(1)
            guard let parts = URLParts.parse(input, base: base) else { return cqjs_undefined() }
            return newString(parts.json)

        case .fetch:
            let meta = try args.string(0)
            let body = args.bytes(1).map { Data($0) }
            let request = try FetchRequest(meta: meta, body: body, mode: context.mode,
                                           allowPrivateNetwork: limits.allowPrivateNetwork,
                                           maxBodyBytes: limits.maxResponseBytes)
            guard fetchCount < limits.maxFetches else {
                throw HostFailure(.type, "fetch: request limit reached (\(limits.maxFetches) per run)")
            }
            fetchCount += 1
            let transport = self.transport, emit = context.emit
            let maxBytes = limits.maxResponseBytes, timeout = limits.requestTimeout
            return startAsync(isTool: false) {
                await request.perform(transport: transport, maxBytes: maxBytes, timeout: timeout, emit: emit)
            }

        case .fsList:
            let files = context.files
            return startAsync(isTool: false) {
                let names = await files?.list() ?? []
                return .json(JSONValue.array(names.map { .string($0) }).encodedString())
            }

        case .fsRead:
            let path = try args.string(0)
            let maxBytes = max(1, min(Int(args.double(1) ?? 0), VirtualPath.maxReadBytes))
            let asText = args.bool(2)
            guard let files = context.files else { throw HostFailure("fs: no files are attached to this conversation") }
            do {
                _ = try VirtualPath.validate(path)
            } catch let invalid as VirtualPath.Invalid {
                throw HostFailure(.type, "fs: \(invalid.description)")
            }
            return startAsync(isTool: false) {
                do {
                    let data = try await files.read(path, maxBytes: maxBytes)
                    return asText ? .text(String(decoding: data, as: UTF8.self)) : .bytes(data)
                } catch {
                    return .failure(HostFailure("fs: couldn't read \(path): \(error.localizedDescription)"))
                }
            }

        case .callTool:
            let name = try args.string(0)
            guard toolNames.contains(name) else { throw HostFailure(.type, "tools: unknown tool \(name)") }
            guard context.callTool != nil else { throw HostFailure("tools: host tools aren't available here") }
            guard toolCallCount < limits.maxToolCalls else {
                throw HostFailure(.range, "tools: call limit reached (\(limits.maxToolCalls) per run)")
            }
            let arguments: JSONValue
            do {
                arguments = try JSONValue(parsing: try args.string(1))
            } catch is HostFailure {
                return cqjs_exception()
            } catch {
                throw HostFailure(.type, "tools: arguments must be JSON-serializable")
            }
            guard case .object = arguments else { throw HostFailure(.type, "tools: arguments must be an object") }
            toolCallCount += 1
            let promise = newPromise(isTool: true) { id in toolQueue.append((id, name, arguments)) }
            pumpTools()
            return promise
        }
    }

    /// Starts queued tool calls up to the concurrency limit.
    private func pumpTools() {
        guard let callTool = context.callTool else { return }
        while toolsInFlight < limits.maxConcurrentToolCalls, !toolQueue.isEmpty {
            let job = toolQueue.removeFirst()
            guard pending[job.id] != nil else { continue }
            toolsInFlight += 1
            launch(id: job.id) {
                do {
                    let output = try await callTool(job.name, job.arguments)
                    if output.isError {
                        return .failure(HostFailure(name: "ToolError", output.text.isEmpty ? "\(job.name) failed" : output.text))
                    }
                    return .jsonOrText(output.text)
                } catch is CancellationError {
                    return .failure(HostFailure(name: "AbortError", "\(job.name) was cancelled"))
                } catch {
                    return .failure(HostFailure(name: "ToolError", "\(job.name) failed: \(error.localizedDescription)"))
                }
            }
        }
    }

    /// New promise whose settlement arrives later as a `HostEvent`.
    private func newPromise(isTool: Bool, register: (Int) -> Void) -> JSValue {
        var funcs = [cqjs_undefined(), cqjs_undefined()]
        let promise = funcs.withUnsafeMutableBufferPointer { cqjs_new_promise(ctx, $0.baseAddress) }
        if cqjs_is_exception(promise) { return promise }
        let id = nextOpID
        nextOpID += 1
        pending[id] = PendingOp(resolve: funcs[0], reject: funcs[1], isTool: isTool)
        register(id)
        return promise
    }

    private func startAsync(isTool: Bool, _ work: @escaping @Sendable () async -> HostResult) -> JSValue {
        newPromise(isTool: isTool) { id in launch(id: id, work) }
    }

    private func launch(id: Int, _ work: @escaping @Sendable () async -> HostResult) {
        let events = self.events
        tasks[id] = Task {
            let result = await work()
            events.yield(.completed(id: id, result))
        }
    }

    private func trackRejection(promise: JSValue, reason: JSValue, isHandled: Bool) {
        if isHandled {
            if let i = rejections.firstIndex(where: { JS_IsStrictEqual(ctx, $0.promise, promise) }) {
                let r = rejections.remove(at: i)
                cqjs_free(ctx, r.promise)
                cqjs_free(ctx, r.reason)
            }
        } else if rejections.count < 100 {
            rejections.append((cqjs_dup(ctx, promise), cqjs_dup(ctx, reason)))
        }
    }

    // MARK: Console

    func record(level: JSConsoleLine.Level, text: String) {
        guard droppedConsoleLines == 0, console.count < limits.maxConsoleLines else {
            droppedConsoleLines += 1
            return
        }
        var line = text
        if line.utf8.count > limits.maxStringBytes {
            line = Self.prefix(line, bytes: limits.maxStringBytes) + "…[+\(line.utf8.count - limits.maxStringBytes) bytes]"
            stringsTruncated = true
        }
        guard consoleBytes + line.utf8.count <= limits.maxConsoleBytes else {
            droppedConsoleLines += 1
            return
        }
        consoleBytes += line.utf8.count
        console.append(JSConsoleLine(level: level, text: line))
        context.emit(.output(line.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)))
    }

    /// Longest prefix of `s` that fits in `bytes` UTF-8 bytes without
    /// splitting a character.
    static func prefix(_ s: String, bytes: Int) -> String {
        var count = 0
        var end = s.startIndex
        for i in s.indices {
            let n = s[i].utf8.count
            if count + n > bytes { break }
            count += n
            end = s.index(after: i)
        }
        return String(s[..<end])
    }

    // MARK: Values

    func string(_ v: JSValue) -> String? {
        var len = 0
        guard let p = cqjs_to_cstring(ctx, v, &len) else {
            cqjs_free(ctx, JS_GetException(ctx))
            return nil
        }
        defer { JS_FreeCString(ctx, p) }
        return String(decoding: UnsafeRawBufferPointer(start: p, count: len), as: UTF8.self)
    }

    func newString(_ s: String) -> JSValue {
        var s = s
        return s.withUTF8 { buf in
            // An empty buffer may have no base address; the engine reads nothing then.
            buf.withMemoryRebound(to: CChar.self) { cqjs_string(ctx, $0.baseAddress, $0.count) }
        }
    }

    private func newBytes(_ data: Data) -> JSValue {
        data.withUnsafeBytes { raw in
            // NULL is fine for an empty buffer: the engine only copies `len` bytes.
            JS_NewUint8ArrayCopy(ctx, raw.bindMemory(to: UInt8.self).baseAddress, raw.count)
        }
    }

    private func parseJSON(_ text: String) -> JSValue {
        text.withCString { JS_ParseJSON(ctx, $0, strlen($0), "<host>") }
    }

    private func newError(_ f: HostFailure) -> JSValue {
        f.message.withCString { message in
            if let name = f.name { return name.withCString { cqjs_new_error(ctx, f.cKind, $0, message) } }
            return cqjs_new_error(ctx, f.cKind, nil, message)
        }
    }
}

/// Arguments of a host call (borrowed; never freed here).
struct HostArgs {
    let ctx: OpaquePointer
    let count: Int
    let argv: UnsafeMutablePointer<JSValue>?

    subscript(i: Int) -> JSValue { i < count ? argv![i] : cqjs_undefined() }

    func string(_ i: Int) throws -> String {
        var len = 0
        guard let p = cqjs_to_cstring(ctx, self[i], &len) else { throw HostFailure(.type, "Expected a string") }
        defer { JS_FreeCString(ctx, p) }
        return String(decoding: UnsafeRawBufferPointer(start: p, count: len), as: UTF8.self)
    }

    func double(_ i: Int) -> Double? {
        var d = 0.0
        guard cqjs_is_number(self[i]), cqjs_to_float64(ctx, self[i], &d) else { return nil }
        return d.isFinite ? d : nil
    }

    func bool(_ i: Int) -> Bool { JS_ToBool(ctx, self[i]) == 1 }

    /// Bytes of a typed array / ArrayBuffer argument, valid until JS runs again.
    func bytes(_ i: Int) -> UnsafeRawBufferPointer? {
        var len = 0
        guard let p = cqjs_bytes(ctx, self[i], &len) else { return nil }
        return UnsafeRawBufferPointer(start: p, count: len)
    }
}

/// The one C entry point for every `__host` function; `magic` selects it.
private func hostTrampoline(_ ctx: OpaquePointer?, _ this: JSValue, _ argc: Int32, _ argv: UnsafeMutablePointer<JSValue>?,
                            _ magic: Int32) -> JSValue {
    guard let ctx, let session = JSSession.from(ctx), let fn = HostFunction(rawValue: magic) else {
        return cqjs_undefined()
    }
    return session.call(fn, HostArgs(ctx: ctx, count: Int(argc), argv: argv))
}
