import Foundation
import AgentCore

/// `run_javascript`: the model's sandboxed code tool.
///
/// Sandboxed + open-world: the policy runs it without approval in every
/// mode that allows execution (refused in Ask). In Plan mode `fetch` is
/// limited to GET/HEAD. Host tools passed at init become `tools.*` (code
/// mode); their calls go back through the loop's policy via
/// `ToolContext.callTool`.
///
/// The description — including the generated `tools.*` signatures — is
/// built once at init: the tool list is frozen per conversation.
public struct RunJavaScriptTool: AgentTool {
    public static let name = "run_javascript"
    public static let defaultTimeoutMs = 5_000
    public static let maxTimeoutMs = 30_000

    public let runner: QuickJSRunner
    public let hostTools: [ToolSpec]
    public let spec: ToolSpec

    public init(runner: QuickJSRunner = QuickJSRunner(), hostTools: [ToolSpec] = []) {
        self.runner = runner
        self.hostTools = hostTools.sorted { $0.name < $1.name }
        self.spec = ToolSpec(
            name: Self.name,
            description: Self.description(hostTools: self.hostTools, configuration: runner.configuration),
            inputSchema: [
                "type": "object",
                "properties": [
                    "code": [
                        "type": "string",
                        "description": "Body of an async function. Use await freely; `return` a JSON-serializable value.",
                    ],
                    "timeout_ms": [
                        "type": "integer",
                        "description": .string("Wall-clock limit in milliseconds (default \(Self.defaultTimeoutMs), max \(Self.maxTimeoutMs))."),
                    ],
                ],
                "required": ["code"],
            ])
    }

    public var traits: ToolTraits { [.sandboxed, .openWorld] }
    public var source: ToolSource { .javascript }

    public func presentation(for arguments: JSONValue) -> ToolPresentation {
        ToolPresentation(category: .command, runningTitle: "Running code…", finishedTitle: "Ran code")
    }

    public func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        guard let code = invocation.arguments["code"]?.stringValue else {
            return .error("Missing required argument `code` (a string of JavaScript).")
        }
        let requested = invocation.arguments["timeout_ms"]?.doubleValue ?? Double(Self.defaultTimeoutMs)
        let timeoutMs = Int(max(1, min(requested.isFinite ? requested : Double(Self.defaultTimeoutMs), Double(Self.maxTimeoutMs))))
        let result = await runner.run(code, options: JSRunOptions(timeout: .milliseconds(timeoutMs)),
                                      context: context, hostTools: hostTools)
        if result.error?.kind == .cancelled, Task.isCancelled { throw CancellationError() }
        return ToolOutput(content: [.text(Self.outputJSON(result))], isError: result.error != nil,
                          summary: Self.summary(result, timeoutMs: timeoutMs))
    }

    /// `{console, result, error, truncated, ms}` as compact JSON. The result
    /// is spliced in verbatim so the script's key order survives.
    static func outputJSON(_ r: JSRunResult) -> String {
        let console = JSONValue.array(r.console.map { ["level": .string($0.level.rawValue), "text": .string($0.text)] })
        var parts = ["\"console\":" + console.encodedString()]
        if let result = r.resultJSON { parts.append("\"result\":" + result) }
        if let e = r.error {
            var error: [String: JSONValue] = ["name": .string(e.name), "message": .string(e.message)]
            if let line = e.line { error["line"] = .number(Double(line)) }
            if let column = e.column { error["column"] = .number(Double(column)) }
            if let stack = e.stack { error["stack"] = .string(stack) }
            parts.append("\"error\":" + JSONValue.object(error).encodedString())
        }
        if r.droppedConsoleLines > 0 { parts.append("\"console_dropped\":\(r.droppedConsoleLines)") }
        parts.append("\"truncated\":\(r.truncated)")
        parts.append("\"ms\":\(r.duration.components.seconds * 1000 + r.duration.components.attoseconds / 1_000_000_000_000_000)")
        return "{" + parts.joined(separator: ",") + "}"
    }

    static func summary(_ r: JSRunResult, timeoutMs: Int) -> String? {
        guard let e = r.error else { return nil }
        switch e.kind {
        case .timeout: return "Code timed out after \(timeoutMs) ms"
        case .cpuBudget: return "Code ran out of CPU time"
        case .outOfMemory: return "Code ran out of memory"
        case .stackOverflow: return "Code overflowed the stack"
        case .cancelled: return "Cancelled"
        case .syntax: return "Syntax error" + (e.line.map { " on line \($0)" } ?? "")
        case .thrown, .unsettled, .internal:
            let text = e.message.isEmpty ? e.name : "\(e.name): \(e.message)"
            return "Code failed: " + (text.count > 100 ? String(text.prefix(99)) + "…" : text)
        }
    }

    // MARK: Description

    static func description(hostTools: [ToolSpec], configuration c: QuickJSRunner.Configuration) -> String {
        let mb = { (bytes: Int) in "\(bytes >> 20) MB" }
        var text = """
        Run JavaScript (QuickJS, ES2023+) in a sandbox. Returns JSON {console, result, error, truncated, ms}.
        `code` is the body of an async function: top-level await works and `return value` becomes `result` (must be JSON-serializable; Map/Set/typed arrays are converted). Each run starts from a fresh global scope — use `kv` to keep state between runs.
        Globals:
        - console.log/info/warn/error/debug (captured, \(c.maxConsoleLines) lines / \(c.maxConsoleBytes >> 10) KB max)
        - fetch(url, {method, headers, body, signal}) → Response {status, ok, statusText, url, headers.get()/entries(), text(), json(), arrayBuffer()}. http/https to public hosts only; ≤\(c.maxFetches) requests per run; ≤\(mb(c.maxResponseBytes)) per response; body: string, Uint8Array/ArrayBuffer, URLSearchParams or a plain object (sent as JSON). In Plan mode only GET and HEAD are allowed.
        - fs.list() → names of the files attached to the current message; fs.readText(name, {maxBytes}), fs.readBytes(name) → Uint8Array read them (≤10 MB each). A file attached earlier in the conversation can be read by its exact name. Names are plain file names: no folders or absolute paths. Read-only.
        - kv.get(key), kv.set(key, value), kv.delete(key), kv.keys(): JSON store that persists across runs in this conversation.
        - setTimeout/setInterval/clearTimeout/clearInterval, queueMicrotask, TextEncoder/TextDecoder (UTF-8), atob/btoa, structuredClone, URL/URLSearchParams, AbortController, crypto.getRandomValues/randomUUID, performance.now().
        No DOM, Node or Deno APIs (no require/import, process, Buffer, Blob). Pending timers and requests are dropped once the function returns.
        Limits: timeout_ms default \(defaultTimeoutMs), max \(maxTimeoutMs); memory ≤\(mb(c.memoryLimit ?? QuickJSRunner.memoryCap)); strings nested in the result are cut at \(c.maxStringBytes >> 10) KB and the result at \(c.maxResultBytes >> 10) KB.
        """
        guard !hostTools.isEmpty else { return text }
        text += "\nHost tools — `await tools.<name>(args)` resolves to parsed JSON (or text) and rejects on error; ≤\(c.maxToolCalls) calls per run, \(c.maxConcurrentToolCalls) at a time:"
        for spec in hostTools {
            text += "\n- " + signature(spec)
        }
        return text
    }

    /// `tools.github.search_issues({query, repo?})  Search issues.`
    static func signature(_ spec: ToolSpec) -> String {
        let properties = spec.inputSchema["properties"]?.objectValue ?? [:]
        let required = Set((spec.inputSchema["required"]?.arrayValue ?? []).compactMap(\.stringValue))
        let keys = properties.keys.sorted { (required.contains($0) ? 0 : 1, $0) < (required.contains($1) ? 0 : 1, $1) }
        let args = keys.isEmpty ? "" : "{" + keys.map { required.contains($0) ? $0 : $0 + "?" }.joined(separator: ", ") + "}"
        let line = spec.description.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let summary = line.count > 120 ? String(line.prefix(119)) + "…" : line
        return accessor(spec.name) + "(" + args + ")" + (summary.isEmpty ? "" : " — " + summary)
    }

    /// `tools.name`, `tools.server.tool` for `mcp__server__tool`, bracket
    /// syntax for segments that aren't identifiers.
    static func accessor(_ name: String) -> String {
        func member(_ s: Substring) -> String {
            let ok = s.first.map { $0.isLetter || $0 == "_" || $0 == "$" } == true
                && s.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "$" }
            return ok ? "." + s : "[\"" + s + "\"]"
        }
        if name.hasPrefix("mcp__") {
            let rest = name.dropFirst(5)
            if let sep = rest.range(of: "__"), sep.lowerBound > rest.startIndex, sep.upperBound < rest.endIndex {
                return "tools" + member(rest[..<sep.lowerBound]) + member(rest[sep.upperBound...])
            }
        }
        return "tools" + member(Substring(name))
    }
}
