import Foundation
import AgentCore

/// `load_skill {name}`: returns a skill's instructions. The tool's spec is
/// independent of which skills exist — the catalog lives in the system
/// prompt — so the frozen tool list never has to change when skills do.
public struct LoadSkillTool: AgentTool {
    public static let name = "load_skill"

    let store: SkillStore
    let codeToolName: String?

    public init(store: SkillStore, codeToolName: String? = nil) {
        self.store = store
        self.codeToolName = codeToolName
    }

    public var spec: ToolSpec {
        ToolSpec(
            name: Self.name,
            description: "Load a skill's full instructions. Call this before starting a task that matches one of the skills listed in the system prompt, then follow the instructions it returns.",
            inputSchema: [
                "type": "object",
                "properties": [
                    "name": ["type": "string", "description": "Skill name exactly as listed, e.g. \"pdf-processing\""],
                ],
                "required": ["name"],
            ])
    }
    public var traits: ToolTraits { [.readOnly, .idempotent] }
    public var source: ToolSource { .skill }

    public func presentation(for arguments: JSONValue) -> ToolPresentation {
        let name = arguments["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        return ToolPresentation(category: .skill,
                                runningTitle: name.map { "Loading \($0) skill…" } ?? "Loading skill…",
                                finishedTitle: name.map { "Loaded \($0) skill" } ?? "Loaded skill")
    }

    public func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        guard let name = invocation.arguments["name"]?.stringValue?.trimmingCharacters(in: .whitespaces), !name.isEmpty else {
            return .error("Missing name. " + (await availableNames()))
        }
        guard let skill = await store.skill(named: name) else {
            return .error("There's no skill named “\(name)”. " + (await availableNames()))
        }
        let body: String
        do {
            body = try await store.instructions(for: name)
        } catch {
            return .error("Couldn't load \(name): \((error as? SkillError)?.description ?? error.localizedDescription)")
        }
        context.emit(.trace(.skill, "Loaded \(name)"))
        return ToolOutput(content: [.text(Self.render(skill, body: body, codeToolName: codeToolName))],
                          summary: "Loaded \(name) skill")
    }

    private func availableNames() async -> String {
        let names = await store.skills().map(\.name)
        return names.isEmpty ? "No skills are installed." : "Available skills: " + names.joined(separator: ", ") + "."
    }

    static func render(_ skill: Skill, body: String, codeToolName: String?) -> String {
        var out = "<skill name=\"\(skill.name)\">\n\(body)\n</skill>"
        if skill.files.isEmpty {
            out += "\n\nThis skill has no other files."
        } else {
            out += "\n\nFiles in this skill (read with \(ReadSkillFileTool.name), paths relative to the skill folder):"
            for file in skill.files { out += "\n- \(file.path) (\(SkillImporter.formatBytes(file.size)))" }
        }
        let alternative = codeToolName.map { "do the equivalent with \($0), or by hand" } ?? "do those steps by hand or with the tools you have"
        out += "\n\nScripts can't run on this device. Where these instructions say to run a script or command, \(alternative)."
        if !skill.removedFiles.isEmpty {
            let list = skill.removedFiles.prefix(20).map(\.path).joined(separator: ", ")
            let more = skill.removedFiles.count > 20 ? " and \(skill.removedFiles.count - 20) more" : ""
            out += " These files were removed and aren't available: \(list)\(more)."
        }
        return out
    }
}

/// `read_skill_file {skill, path, offset?, limit?}`: pages through a text
/// file inside a skill folder.
public struct ReadSkillFileTool: AgentTool {
    public static let name = "read_skill_file"
    static let defaultLimit = 20_000
    static let maxLimit = 40_000

    let store: SkillStore

    public init(store: SkillStore) {
        self.store = store
    }

    public var spec: ToolSpec {
        ToolSpec(
            name: Self.name,
            description: "Read a text file bundled with a skill (paths as listed by load_skill). Long files are returned in pages: pass offset to continue.",
            inputSchema: [
                "type": "object",
                "properties": [
                    "skill": ["type": "string", "description": "Skill name"],
                    "path": ["type": "string", "description": "File path relative to the skill folder, e.g. \"reference/forms.md\""],
                    "offset": ["type": "integer", "description": "Character offset to start at (default 0)"],
                    "limit": ["type": "integer", "description": .string("Characters to read (default \(Self.defaultLimit), max \(Self.maxLimit))")],
                ],
                "required": ["skill", "path"],
            ])
    }
    public var traits: ToolTraits { [.readOnly, .idempotent] }
    public var source: ToolSource { .skill }

    public func presentation(for arguments: JSONValue) -> ToolPresentation {
        let path = arguments["path"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        return ToolPresentation(category: .skill,
                                runningTitle: path.map { "Reading \($0)…" } ?? "Reading skill file…",
                                finishedTitle: path.map { "Read \($0)" } ?? "Read skill file")
    }

    public func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        let args = invocation.arguments
        guard let name = args["skill"]?.stringValue, !name.isEmpty else { return .error("Missing skill.") }
        guard let requestedPath = args["path"]?.stringValue, !requestedPath.isEmpty else { return .error("Missing path.") }
        let offset = max(0, args["offset"]?.intValue ?? 0)
        let limit = min(max(1, args["limit"]?.intValue ?? Self.defaultLimit), Self.maxLimit)

        guard let skill = await store.skill(named: name) else {
            let names = await store.skills().map(\.name)
            return .error("There's no skill named “\(name)”. " + (names.isEmpty ? "No skills are installed." : "Available skills: \(names.joined(separator: ", "))."))
        }
        let path: String
        let text: String
        do {
            (path, text) = try await store.readFile(skill: name, path: requestedPath)
        } catch {
            let files = (["SKILL.md"] + skill.files.map(\.path)).joined(separator: ", ")
            let message = (error as? SkillError)?.description ?? error.localizedDescription
            return .error("\(message) Files in \(name): \(files).")
        }

        let total = text.count
        guard offset < total || (offset == 0 && total == 0) else {
            return .error("offset \(offset) is past the end of \(path) (\(total) characters).")
        }
        let start = text.index(text.startIndex, offsetBy: offset)
        let end = text.index(start, offsetBy: limit, limitedBy: text.endIndex) ?? text.endIndex
        let page = text[start..<end]
        let endOffset = offset + page.count
        context.emit(.trace(.skill, "Read \(name)/\(path)"))

        let header: String
        if offset == 0, endOffset == total {
            header = "[\(name)/\(path) · \(total) characters]"
        } else if endOffset < total {
            header = "[\(name)/\(path) · characters \(offset)–\(endOffset) of \(total) · call \(Self.name) with offset \(endOffset) to continue]"
        } else {
            header = "[\(name)/\(path) · characters \(offset)–\(endOffset) of \(total) · end of file]"
        }
        return ToolOutput(content: [.text(header + "\n" + page)], summary: "Read \(path)")
    }
}
