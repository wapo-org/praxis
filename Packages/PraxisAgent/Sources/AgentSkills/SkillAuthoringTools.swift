import Foundation
import AgentCore

/// `save_skill {name, description, instructions, files?, remove_files?, replace?}`:
/// the agent writes a reusable skill to this device.
///
/// **Approval.** Not read-only, so `ToolPolicy` refuses it in Ask and Plan
/// and asks in Build. Creating a new skill is allowed in Auto; replacing
/// one (`replace: true`) is treated as destructive and asked, and has its
/// own "always allow" key, so allowing creation never covers overwrites.
///
/// **Same conversation.** The system prompt's catalog is frozen, but
/// `load_skill` reads the live store, so the new skill loads by name right
/// away; the result says so. New conversations list it in their catalog,
/// and this one gets the usual "new skill" note on the next user turn.
public struct SaveSkillTool: AgentTool {
    public static let name = "save_skill"
    let store: SkillStore

    public init(store: SkillStore) {
        self.store = store
    }

    public var spec: ToolSpec {
        ToolSpec(
            name: Self.name,
            description: """
            Save a reusable skill on this device: instructions for a kind of task that you (in this or later conversations) \
            can load with load_skill. Use it when the user asks you to remember how to do something, or after working out a \
            procedure worth reusing. Skills are markdown only: scripts can't run on this device, so script files are not saved. \
            Only skills you created can be replaced (replace: true) or deleted.
            """,
            inputSchema: [
                "type": "object",
                "properties": [
                    "name": ["type": "string", "description": "Lowercase letters, numbers and hyphens, max 64 characters, e.g. \"weekly-report\""],
                    "description": ["type": "string", "description": "One or two sentences: what the skill does and when to use it (max 1024 characters, no XML tags). This is what future conversations see in the skill list."],
                    "instructions": ["type": "string", "description": "The SKILL.md body in markdown: steps, rules, examples. Keep it under ~500 lines; put long reference material in files."],
                    "files": [
                        "type": "array",
                        "description": "Optional extra text files the instructions refer to, e.g. reference/checklist.md",
                        "items": [
                            "type": "object",
                            "properties": [
                                "path": ["type": "string", "description": "Relative path inside the skill folder"],
                                "content": ["type": "string"],
                            ],
                            "required": ["path", "content"],
                        ],
                    ],
                    "remove_files": ["type": "array", "items": ["type": "string"], "description": "When replacing: existing files to delete"],
                    "replace": ["type": "boolean", "description": "Overwrite an existing skill you created earlier (default false). Files you don't pass or remove are kept."],
                ],
                "required": ["name", "description", "instructions"],
            ])
    }

    public var traits: ToolTraits { [] }
    public var source: ToolSource { .skill }

    static func replaces(_ arguments: JSONValue) -> Bool { arguments["replace"]?.boolValue == true }

    /// Replacing is destructive and gets its own always-allow key.
    public func subject(for arguments: JSONValue) -> ToolSubject? {
        let base = ToolSubject(spec: spec, source: source, traits: traits)
        guard Self.replaces(arguments) else { return base }
        return ToolSubject(name: base.name, source: base.source, traits: [.destructive], fingerprint: base.fingerprint + "-replace")
    }

    public func presentation(for arguments: JSONValue) -> ToolPresentation {
        let name = arguments["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        let verb = Self.replaces(arguments) ? ("Updating", "Updated") : ("Saving", "Saved")
        return ToolPresentation(category: .skill,
                                runningTitle: name.map { "\(verb.0) \($0) skill…" } ?? "\(verb.0) skill…",
                                finishedTitle: name.map { "\(verb.1) \($0) skill" } ?? "\(verb.1) skill")
    }

    public func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        let args = invocation.arguments
        guard let name = args["name"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return .error("Missing name.")
        }
        guard let description = args["description"]?.stringValue else { return .error("Missing description.") }
        guard let instructions = args["instructions"]?.stringValue else { return .error("Missing instructions.") }

        var files: [String: String] = [:]
        if let list = args["files"]?.arrayValue {
            for item in list {
                guard let path = item["path"]?.stringValue, let content = item["content"]?.stringValue else {
                    return .error("Each entry in files needs a path and a content string.")
                }
                guard files[path] == nil else { return .error("“\(path)” appears twice in files.") }
                files[path] = content
            }
        } else if args["files"] != nil, args["files"]?.isNull == false {
            return .error("files must be an array of {path, content} objects.")
        }
        let remove = args["remove_files"]?.arrayValue?.compactMap(\.stringValue) ?? []
        let replace = Self.replaces(args)

        let report: SkillImportReport
        do {
            report = try await store.saveAgentSkill(
                SkillDraft(name: name, description: description, instructions: instructions, files: files, removeFiles: remove),
                replace: replace, conversationID: context.conversationID)
        } catch let error as SkillError {
            return .error("Couldn't save the skill: \(error.description)")
        }
        context.emit(.trace(.skill, "\(report.replacedExisting ? "Updated" : "Saved") \(report.skill.name)"))

        var out = report.replacedExisting ? "Updated the skill “\(report.skill.name)”." : "Saved the new skill “\(report.skill.name)”."
        out += " It's available now: call \(LoadSkillTool.name) with name \"\(report.skill.name)\" to use it in this conversation. New conversations will list it with the other skills."
        if !report.skill.files.isEmpty {
            out += "\nFiles: " + report.skill.files.map(\.path).joined(separator: ", ") + "."
        }
        if !report.dropped.isEmpty {
            out += "\nNot saved (scripts and binaries can't be part of a skill on this device): "
                + report.dropped.map { "\($0.path) (\($0.reason))" }.joined(separator: ", ")
                + ". Describe those steps in the instructions instead."
        }
        if !report.warnings.isEmpty { out += "\nWarnings: " + report.warnings.joined(separator: " ") }
        return ToolOutput(content: [.text(out)], summary: "\(report.replacedExisting ? "Updated" : "Saved") \(report.skill.name) skill")
    }
}

/// `delete_skill {name}`: removes a skill the agent created. Destructive:
/// asked in Build and Auto, refused in Ask and Plan.
public struct DeleteSkillTool: AgentTool {
    public static let name = "delete_skill"
    let store: SkillStore

    public init(store: SkillStore) {
        self.store = store
    }

    public var spec: ToolSpec {
        ToolSpec(
            name: Self.name,
            description: "Delete a skill you created earlier with save_skill (skills the user installed can't be deleted).",
            inputSchema: [
                "type": "object",
                "properties": ["name": ["type": "string", "description": "Skill name"]],
                "required": ["name"],
            ])
    }

    public var traits: ToolTraits { [.destructive] }
    public var source: ToolSource { .skill }

    public func presentation(for arguments: JSONValue) -> ToolPresentation {
        let name = arguments["name"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
        return ToolPresentation(category: .skill,
                                runningTitle: name.map { "Deleting \($0) skill…" } ?? "Deleting skill…",
                                finishedTitle: name.map { "Deleted \($0) skill" } ?? "Deleted skill")
    }

    public func execute(_ invocation: ToolInvocation, context: ToolContext) async throws -> ToolOutput {
        guard let name = invocation.arguments["name"]?.stringValue?.trimmingCharacters(in: .whitespaces), !name.isEmpty else {
            return .error("Missing name.")
        }
        do {
            try await store.deleteAgentSkill(named: name)
        } catch let error as SkillError {
            return .error("Couldn't delete the skill: \(error.description)")
        }
        context.emit(.trace(.skill, "Deleted \(name)"))
        return .text("Deleted the skill “\(name)”. It can't be loaded any more.", summary: "Deleted \(name) skill")
    }
}
