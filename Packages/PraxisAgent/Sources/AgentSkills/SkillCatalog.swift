import Foundation

/// Text that tells the model which skills exist.
///
/// The system-prompt section is built once per conversation and frozen
/// (prompt caching, append-only history), so it must be byte-identical for
/// the same skills: entries are sorted by name and descriptions are
/// whitespace-normalized. Skills added later are announced by appending
/// `additionNote` as a `.note` part instead of editing the prompt.
public enum SkillCatalog {
    /// Empty when there are no skills, so callers can append it unconditionally.
    public static func systemPromptSection(for skills: [Skill]) -> String {
        let entries = lines(for: skills)
        guard !entries.isEmpty else { return "" }
        return """
        # Skills

        Skills are packaged instructions for specific kinds of tasks. When a request matches a skill's description, \
        call \(LoadSkillTool.name) with its name before starting, then follow the instructions it returns; \
        use \(ReadSkillFileTool.name) for files the skill refers to. Only load skills that are relevant.

        <available_skills>
        \(entries.joined(separator: "\n"))
        </available_skills>
        """
    }

    /// Announces skills imported after the conversation started.
    public static func additionNote(for skills: [Skill]) -> String {
        let entries = lines(for: skills)
        guard !entries.isEmpty else { return "" }
        let noun = entries.count == 1 ? "A new skill is" : "New skills are"
        return "\(noun) now available (load with \(LoadSkillTool.name) when relevant):\n" + entries.joined(separator: "\n")
    }

    static func lines(for skills: [Skill]) -> [String] {
        var seen = Set<String>()
        return skills.sorted { $0.name < $1.name }
            .filter { seen.insert($0.name).inserted }
            .map { "- \($0.name): \(normalized($0.description))" }
    }

    /// One line per skill: newlines and runs of whitespace collapse to a space.
    static func normalized(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
