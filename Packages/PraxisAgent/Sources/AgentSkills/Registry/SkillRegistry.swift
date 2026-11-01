import Foundation

/// Where a skill registry lives. Nothing is hosted by the app: a registry
/// is either a public GitHub repository read through the GitHub API (one
/// listing call, file contents from raw.githubusercontent.com) or a JSON
/// index in the Agent Skills discovery format
/// (`/.well-known/agent-skills/index.json`, schema 0.2.0; see
/// `AgentSkillsIndex`).
public enum SkillRegistrySource: Sendable, Codable, Hashable {
    /// Every folder with a `SKILL.md` under `path` (whole repo when nil)
    /// at `ref` (default branch when nil).
    case github(owner: String, repo: String, path: String?, ref: String?)
    /// An Agent Skills discovery index.
    case index(URL)

    public var id: String {
        switch self {
        case .github(let owner, let repo, let path, let ref):
            return "github:\(owner.lowercased())/\(repo.lowercased())" + (path.map { "/\($0)" } ?? "") + (ref.map { "@\($0)" } ?? "")
        case .index(let url):
            return "index:\(url.absoluteString)"
        }
    }

    /// Where a person can look at it.
    public var pageURL: URL? {
        switch self {
        case .github(let owner, let repo, let path, let ref):
            var s = "https://github.com/\(owner)/\(repo)"
            if path != nil || ref != nil { s += "/tree/\(ref ?? "HEAD")" + (path.map { "/\($0)" } ?? "") }
            return URL(string: s)
        case .index(let url):
            return url
        }
    }

    /// Short text for the UI: "github.com/anthropics/skills", "developers.cloudflare.com".
    public var displayLocation: String {
        switch self {
        case .github(let owner, let repo, let path, _):
            return "github.com/\(owner)/\(repo)" + (path.map { "/\($0)" } ?? "")
        case .index(let url):
            return url.host() ?? url.absoluteString
        }
    }

    /// Reads what a user pastes: `owner/repo`, a GitHub repo or folder URL
    /// (`…/tree/<ref>/<path>`), an `index.json` URL, or a site URL (its
    /// `/.well-known/agent-skills/index.json` is used).
    public static func parse(_ raw: String) throws -> SkillRegistrySource {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw SkillRegistryError.invalidSource("Enter a GitHub repository or an index URL.") }

        let shorthand = text.split(separator: "/")
        if !text.contains(":"), !text.contains("."), shorthand.count == 2,
           shorthand.allSatisfy({ isGitHubName($0) }) {
            return .github(owner: String(shorthand[0]), repo: String(shorthand[1]), path: nil, ref: nil)
        }

        let withScheme = text.contains("://") ? text : "https://" + text
        guard let url = URL(string: withScheme), let host = url.host()?.lowercased(), !host.isEmpty else {
            throw SkillRegistryError.invalidSource("“\(text)” isn't a URL or owner/repo.")
        }
        guard url.scheme?.lowercased() == "https" else {
            throw SkillRegistryError.invalidSource("Registries must use https.")
        }
        if host == "github.com" || host == "www.github.com" {
            let parts = url.pathComponents.filter { $0 != "/" }
            guard parts.count >= 2, isGitHubName(Substring(parts[0])), isGitHubName(Substring(parts[1].replacingOccurrences(of: ".git", with: ""))) else {
                throw SkillRegistryError.invalidSource("A GitHub registry URL looks like github.com/owner/repo.")
            }
            let repo = parts[1].hasSuffix(".git") ? String(parts[1].dropLast(4)) : parts[1]
            var ref: String?
            var path: String?
            if parts.count >= 4, parts[2] == "tree" || parts[2] == "blob" {
                ref = parts[3]
                let rest = parts.dropFirst(4).joined(separator: "/")
                path = rest.isEmpty ? nil : rest
                if path?.hasSuffix("SKILL.md") == true {
                    path = (path! as NSString).deletingLastPathComponent
                    if path?.isEmpty == true { path = nil }
                }
            }
            return .github(owner: parts[0], repo: repo, path: path, ref: ref)
        }
        let path = url.path()
        if path.lowercased().hasSuffix(".json") { return .index(url) }
        var base = url
        if !path.hasSuffix("/") { base = URL(string: url.absoluteString + "/") ?? url }
        if path.hasSuffix("/.well-known/agent-skills") || path.hasSuffix("/.well-known/agent-skills/") {
            return .index(base.appending(path: "index.json"))
        }
        let origin = URL(string: "https://\(url.host() ?? "")\(url.port.map { ":\($0)" } ?? "")")!
        return .index(origin.appending(path: ".well-known/agent-skills/index.json"))
    }

    private static func isGitHubName(_ s: Substring) -> Bool {
        !s.isEmpty && s.count <= 100 && s.allSatisfy { $0.isLetter || $0.isNumber || "-_.".contains($0) } && s.allSatisfy(\.isASCII)
    }
}

/// A registry the user can browse.
public struct SkillRegistry: Sendable, Codable, Hashable, Identifiable {
    public var name: String
    public var source: SkillRegistrySource
    public var isBuiltIn: Bool
    public var id: String { source.id }

    public init(name: String, source: SkillRegistrySource, isBuiltIn: Bool = false) {
        self.name = name
        self.source = source
        self.isBuiltIn = isBuiltIn
    }

    /// Anthropic's public skills repository (the Agent Skills reference
    /// collection: documents, design, MCP building, …).
    public static let anthropic = SkillRegistry(
        name: "Anthropic", source: .github(owner: "anthropics", repo: "skills", path: "skills", ref: nil), isBuiltIn: true)
    /// OpenAI's curated skills for Codex (same SKILL.md format).
    public static let openAICurated = SkillRegistry(
        name: "OpenAI (curated)", source: .github(owner: "openai", repo: "skills", path: "skills/.curated", ref: nil), isBuiltIn: true)

    public static let builtIns: [SkillRegistry] = [anthropic, openAICurated]
}

public struct RegistryFile: Sendable, Codable, Hashable {
    /// Relative to the skill folder.
    public var path: String
    public var size: Int?
    public var executable: Bool

    public init(path: String, size: Int?, executable: Bool = false) {
        self.path = path
        self.size = size
        self.executable = executable
    }
}

/// One installable skill in a registry listing.
public struct RegistrySkill: Sendable, Codable, Hashable, Identifiable {
    public enum Artifact: Sendable, Codable, Hashable {
        /// A folder in a GitHub repo, pinned to the listed commit.
        case githubFolder(owner: String, repo: String, commit: String, path: String, skillBlob: String, files: [RegistryFile])
        /// A lone `SKILL.md` (discovery index `type: "skill-md"`).
        case skillMarkdown(url: URL, digest: String?)
        /// A `.zip` / `.tar.gz` (discovery index `type: "archive"`).
        case archive(url: URL, digest: String?)
        /// Discovery index v0.1.0: files listed by path under `base`.
        case files(base: URL, paths: [String])
    }

    /// Stable within the registry: the GitHub folder path or the index entry name.
    public var id: String
    public var registryID: String
    public var name: String
    public var description: String
    /// Changes whenever the skill's content changes (folder tree SHA or
    /// artifact digest); nil when the registry can't tell.
    public var revision: String?
    public var pageURL: URL?
    public var artifact: Artifact
    /// Why it can't be installed as listed (too large, invalid SKILL.md).
    public var problem: String?

    /// Files the listing knows about besides `SKILL.md` (GitHub only).
    public var listedFiles: [RegistryFile] {
        if case .githubFolder(_, _, _, _, _, let files) = artifact { return files.filter { $0.path != "SKILL.md" } }
        return []
    }

    /// Listed files that won't be installed (scripts, executables).
    public var skippedFiles: [DroppedFile] {
        listedFiles.compactMap { file in
            SkillFileFilter.dropReason(path: file.path, executable: file.executable).map { DroppedFile(path: file.path, reason: $0) }
        }
    }
}

public struct RegistryListing: Sendable, Codable, Hashable {
    public var registryID: String
    public var skills: [RegistrySkill]
    public var fetchedAt: Date
    /// Non-fatal: truncated listing, skipped entries, served from cache.
    public var warnings: [String]
    /// GitHub: the commit the listing was read at.
    public var commit: String?
}

/// What the detail screen shows before installing.
public struct RegistryPreview: Sendable, Hashable {
    public var skill: RegistrySkill
    /// The `SKILL.md` text as published.
    public var skillMarkdown: String
    /// Files that would be installed besides `SKILL.md`.
    public var files: [SkillFile]
    /// Files that would be left out (scripts, executables, binaries).
    public var skipped: [DroppedFile]
    /// Format warnings, or the reason it can't be installed.
    public var warnings: [String]
}

/// An installed registry skill whose registry lists different content.
public struct RegistryUpdate: Sendable, Hashable {
    public var installedName: String
    public var registry: SkillRegistry
    public var latest: RegistrySkill
}

public enum SkillRegistryError: Error, Sendable, Hashable, LocalizedError, CustomStringConvertible {
    case invalidSource(String)
    /// GitHub's unauthenticated limit (60 requests/hour per IP) is used up.
    case rateLimited(resetsAt: Date?)
    case http(status: Int, url: String)
    case invalidIndex(String)
    /// Downloaded bytes don't match the index digest: refused.
    case digestMismatch(String)
    case notInstallable(String)
    case network(String)

    public var description: String {
        switch self {
        case .invalidSource(let m), .invalidIndex(let m), .notInstallable(let m): return m
        case .rateLimited(let reset):
            guard let reset else { return "GitHub's limit for apps without an account is used up. Try again in a while." }
            let f = DateFormatter()
            f.timeStyle = .short
            f.dateStyle = .none
            return "GitHub's limit for apps without an account is used up until \(f.string(from: reset)). Try again then."
        case .http(let status, let url): return "The registry answered HTTP \(status) for \(url)."
        case .digestMismatch(let name): return "The download of \(name) doesn't match the registry's checksum, so it wasn't installed."
        case .network(let m): return m
        }
    }

    public var errorDescription: String? { description }
}
