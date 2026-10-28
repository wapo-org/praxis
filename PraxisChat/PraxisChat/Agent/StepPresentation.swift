import Foundation
import AgentCore
import AgentMCP

/// How a tool call reads as one activity line: "Exa · Web search: recent
/// AI breakthroughs". Pure string work on what the runtime already sends
/// (presentation titles, parsed arguments), so the line costs nothing to
/// derive and never needs the tool catalog.
enum StepPresentation {
    struct Titles: Equatable {
        /// Who did it ("Exa", "GitHub"); nil for built-in tools.
        var source: String?
        var running: String
        var finished: String
        /// The call's key argument (a query, URL, path), one line.
        var detail: String?
    }

    /// Detail strings are clipped well past a phone's line width; the row
    /// truncates with an ellipsis.
    static let detailLimit = 140
    /// Formatted arguments and results kept per step (persisted).
    static let argumentsLimit = 3000
    static let resultLimit = 2000
    static let reasoningLimit = 4000

    static func titles(for activity: ToolActivity) -> Titles {
        let p = activity.presentation
        switch activity.name {
        case MCPGateway.describeName:
            // "Read Web Search" — the model reading a connector tool's
            // schema before calling it. Name the tool, not a page.
            let qualified = activity.arguments?["tool"]?.stringValue
            let server = qualified.flatMap(serverSlug(inQualifiedName:)).map(prettySlug)
            var display = p.finishedTitle.hasPrefix("Read ") ? String(p.finishedTitle.dropFirst(5)) : p.finishedTitle
            if display == "tool" {
                // The arguments haven't streamed in yet, or named nothing known.
                guard let qualified else {
                    return Titles(source: nil, running: "Checking a connector tool…", finished: "Checked a connector tool", detail: nil)
                }
                display = humanizedToolName(qualified)
            }
            display = decapitalized(sentenceCase(stripLeadingName(display, name: server)))
            return Titles(source: server, running: "Checking the \(display) tool…",
                          finished: "Checked the \(display) tool", detail: nil)
        case MCPGateway.searchName:
            return Titles(source: nil, running: "Finding connector tools…", finished: "Found connector tools",
                          detail: clip(activity.arguments?["query"]?.stringValue))
        case MCPGateway.callName:
            let split = splitSource(running: p.runningTitle, finished: p.finishedTitle, known: nil)
            let inner = innerArguments(activity.arguments)
            return Titles(source: split.source, running: split.running, finished: split.finished,
                          detail: keyArgument(inner, unlessIn: split.finished))
        default:
            var known: String?
            if case .mcp(_, let name) = activity.source { known = name }
            let split = p.category == .integration || known != nil
                ? splitSource(running: p.runningTitle, finished: p.finishedTitle, known: known)
                : (source: nil, running: plain(p.runningTitle), finished: plain(p.finishedTitle))
            // Code stands for itself in its card; the line shows what the
            // script set out to do (its first comment, else its first line).
            var detail: String?
            if case .javascript = activity.source {
                detail = codeSummary(activity.arguments)
            } else if p.category != .command {
                detail = keyArgument(activity.arguments, unlessIn: split.finished)
            }
            return Titles(source: split.source, running: split.running, finished: split.finished, detail: detail)
        }
    }

    /// Arguments as shown under "Input": pretty JSON of what the tool got
    /// (the target's own arguments for a gateway call). Nil when empty.
    static func formattedArguments(for activity: ToolActivity) -> String? {
        let args = activity.name == MCPGateway.callName ? innerArguments(activity.arguments) : activity.arguments
        guard let args else { return nil }
        if let object = args.objectValue, object.isEmpty { return nil }
        if args.isNull { return nil }
        return clip(args.encodedString(pretty: true), limit: argumentsLimit, singleLine: false)
    }

    /// `mcp_call_tool`'s `arguments`, which some models send as a string.
    static func innerArguments(_ outer: JSONValue?) -> JSONValue? {
        switch outer?["arguments"] {
        case .string(let s)?: return (try? JSONValue(parsing: s)) ?? .string(s)
        case nil, .null?: return nil
        case let value?: return value
        }
    }

    // MARK: Key argument

    /// Keys that name what a call is about, most telling first.
    static let keyArgumentNames = [
        "query", "q", "search_query", "searchQuery", "search", "question", "prompt",
        "url", "uri", "urls", "path", "file_path", "filePath", "filename", "file",
        "name", "title", "objective", "task", "topic", "text", "message",
    ]

    static func keyArgument(_ arguments: JSONValue?, unlessIn title: String = "") -> String? {
        guard let arguments, arguments.objectValue != nil else { return nil }
        for key in keyArgumentNames {
            let value: String?
            switch arguments[key] {
            case .string(let s)?: value = s
            case .array(let items)?: value = items.compactMap(\.stringValue).first
            case .number(let n)?: value = n.rounded() == n ? String(Int(n)) : String(n)
            default: value = nil
            }
            guard let line = clip(value), !line.isEmpty else { continue }
            // Already in the title ("Searched “query”").
            if !title.isEmpty, title.contains(line) { return nil }
            return line
        }
        return nil
    }

    // MARK: Source names

    /// "Exa: Web Search…" → ("Exa", "Web Search…"). With a known server
    /// name only that prefix is split off; otherwise any short "X: " is.
    /// The tool title then drops a repeated server name: "Firecrawl:
    /// Firecrawl web search" → ("Firecrawl", "Web search").
    static func splitSource(running: String, finished: String, known: String?)
        -> (source: String?, running: String, finished: String) {
        func split(_ title: String) -> (String, String)? {
            if let known, title.hasPrefix(known + ": ") {
                return (known, String(title.dropFirst(known.count + 2)))
            }
            guard known == nil, let colon = title.range(of: ": ") else { return nil }
            let head = String(title[..<colon.lowerBound])
            guard !head.isEmpty, head.count <= 32, !head.contains("“") else { return nil }
            return (head, String(title[colon.upperBound...]))
        }
        guard let f = split(finished) else {
            return (known, sentenceCase(plain(running)), sentenceCase(plain(finished)))
        }
        let r = split(running).map(\.1) ?? running
        return (f.0, sentenceCase(plain(stripLeadingName(r, name: f.0))),
                sentenceCase(plain(stripLeadingName(f.1, name: f.0))))
    }

    // MARK: Casing and markup

    /// "Web Search" → "Web search": connector tools name themselves in
    /// Title Case, which reads shouty in a quiet list. Only strict Title
    /// Case text changes, and only plain capitalized words (GitHub, API,
    /// iOS stay as written).
    static func sentenceCase(_ title: String) -> String {
        let words = title.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        guard words.count >= 2 else { return title }
        let letters = { (word: String) in word.filter(\.isLetter).count }
        guard words.allSatisfy({ letters($0) < 4 || $0.first?.isUppercase == true }) else { return title }
        return words.enumerated().map { $0.offset == 0 ? $0.element : decapitalized($0.element) }.joined(separator: " ")
    }

    /// Lowercases a plain capitalized word ("Web" → "web"), leaves the rest.
    static func decapitalized(_ text: String) -> String {
        let firstWord = text.prefix { $0 != " " }
        guard let first = firstWord.first, first.isUppercase,
              firstWord.dropFirst().allSatisfy({ !$0.isUppercase }) else { return text }
        return firstWord.lowercased() + text.dropFirst(firstWord.count)
    }

    /// `mcp__exa__web_search_exa` → `web search exa`.
    static func humanizedToolName(_ name: String) -> String {
        let last = name.components(separatedBy: "__").last ?? name
        return last.replacingOccurrences(of: "_", with: " ")
    }

    /// Markdown links in a title (`[GitHub](praxis-app://GitHub)`) read as
    /// their text: the line is plain.
    static func plain(_ text: String) -> String {
        guard text.contains("](") else { return text }
        return text.replacingOccurrences(of: #"\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
    }

    /// A script's first comment (what the model said it was doing), else
    /// its first line.
    static func codeSummary(_ arguments: JSONValue?) -> String? {
        guard let arguments, let code = ["code", "script", "command", "cmd"].lazy
            .compactMap({ arguments[$0]?.stringValue }).first else { return nil }
        for raw in code.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty else { continue }
            for marker in ["//", "/*", "*/", "*", "#"] where line.hasPrefix(marker) {
                line = String(line.dropFirst(marker.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/*# ").union(.whitespaces))
                break
            }
            if let clipped = clip(line, limit: 100) { return clipped }
        }
        return nil
    }

    /// Drops `name` at the start of `title` ("Firecrawl web search" →
    /// "Web search") when something meaningful remains.
    static func stripLeadingName(_ title: String, name: String?) -> String {
        guard let name, !name.isEmpty,
              title.lowercased().hasPrefix(name.lowercased() + " ") else { return title }
        let rest = title.dropFirst(name.count + 1).trimmingCharacters(in: .whitespaces)
        guard rest.count >= 3 else { return title }
        return rest.prefix(1).uppercased() + rest.dropFirst()
    }

    /// Removes "Exa: " from a completion summary already shown as source.
    static func stripSource(_ text: String, source: String?) -> String {
        guard let source, text.hasPrefix(source + ": ") else { return text }
        return String(text.dropFirst(source.count + 2))
    }

    /// `mcp__exa__web_search_exa` → `exa`.
    static func serverSlug(inQualifiedName name: String) -> String? {
        guard name.hasPrefix("mcp__") else { return nil }
        let rest = name.dropFirst(5)
        guard let end = rest.range(of: "__") else { return nil }
        let slug = String(rest[..<end.lowerBound])
        return slug.isEmpty ? nil : slug
    }

    /// `linear_work` → `Linear work`.
    static func prettySlug(_ slug: String) -> String {
        let words = slug.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    // MARK: Text

    /// One line, whitespace collapsed, clipped with an ellipsis.
    static func clip(_ text: String?, limit: Int = detailLimit, singleLine: Bool = true) -> String? {
        guard var text else { return nil }
        if singleLine {
            text = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        } else {
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        guard !text.isEmpty else { return nil }
        return text.count > limit ? String(text.prefix(limit - 1)) + "…" : text
    }

    /// A trace shaped like a call — `exa.web_search_exa({…})` — repeats
    /// the step's own formatted input.
    static func isCallTrace(_ text: String) -> Bool {
        guard let paren = text.firstIndex(of: "(") else { return false }
        let head = text[..<paren]
        return !head.isEmpty && head.allSatisfy { $0.isLetter || $0.isNumber || "._-".contains($0) }
    }
}

// MARK: - Row text

extension Step {
    /// The line's title: live progress while running, what the call did
    /// once finished, or the outcome when that says more (a declined
    /// merge, "Found 3 tools").
    var lineTitle: String {
        if isRunning {
            return detail != nil || liveOutputLine != nil ? Self.trimmingEllipsis(runningSummary) : runningSummary
        }
        guard let title else { return finalSummary }
        switch status {
        case .denied:
            return finalSummary.isEmpty ? title : finalSummary
        case .succeeded:
            return detail == nil && !finalSummary.isEmpty ? finalSummary : title
        default:
            return title
        }
    }

    /// Shown after the title unless the title is an outcome summary.
    var lineDetail: String? {
        guard let detail else { return nil }
        if isRunning || lineTitle == title { return detail }
        return nil
    }

    /// What the line reads after its source: title, then what about (or a
    /// running command's newest output line). Always one line — whitespace
    /// and newlines collapsed — so no row ever grows past one text line;
    /// the view truncates the rest with an ellipsis.
    var lineBody: String {
        var text = StepPresentation.plain(lineTitle)
        if let trailing = lineDetail ?? liveOutputLine { text += ": \(trailing)" }
        return StepPresentation.clip(text, limit: .max) ?? ""
    }

    /// Live output of a running command: its newest line.
    var liveOutputLine: String? {
        guard isRunning, let line = command?.lines.last else { return nil }
        return StepPresentation.clip(line, limit: 120)
    }

    /// Short trailing state for lines that ended badly.
    var statusTag: String? {
        if signIn != nil { return "Sign-in needed" }
        switch status {
        case .failed: return "Failed"
        case .denied: return lineTitle == title ? "Declined" : nil
        case .cancelled: return "Stopped"
        default: return nil
        }
    }

    /// The completion summary when the line doesn't already say it.
    var outcomeNote: String? {
        guard !isRunning, title != nil, !finalSummary.isEmpty, finalSummary != lineTitle,
              finalSummary != title, finalSummary != "Cancelled" else { return nil }
        return finalSummary
    }

    /// Traces worth showing: a call-shaped trace repeats the step's own
    /// formatted input — except under code, where each one is a call the
    /// script made.
    var visibleTraces: [Trace] {
        command != nil ? traces : traces.filter { $0.kind != .api || !StepPresentation.isCallTrace($0.text) }
    }

    /// What the line's details open to, mostly in the order they read.
    var hasDetails: Bool {
        command != nil || !(arguments ?? "").isEmpty || !(result ?? "").isEmpty
            || !visibleTraces.isEmpty || outcomeNote != nil
    }

    /// The line's details are showing. A command's card keeps its own flag
    /// (older files and the command toggle); everything else uses
    /// `detailsOpen`.
    var isOpen: Bool { command?.isExpanded ?? detailsOpen ?? false }

    /// One plain sentence for VoiceOver.
    var accessibilityLine: String {
        var parts = [[source, lineTitle].compactMap { $0 }.joined(separator: ", ")]
        if let lineDetail { parts.append(lineDetail) }
        if let liveOutputLine { parts.append(liveOutputLine) }
        if isRunning { parts.append("in progress") }
        if let statusTag { parts.append(statusTag.lowercased()) }
        return parts.joined(separator: ", ")
    }

    static func trimmingEllipsis(_ text: String) -> String {
        var t = text
        if t.hasSuffix("...") { t.removeLast(3) }
        while t.hasSuffix("…") { t.removeLast() }
        return t.isEmpty ? text : t
    }
}

extension ActivityData {
    /// The call the folded header shows while the run works: the newest
    /// one still running, else the newest. Nil once the run is over.
    var liveStep: Step? {
        guard isRunning else { return nil }
        return steps.last(where: \.isRunning) ?? steps.last
    }
}
