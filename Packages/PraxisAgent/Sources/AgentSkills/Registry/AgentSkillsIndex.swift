import Foundation
import AgentCore

/// An Agent Skills discovery index (Cloudflare RFC, merged into the
/// agentskills.io spec): `/.well-known/agent-skills/index.json`.
///
/// This is also the format for a custom registry — we don't define our
/// own. Schema 0.2.0:
///
/// ```json
/// {
///   "$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
///   "skills": [
///     { "name": "code-review", "type": "skill-md",
///       "description": "Review code for bugs, security issues, and best practices.",
///       "url": "code-review/SKILL.md", "digest": "sha256:<64 hex>" },
///     { "name": "wrangler", "type": "archive",
///       "description": "Deploy and manage Cloudflare Workers projects.",
///       "url": "/.well-known/agent-skills/wrangler.tar.gz", "digest": "sha256:<64 hex>" }
///   ]
/// }
/// ```
///
/// - `url` resolves against the index URL (absolute, path-absolute or
///   relative) and must end up https.
/// - `digest` is the SHA-256 of the artifact's bytes; downloads that don't
///   match are refused, so entries without a valid digest aren't installable.
/// - `archive` may be `.zip` or `.tar.gz`; `SKILL.md` at the archive root
///   (a single top-level folder is accepted too).
/// - Unknown `type`s are skipped; an unknown `$schema` is refused. An index
///   without `$schema` is read as 0.1.0 (`files`: paths under
///   `<index folder>/<name>/`, no digests, so no update checks).
struct AgentSkillsIndex {
    struct Entry {
        var name: String
        var description: String
        var artifact: RegistrySkill.Artifact
        var digest: String?
        var problem: String?
    }

    var entries: [Entry] = []
    var warnings: [String] = []

    init(data: Data, url: URL) throws {
        guard let json = try? JSONValue(parsing: data), let skills = json["skills"]?.arrayValue else {
            throw SkillRegistryError.invalidIndex("\(url.host() ?? "This address") didn't return a skills index (JSON with a \"skills\" list).")
        }
        let schema = json["$schema"]?.stringValue
        if let schema, schema != SkillRegistryClient.discoverySchemaV2 {
            throw SkillRegistryError.invalidIndex("This index uses a format this app doesn't know (\(schema)). Supported: Agent Skills discovery 0.2.0.")
        }
        var seen = Set<String>()
        var skippedTypes = 0
        for item in skills {
            guard let name = item["name"]?.stringValue?.trimmingCharacters(in: .whitespaces), !name.isEmpty else { continue }
            guard seen.insert(name).inserted else {
                warnings.append("“\(name)” is listed more than once; the first entry is used.")
                continue
            }
            let description = item["description"]?.stringValue ?? ""
            var problem = SkillDocument.nameProblems(name).first.map { "Invalid name: \($0)" }

            if schema == nil {
                let paths = item["files"]?.arrayValue?.compactMap(\.stringValue) ?? ["SKILL.md"]
                let base = url.deletingLastPathComponent().appending(path: name + "/", directoryHint: .isDirectory)
                entries.append(Entry(name: name, description: description, artifact: .files(base: base, paths: paths),
                                     digest: nil, problem: problem))
                continue
            }

            guard let rawURL = item["url"]?.stringValue,
                  let artifactURL = URL(string: rawURL, relativeTo: url)?.absoluteURL else {
                entries.append(Entry(name: name, description: description,
                                     artifact: .skillMarkdown(url: url, digest: nil), digest: nil,
                                     problem: problem ?? "The index gives no download address."))
                continue
            }
            if artifactURL.scheme?.lowercased() != "https" { problem = problem ?? "The download address isn't https." }
            let digest = item["digest"]?.stringValue?.lowercased()
            if !Self.isValidDigest(digest) { problem = problem ?? "The index has no valid sha256 digest, so the download can't be verified." }

            switch item["type"]?.stringValue {
            case "skill-md"?:
                entries.append(Entry(name: name, description: description, artifact: .skillMarkdown(url: artifactURL, digest: digest),
                                     digest: digest, problem: problem))
            case "archive"?:
                entries.append(Entry(name: name, description: description, artifact: .archive(url: artifactURL, digest: digest),
                                     digest: digest, problem: problem))
            default:
                skippedTypes += 1
            }
        }
        if skippedTypes > 0 {
            warnings.append("\(skippedTypes) entr\(skippedTypes == 1 ? "y has" : "ies have") a type this app doesn't support and \(skippedTypes == 1 ? "is" : "are") hidden.")
        }
    }

    static func isValidDigest(_ digest: String?) -> Bool {
        guard let digest, digest.hasPrefix("sha256:") else { return false }
        let hex = digest.dropFirst(7)
        return hex.count == 64 && hex.allSatisfy { $0.isHexDigit && !$0.isUppercase }
    }
}
