import Foundation

/// A frontmatter value. Skills only need scalars (`name`, `description`,
/// `license`, `compatibility`) and the flat `metadata` map; anything else
/// (lists, deeper nesting, flow collections) is kept as raw YAML text.
public enum FrontmatterValue: Sendable, Hashable {
    case string(String)
    case mapping([String: String])
    case unparsed(String)

    public var stringValue: String? { if case .string(let s) = self { return s }; return nil }
}

/// A parsed `SKILL.md`: YAML frontmatter between `---` fences, then the
/// markdown body.
///
/// The parser handles the YAML subset skills are written in — `key: value`,
/// single/double-quoted strings (with escapes, across lines), `|`/`>` block
/// scalars with chomping indicators, multi-line plain scalars, comments and
/// one-level nested maps — rather than pulling in a YAML library. It is
/// lenient where that can't change meaning (a `: ` inside a plain value,
/// CRLF line endings, a BOM, leading blank lines) and strict where a
/// silent misread would (unterminated quotes, duplicate keys, stray text).
public struct SkillDocument: Sendable, Hashable {
    public var frontmatter: [String: FrontmatterValue]
    /// Markdown after the closing fence, without leading blank lines or
    /// trailing whitespace.
    public var body: String

    public init(frontmatter: [String: FrontmatterValue], body: String) {
        self.frontmatter = frontmatter
        self.body = body
    }

    /// Throws `SkillError.invalidSkill` with a line-numbered message.
    public init(parsing text: String) throws {
        var normalized = text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        if normalized.hasPrefix("\u{FEFF}") { normalized.removeFirst() }
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false)

        var start = 0
        while start < lines.count, lines[start].allSatisfy(\.isWhitespace) { start += 1 }
        guard start < lines.count, Self.isFence(lines[start]) else {
            throw SkillError.invalidSkill(["SKILL.md must start with YAML frontmatter: a line with ---, then name and description, then another ---."])
        }
        guard let end = lines[(start + 1)...].firstIndex(where: { Self.isFence($0) || $0.trimmingTrailingWhitespace() == "..." }) else {
            throw SkillError.invalidSkill(["The frontmatter in SKILL.md is never closed: add a line with --- after the last field."])
        }

        var parser = FrontmatterParser(lines: Array(lines[(start + 1)..<end]), firstLineNumber: start + 2)
        frontmatter = try parser.parse()

        var bodyLines = Array(lines[(end + 1)...])
        while let first = bodyLines.first, first.allSatisfy(\.isWhitespace) { bodyLines.removeFirst() }
        var joined = bodyLines.joined(separator: "\n")
        while let last = joined.last, last.isWhitespace { joined.removeLast() }
        body = joined
    }

    private static func isFence(_ line: Substring) -> Bool { line.trimmingTrailingWhitespace() == "---" }

    // MARK: Fields

    public var name: String? { frontmatter["name"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var description: String? { frontmatter["description"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var license: String? { nonEmpty(frontmatter["license"]?.stringValue) }
    public var compatibility: String? { nonEmpty(frontmatter["compatibility"]?.stringValue) }
    public var metadata: [String: String] {
        if case .mapping(let m) = frontmatter["metadata"] { return m }
        return [:]
    }

    private func nonEmpty(_ s: String?) -> String? {
        guard let t = s?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    // MARK: Validation

    /// Checks the Agent Skills format rules. Errors make the skill unusable;
    /// warnings are shown to the user but don't block it. Pass the folder
    /// name to get the "must match the folder" check.
    public func validate(folderName: String? = nil) -> SkillValidation {
        var errors: [String] = []
        var warnings: [String] = []

        switch frontmatter["name"] {
        case nil:
            errors.append("The frontmatter is missing the required name field.")
        case .string?:
            let name = self.name ?? ""
            errors += Self.nameProblems(name)
            if let folderName, !name.isEmpty, folderName != name {
                warnings.append("The folder “\(folderName)” doesn't match the skill name “\(name)”.")
            }
        case .some:
            errors.append("name must be a single line of text.")
        }

        switch frontmatter["description"] {
        case nil:
            errors.append("The frontmatter is missing the required description field.")
        case .string?:
            let description = self.description ?? ""
            if description.isEmpty {
                errors.append("description is empty. Say what the skill does and when to use it.")
            } else if description.count > 1024 {
                errors.append("description is \(description.count) characters; the limit is 1024.")
            }
            if let tag = Self.firstXMLTag(in: description) {
                errors.append("description can't contain XML tags (found \(tag)).")
            }
        case .some:
            errors.append("description must be text.")
        }

        if body.isEmpty {
            errors.append("SKILL.md has no instructions after the frontmatter.")
        } else {
            let lineCount = body.reduce(1) { $1 == "\n" ? $0 + 1 : $0 }
            if lineCount > 500 {
                warnings.append("SKILL.md is \(lineCount) lines; under 500 is recommended — move detail into separate files.")
            }
        }

        if let compatibility, compatibility.count > 500 {
            warnings.append("compatibility is \(compatibility.count) characters; the limit is 500.")
        }
        if let metadata = frontmatter["metadata"], case .mapping = metadata {} else if frontmatter["metadata"] != nil {
            warnings.append("metadata should be a map of text values; it was ignored.")
        }
        return SkillValidation(errors: errors, warnings: warnings)
    }

    static func nameProblems(_ name: String) -> [String] {
        if name.isEmpty { return ["name is empty."] }
        var problems: [String] = []
        if name.count > 64 { problems.append("name is \(name.count) characters; the limit is 64.") }
        let invalid = name.unicodeScalars.filter { !(("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-") }
        if !invalid.isEmpty {
            let shown = String(String.UnicodeScalarView(invalid.prefix(5)))
            problems.append("name may only contain lowercase letters, numbers and hyphens (found “\(shown)”).")
        }
        if name.hasPrefix("-") || name.hasSuffix("-") { problems.append("name can't start or end with a hyphen.") }
        if name.contains("--") { problems.append("name can't contain consecutive hyphens.") }
        return problems
    }

    /// `<tag>`, `</tag>`, `<tag attr>` or `<!…>` — text that could open or
    /// close a section of the system prompt the description is pasted into.
    static func firstXMLTag(in text: String) -> String? {
        guard let range = text.range(of: #"<[/!?]?[A-Za-z][^<>]*>"#, options: .regularExpression) else { return nil }
        return String(text[range])
    }
}

extension SkillDocument {
    /// A `SKILL.md` for the given fields. The description is written as a
    /// double-quoted YAML scalar on one line, so any text round-trips
    /// through the parser exactly (newlines fold to spaces, as they would
    /// in the one-line catalog anyway).
    public static func compose(name: String, description: String, body: String) -> String {
        let oneLine = description.split(whereSeparator: \.isNewline).joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
        var escaped = ""
        for scalar in oneLine.unicodeScalars {
            switch scalar {
            case "\\": escaped += "\\\\"
            case "\"": escaped += "\\\""
            case "\t": escaped += "\\t"
            default:
                if scalar.value < 0x20 || scalar.value == 0x7F {
                    escaped += String(format: "\\x%02X", scalar.value)
                } else {
                    escaped.unicodeScalars.append(scalar)
                }
            }
        }
        var text = body.replacingOccurrences(of: "\r\n", with: "\n")
        while text.hasPrefix("\n") { text.removeFirst() }
        while let last = text.last, last.isWhitespace { text.removeLast() }
        return "---\nname: \(name)\ndescription: \"\(escaped)\"\n---\n\n\(text)\n"
    }
}

public struct SkillValidation: Sendable, Hashable {
    public var errors: [String]
    public var warnings: [String]
    public var isValid: Bool { errors.isEmpty }
}

extension SkillDocument {
    /// Parses and validates in one step; throws every error at once.
    static func load(_ text: String, folderName: String?) throws -> (SkillDocument, [String]) {
        let document = try SkillDocument(parsing: text)
        let validation = document.validate(folderName: folderName)
        guard validation.isValid else { throw SkillError.invalidSkill(validation.errors) }
        return (document, validation.warnings)
    }
}

// MARK: - Parser

private struct FrontmatterParser {
    let lines: [Substring]
    let firstLineNumber: Int
    var i = 0

    init(lines: [Substring], firstLineNumber: Int) {
        self.lines = lines
        self.firstLineNumber = firstLineNumber
    }

    private func fail(_ message: String, line index: Int? = nil) -> SkillError {
        .invalidSkill(["SKILL.md frontmatter, line \(firstLineNumber + (index ?? i)): \(message)"])
    }

    mutating func parse() throws -> [String: FrontmatterValue] {
        var result: [String: FrontmatterValue] = [:]
        while i < lines.count {
            let line = lines[i]
            if Self.isBlankOrComment(line) { i += 1; continue }
            if Self.indent(of: line) > 0 { throw fail("unexpected indentation.") }
            if line.hasPrefix("- ") || line == "-" { throw fail("expected key: value, found a list item.") }
            guard let (key, rest) = Self.splitKey(line) else { throw fail("expected key: value.") }
            if result[key] != nil { throw fail("\(key) appears more than once.") }
            let keyLine = i
            i += 1
            result[key] = try value(after: rest, keyLine: keyLine)
        }
        return result
    }

    private mutating func value(after rest: Substring, keyLine: Int) throws -> FrontmatterValue {
        let rest = rest.trimmingLeadingWhitespace()
        if rest.isEmpty || rest.hasPrefix("#") { return try nestedValue() }
        if let header = BlockHeader(rest) { return .string(blockScalar(header)) }
        if rest.hasPrefix("\"") || rest.hasPrefix("'") {
            return .string(try quoted(first: rest, startLine: keyLine))
        }
        if rest.hasPrefix("[") || rest.hasPrefix("{") {
            let more = takeIndented().map { String($0) }
            return .unparsed(([String(rest)] + more).joined(separator: "\n"))
        }
        return .string(Self.fold([Self.stripComment(rest)] + takeIndented().map { Self.stripComment($0.trimmingLeadingWhitespace()) }))
    }

    /// The value starts on the following, indented lines: a map, a list,
    /// or a scalar that wrapped onto the next line.
    private mutating func nestedValue() throws -> FrontmatterValue {
        let block = takeIndented()
        let content = block.filter { !Self.isBlankOrComment($0) }
        guard let first = content.first else { return .string("") }
        let firstTrimmed = first.trimmingLeadingWhitespace()
        if firstTrimmed.hasPrefix("- ") || firstTrimmed == "-" || firstTrimmed.hasPrefix("[") || firstTrimmed.hasPrefix("{") {
            return .unparsed(block.joined(separator: "\n"))
        }
        if firstTrimmed.hasPrefix("\"") || firstTrimmed.hasPrefix("'") {
            var inner = FrontmatterParser(lines: block.map { $0.trimmingLeadingWhitespace() }, firstLineNumber: firstLineNumber + i - block.count)
            let firstIndex = inner.lines.firstIndex { !$0.isEmpty } ?? 0
            inner.i = firstIndex + 1
            return .string(try inner.quoted(first: inner.lines[firstIndex], startLine: firstIndex))
        }
        guard Self.splitKey(firstTrimmed) != nil else {
            return .string(Self.fold(block.map { Self.stripComment($0.trimmingLeadingWhitespace()) }))
        }
        // One-level map of scalars; anything deeper is kept raw.
        let base = Self.indent(of: first)
        var map: [String: String] = [:]
        for line in content {
            guard Self.indent(of: line) == base, let (key, raw) = Self.splitKey(line.dropFirst(base)) else {
                return .unparsed(block.joined(separator: "\n"))
            }
            let value = raw.trimmingLeadingWhitespace()
            if value.isEmpty || value.hasPrefix("|") || value.hasPrefix(">") || value.hasPrefix("[") || value.hasPrefix("{") {
                return .unparsed(block.joined(separator: "\n"))
            }
            if value.hasPrefix("\"") || value.hasPrefix("'") {
                var single = FrontmatterParser(lines: [value], firstLineNumber: 0)
                single.i = 1
                guard let parsed = try? single.quoted(first: value, startLine: 0) else { return .unparsed(block.joined(separator: "\n")) }
                map[key] = parsed
            } else {
                map[key] = String(Self.stripComment(value))
            }
        }
        return .mapping(map)
    }

    /// Consumes following lines that are blank or indented (the value's
    /// continuation). Trailing blank lines are left for the caller.
    private mutating func takeIndented() -> [Substring] {
        var taken: [Substring] = []
        var j = i
        while j < lines.count {
            let line = lines[j]
            if line.allSatisfy(\.isWhitespace) { j += 1; continue }
            guard Self.indent(of: line) > 0 else { break }
            taken.append(contentsOf: lines[i...j])
            j += 1
            i = j
        }
        return taken
    }

    // MARK: Block scalars

    private struct BlockHeader {
        var folded: Bool
        var chomp: Character? // "-" strip, "+" keep, nil clip
        var indent: Int?

        init?(_ s: Substring) {
            guard let c = s.first, c == "|" || c == ">" else { return nil }
            folded = c == ">"
            var rest = s.dropFirst()
            chomp = nil
            indent = nil
            while let ch = rest.first, ch == "-" || ch == "+" || ch.isNumber {
                if ch.isNumber { indent = ch.wholeNumberValue } else { chomp = ch }
                rest = rest.dropFirst()
            }
            let tail = rest.trimmingLeadingWhitespace()
            guard tail.isEmpty || tail.hasPrefix("#") else { return nil }
        }
    }

    private mutating func blockScalar(_ header: BlockHeader) -> String {
        var raw: [Substring] = []
        while i < lines.count {
            let line = lines[i]
            if !line.allSatisfy(\.isWhitespace), Self.indent(of: line) == 0 { break }
            raw.append(line)
            i += 1
        }
        let indent = header.indent ?? raw.first(where: { !$0.allSatisfy(\.isWhitespace) }).map(Self.indent(of:)) ?? 0
        let content = raw.map { line -> Substring in
            if line.allSatisfy(\.isWhitespace) { return line.count > indent ? line.dropFirst(indent) : "" }
            return Self.indent(of: line) >= indent ? line.dropFirst(indent) : line.trimmingLeadingWhitespace()
        }
        let lastText = content.lastIndex { !$0.allSatisfy(\.isWhitespace) }
        guard let lastText else { return header.chomp == "+" ? String(repeating: "\n", count: content.count) : "" }
        let text = Array(content[...lastText])
        let trailingBreaks = content.count - lastText - 1

        var out: String
        if header.folded {
            out = ""
            var pendingBlank = 0
            var previousMoreIndented = false
            var first = true
            for line in text {
                if line.allSatisfy(\.isWhitespace) && !(line.first == " " || line.first == "\t") || line.isEmpty {
                    pendingBlank += 1
                    continue
                }
                let moreIndented = line.first == " " || line.first == "\t"
                if first {
                    out += String(repeating: "\n", count: pendingBlank)
                } else if pendingBlank == 0 {
                    out += moreIndented || previousMoreIndented ? "\n" : " "
                } else {
                    out += String(repeating: "\n", count: moreIndented || previousMoreIndented ? pendingBlank + 1 : pendingBlank)
                }
                out += line
                pendingBlank = 0
                first = false
                previousMoreIndented = moreIndented
            }
        } else {
            out = text.joined(separator: "\n")
        }
        switch header.chomp {
        case "-": return out
        case "+": return out + String(repeating: "\n", count: trailingBreaks + 1)
        default: return out + "\n"
        }
    }

    // MARK: Quoted scalars

    /// Parses a quoted scalar starting at `first`, consuming more lines when
    /// the closing quote isn't on this one. Line breaks fold like YAML: one
    /// break becomes a space, each blank line a newline.
    mutating func quoted(first: Substring, startLine: Int) throws -> String {
        let quote = first.first!
        var out = ""
        var line = first.dropFirst()
        var pendingBreaks = 0
        var atLineStart = false

        func flushBreaks() {
            if pendingBreaks > 0 {
                while out.last == " " || out.last == "\t" { out.removeLast() }
                out += pendingBreaks == 1 ? " " : String(repeating: "\n", count: pendingBreaks - 1)
                pendingBreaks = 0
            }
        }

        while true {
            var idx = line.startIndex
            if atLineStart {
                while idx < line.endIndex, line[idx] == " " || line[idx] == "\t" { idx = line.index(after: idx) }
                if idx == line.endIndex {
                    pendingBreaks += 1
                    guard i < lines.count else { throw fail("this quoted value is never closed.", line: startLine) }
                    line = lines[i]
                    i += 1
                    continue
                }
                flushBreaks()
            }
            var escapedBreak = false
            while idx < line.endIndex {
                let c = line[idx]
                if c == quote {
                    let next = line.index(after: idx)
                    if quote == "'", next < line.endIndex, line[next] == "'" {
                        out.append("'")
                        idx = line.index(after: next)
                        continue
                    }
                    let tail = line[next...].trimmingLeadingWhitespace()
                    guard tail.isEmpty || tail.hasPrefix("#") else {
                        throw fail("unexpected text after the closing quote.", line: i - 1)
                    }
                    return out
                }
                if quote == "\"", c == "\\" {
                    let next = line.index(after: idx)
                    guard next < line.endIndex else { escapedBreak = true; break }
                    let (decoded, after) = try Self.unescape(line, at: next, fail: fail("invalid escape sequence.", line: i - 1))
                    out += decoded
                    idx = after
                    continue
                }
                out.append(c)
                idx = line.index(after: idx)
            }
            guard i < lines.count else { throw fail("this quoted value is never closed.", line: startLine) }
            if !escapedBreak { pendingBreaks = 1 } else { pendingBreaks = 0 }
            line = lines[i]
            i += 1
            atLineStart = true
            if escapedBreak {
                // `\` at end of line joins without a space; leading blanks of the next line are dropped.
                var start = line.startIndex
                while start < line.endIndex, line[start] == " " || line[start] == "\t" { start = line.index(after: start) }
                line = line[start...]
                atLineStart = false
            }
        }
    }

    private static func unescape(_ line: Substring, at idx: Substring.Index, fail: @autoclosure () -> SkillError) throws -> (String, Substring.Index) {
        let c = line[idx]
        let after = line.index(after: idx)
        let simple: [Character: String] = [
            "0": "\0", "a": "\u{07}", "b": "\u{08}", "t": "\t", "\t": "\t", "n": "\n", "v": "\u{0B}", "f": "\u{0C}",
            "r": "\r", "e": "\u{1B}", " ": " ", "\"": "\"", "/": "/", "\\": "\\", "N": "\u{85}", "_": "\u{A0}",
            "L": "\u{2028}", "P": "\u{2029}",
        ]
        if let s = simple[c] { return (s, after) }
        let width: Int
        switch c {
        case "x": width = 2
        case "u": width = 4
        case "U": width = 8
        default: throw fail()
        }
        guard let end = line.index(after, offsetBy: width, limitedBy: line.endIndex),
              let value = UInt32(line[after..<end], radix: 16), let scalar = Unicode.Scalar(value) else { throw fail() }
        return (String(Character(scalar)), end)
    }

    // MARK: Helpers

    static func indent(of line: Substring) -> Int {
        line.prefix { $0 == " " || $0 == "\t" }.count
    }

    static func isBlankOrComment(_ line: Substring) -> Bool {
        let t = line.trimmingLeadingWhitespace()
        return t.isEmpty || t.hasPrefix("#")
    }

    /// `key: rest` where the colon is followed by a space or the line end.
    static func splitKey(_ line: Substring) -> (String, Substring)? {
        var idx = line.startIndex
        while idx < line.endIndex {
            if line[idx] == ":" {
                let next = line.index(after: idx)
                if next == line.endIndex || line[next] == " " || line[next] == "\t" {
                    let key = line[..<idx].trimmingTrailingWhitespace()
                    guard !key.isEmpty, key.allSatisfy({ $0.isLetter || $0.isNumber || "_-.".contains($0) }) else { return nil }
                    return (String(key), line[next...])
                }
            }
            idx = line.index(after: idx)
        }
        return nil
    }

    /// Drops a trailing ` # comment` from a plain scalar.
    static func stripComment(_ s: Substring) -> Substring {
        var previous: Character = " "
        var idx = s.startIndex
        while idx < s.endIndex {
            if s[idx] == "#", previous == " " || previous == "\t", idx != s.startIndex {
                return s[..<idx].trimmingTrailingWhitespace()
            }
            previous = s[idx]
            idx = s.index(after: idx)
        }
        return s.trimmingTrailingWhitespace()
    }

    /// Plain multi-line scalars: lines join with a space, blank lines become newlines.
    static func fold(_ parts: [Substring]) -> String {
        var out = ""
        var blanks = 0
        for part in parts {
            if part.isEmpty { blanks += 1; continue }
            if !out.isEmpty { out += blanks == 0 ? " " : String(repeating: "\n", count: blanks) }
            out += part
            blanks = 0
        }
        return out
    }
}

extension Substring {
    func trimmingLeadingWhitespace() -> Substring { drop { $0 == " " || $0 == "\t" } }
    func trimmingTrailingWhitespace() -> Substring {
        var s = self
        while let last = s.last, last == " " || last == "\t" { s = s.dropLast() }
        return s
    }
}
