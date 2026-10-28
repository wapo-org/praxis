import Foundation
import AgentCore
import AgentSkills

/// Builds the user message for a new turn. Context changes reach the model
/// as `.note` parts on that message — never as edits to the system prompt
/// or earlier messages. What was already said is read back from the
/// transcript, so the same history always yields the same notes (retry
/// and edit, which cut the tail, re-announce what they cut).
public enum TurnNotes {
    /// Notes go first so the model reads them before the request; OpenAI
    /// adapters hoist them into system messages ahead of the turn anyway.
    public static func userMessage(text: String, images: [MediaData] = [], documents: [MediaData] = [],
                                   mode: AgentMode, effort: Effort, previous: [Message],
                                   setup: ConversationSetup, skills: [Skill]) -> Message {
        var parts = notes(mode: mode, effort: effort, previous: previous, setup: setup, skills: skills).map(Part.note)
        parts += images.map(Part.image) + documents.map(Part.document)
        if !text.isEmpty { parts.append(.text(text)) }
        return Message(role: .user, parts: parts)
    }

    /// - The mode note on the first turn and whenever mode or effort
    ///   differs from the last one announced.
    /// - `SkillCatalog.additionNote` for installed skills that are neither
    ///   in the frozen catalog nor announced earlier (only when the
    ///   conversation has the skill tools).
    public static func notes(mode: AgentMode, effort: Effort, previous: [Message],
                             setup: ConversationSetup, skills: [Skill]) -> [String] {
        let userNotes = previous.filter { $0.role == .user }.flatMap(\.parts).compactMap { part -> String? in
            if case .note(let n) = part { return n }
            return nil
        }
        var notes: [String] = []
        let modeNote = SystemPrompt.modeNote(mode: mode, effort: effort)
        if userNotes.last(where: modeNotes.contains) != modeNote { notes.append(modeNote) }

        if setup.includesSkills {
            let known = Set(setup.skillNames).union(userNotes.flatMap(announcedSkills(in:)))
            let added = skills.filter { !known.contains($0.name) }
            if !added.isEmpty { notes.append(SkillCatalog.additionNote(for: added)) }
        }
        return notes
    }

    /// Every possible mode note, to recognise them without parsing.
    private static let modeNotes: Set<String> = Set(AgentMode.allCases.flatMap { mode in
        Effort.allCases.map { SystemPrompt.modeNote(mode: mode, effort: $0) }
    })

    /// Skill names from an addition note's `- name: description` lines.
    /// Mode notes have no such lines, and skill names can't contain ": ".
    static func announcedSkills(in note: String) -> [String] {
        note.split(separator: "\n").compactMap { line in
            guard line.hasPrefix("- "), let end = line.range(of: ": ") else { return nil }
            return String(line[line.index(line.startIndex, offsetBy: 2)..<end.lowerBound])
        }
    }
}

public extension AgentRuntime {
    /// `TurnNotes.userMessage` against the skill store's current catalog.
    /// Persist the result as-is: later turns read their notes back from it.
    func userMessage(text: String, images: [MediaData] = [], documents: [MediaData] = [],
                     mode: AgentMode, effort: Effort, previous: [Message], setup: ConversationSetup) async -> Message {
        let skills = setup.includesSkills ? await skillStore?.skills() ?? [] : []
        return TurnNotes.userMessage(text: text, images: images, documents: documents, mode: mode, effort: effort,
                                     previous: previous, setup: setup, skills: skills)
    }
}
