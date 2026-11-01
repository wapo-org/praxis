import Foundation

/// Where a skill came from. Bundled skills ship read-only inside the app;
/// imported ones live in the app's container and can be updated or removed.
public enum SkillOrigin: String, Sendable, Codable, Hashable {
    case bundled, imported
}

/// How an installed (non-bundled) skill got onto the device. Kept in the
/// skill's install record; nil for bundled skills and folders placed by hand.
public struct SkillSource: Sendable, Codable, Hashable {
    public enum Kind: String, Sendable, Codable, Hashable {
        /// Imported by the user from Files (zip, folder, SKILL.md).
        case file
        /// Written by the agent with `save_skill` (or edited in the app afterwards).
        case agent
        /// Installed from a skill registry.
        case registry
    }

    public var kind: Kind
    /// Registry id (`SkillRegistrySource.id`) for `.registry`.
    public var registryID: String?
    /// Registry display name at install time.
    public var registryName: String?
    /// The registry entry's id (GitHub folder path, index entry name).
    public var entryID: String?
    /// What was installed: GitHub folder tree SHA or the index digest.
    /// Update checks compare it with the registry's current value.
    public var revision: String?
    /// A page to show the user (GitHub folder, index URL).
    public var pageURL: URL?
    /// The conversation that created it, for `.agent`.
    public var conversationID: String?

    public init(kind: Kind, registryID: String? = nil, registryName: String? = nil, entryID: String? = nil,
                revision: String? = nil, pageURL: URL? = nil, conversationID: String? = nil) {
        self.kind = kind
        self.registryID = registryID
        self.registryName = registryName
        self.entryID = entryID
        self.revision = revision
        self.pageURL = pageURL
        self.conversationID = conversationID
    }

    public static let file = SkillSource(kind: .file)
    public static func agent(conversationID: String?) -> SkillSource { SkillSource(kind: .agent, conversationID: conversationID) }
}

/// A file inside a skill folder other than `SKILL.md`.
public struct SkillFile: Sendable, Codable, Hashable {
    /// Relative to the skill folder, `/`-separated.
    public var path: String
    public var size: Int

    public init(path: String, size: Int) {
        self.path = path
        self.size = size
    }
}

/// A file left out of a skill because nothing on device can run it (or
/// read it as text). Reported on import and repeated in `load_skill` so the
/// model knows why instructions mention a file it can't see.
public struct DroppedFile: Sendable, Codable, Hashable {
    public enum Reason: String, Sendable, Codable, Hashable, CustomStringConvertible {
        /// Anything under a `scripts/` folder.
        case scriptsDirectory
        /// Script or binary extension (`.py`, `.sh`, `.js`, `.exe`, …) or a `#!` line.
        case executableType
        /// Unix execute bit on a file that isn't a known document type.
        case executablePermission
        /// Not UTF-8 text (images, PDFs, archives, …): unreadable by `read_skill_file`.
        case binary

        public var description: String {
            switch self {
            case .scriptsDirectory: return "in a scripts folder"
            case .executableType: return "script or executable"
            case .executablePermission: return "marked executable"
            case .binary: return "binary file"
            }
        }
    }

    public var path: String
    public var reason: Reason

    public init(path: String, reason: Reason) {
        self.path = path
        self.reason = reason
    }
}

/// One entry of the skill catalog. Only the metadata is kept in memory —
/// the `SKILL.md` body and other files are read from disk when the model
/// asks for them (`SkillStore.instructions(for:)` / `readText`).
public struct Skill: Sendable, Hashable, Identifiable {
    public var name: String
    public var description: String
    public var license: String?
    public var compatibility: String?
    /// The frontmatter `metadata` map (author, version, …), if any.
    public var metadata: [String: String]
    /// Readable files besides `SKILL.md`, sorted by path.
    public var files: [SkillFile]
    /// Files removed on import (or hidden, for bundled skills).
    public var removedFiles: [DroppedFile]
    public var origin: SkillOrigin
    /// An imported skill that replaces a bundled one with the same name.
    public var overridesBundled: Bool
    /// SHA-256 (hex) over every installed file's path and bytes. Changes
    /// whenever a re-import changes anything.
    public var contentHash: String
    /// Non-fatal format problems (long body, folder/name mismatch, …).
    public var warnings: [String]
    /// The skill folder. Container paths change across app updates, so
    /// persist names, never these URLs.
    public var directory: URL
    /// Where an imported skill came from (user file, agent, registry).
    public var source: SkillSource?
    /// Written by the agent: the agent may replace or delete it, and the
    /// Skills screen labels it and lets the user edit it.
    public var isAgentCreated: Bool { source?.kind == .agent }

    public var id: String { name }

    public init(name: String, description: String, license: String? = nil, compatibility: String? = nil,
                metadata: [String: String] = [:], files: [SkillFile] = [], removedFiles: [DroppedFile] = [],
                origin: SkillOrigin, overridesBundled: Bool = false, contentHash: String = "",
                warnings: [String] = [], directory: URL, source: SkillSource? = nil) {
        self.name = name
        self.description = description
        self.license = license
        self.compatibility = compatibility
        self.metadata = metadata
        self.files = files
        self.removedFiles = removedFiles
        self.origin = origin
        self.overridesBundled = overridesBundled
        self.contentHash = contentHash
        self.warnings = warnings
        self.directory = directory
        self.source = source
    }
}

/// Caps applied to imports (and to `SKILL.md` when loading the catalog).
/// They bound memory and disk use for untrusted archives; a real skill is
/// a few markdown files and nowhere near them.
public struct SkillLimits: Sendable, Hashable {
    /// Total uncompressed bytes of all files (hidden/system files excluded).
    public var maxTotalBytes: Int
    public var maxFiles: Int
    public var maxSkillFileBytes: Int
    /// A large entry that inflates more than this many times its compressed
    /// size is treated as a zip bomb.
    public var maxCompressionRatio: Int

    public init(maxTotalBytes: Int = 10 * 1024 * 1024, maxFiles: Int = 200, maxSkillFileBytes: Int = 64 * 1024,
                maxCompressionRatio: Int = 100) {
        self.maxTotalBytes = maxTotalBytes
        self.maxFiles = maxFiles
        self.maxSkillFileBytes = maxSkillFileBytes
        self.maxCompressionRatio = maxCompressionRatio
    }
}

/// A skill as the agent (or the app's editor) writes it: frontmatter
/// fields plus the markdown body, and text reference files.
public struct SkillDraft: Sendable, Hashable {
    public var name: String
    public var description: String
    /// The `SKILL.md` body (markdown after the frontmatter).
    public var instructions: String
    /// Extra text files, path (relative to the skill folder) → content.
    public var files: [String: String]
    /// Existing files to delete when replacing.
    public var removeFiles: [String]

    public init(name: String, description: String, instructions: String, files: [String: String] = [:],
                removeFiles: [String] = []) {
        self.name = name
        self.description = description
        self.instructions = instructions
        self.files = files
        self.removeFiles = removeFiles
    }
}

/// A validated skill that hasn't been installed (registry preview).
public struct SkillInspection: Sendable, Hashable {
    public var name: String
    public var skillMarkdown: String
    public var files: [SkillFile]
    public var dropped: [DroppedFile]
    public var warnings: [String]
}

/// What an import did, for the confirmation UI.
public struct SkillImportReport: Sendable, Hashable {
    public var skill: Skill
    /// Scripts, executables and binaries that were left out.
    public var dropped: [DroppedFile]
    public var warnings: [String]
    /// An imported skill with the same name was replaced.
    public var replacedExisting: Bool
    /// Hash of the replaced version; equal to `skill.contentHash` when the
    /// re-import changed nothing.
    public var previousContentHash: String?
}

/// A skill folder the store couldn't load, for the settings UI.
public struct SkillLoadProblem: Sendable, Hashable {
    public var folder: String
    public var origin: SkillOrigin
    public var message: String
}

public enum SkillError: Error, Sendable, Hashable, LocalizedError, CustomStringConvertible {
    /// `SKILL.md` is missing or breaks the format rules. One message per problem.
    case invalidSkill([String])
    /// Not a folder or a ZIP we can read (corrupt, ZIP64, encrypted, multi-disk, …).
    case unreadableArchive(String)
    /// Refused for safety: path traversal, absolute path, symlink, duplicate path, zip bomb.
    case unsafeContent(String)
    /// Over a size or count cap.
    case tooLarge(String)
    case notFound(String)
    /// Bundled skills can't be changed or removed; the agent can't change
    /// skills the user installed.
    case readOnly(String)
    /// Saving would overwrite a skill without being asked to.
    case alreadyExists(String)
    case fileSystem(String)

    public var description: String {
        switch self {
        case .invalidSkill(let problems):
            return problems.count == 1 ? problems[0] : "This skill has problems:\n" + problems.map { "• \($0)" }.joined(separator: "\n")
        case .unreadableArchive(let m), .unsafeContent(let m), .tooLarge(let m), .notFound(let m),
             .readOnly(let m), .alreadyExists(let m), .fileSystem(let m):
            return m
        }
    }

    public var errorDescription: String? { description }
}
