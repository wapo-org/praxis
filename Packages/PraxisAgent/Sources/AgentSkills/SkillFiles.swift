import Foundation
import CryptoKit

/// Relative-path rules shared by the importer (archive entry names) and
/// `read_skill_file` (model-supplied paths).
enum SkillPath {
    /// `/`-separated, no empty / `.` components. Rejects `..`, absolute
    /// paths, drive letters, control characters and over-long names — a
    /// path that fails here could point outside the skill folder.
    static func normalize(_ raw: String) throws -> String {
        let unified = raw.replacingOccurrences(of: "\\", with: "/")
        if unified.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F }) {
            throw SkillError.unsafeContent("“\(printable(raw))” contains control characters.")
        }
        if unified.hasPrefix("/") || unified.hasPrefix("~") {
            throw SkillError.unsafeContent("“\(printable(raw))” is an absolute path; only paths inside the skill are allowed.")
        }
        let parts = unified.split(separator: "/", omittingEmptySubsequences: true).filter { $0 != "." }
        if let first = parts.first, first.count == 2, first.last == ":", first.first?.isLetter == true {
            throw SkillError.unsafeContent("“\(printable(raw))” is an absolute path; only paths inside the skill are allowed.")
        }
        if parts.contains("..") {
            throw SkillError.unsafeContent("“\(printable(raw))” points outside the skill folder (..).")
        }
        if parts.contains(where: { $0.utf8.count > 255 }) || unified.utf8.count > 1024 {
            throw SkillError.unsafeContent("“\(printable(raw).prefix(80))…” is too long a path.")
        }
        return parts.joined(separator: "/")
    }

    /// Hidden files (`.git/`, `.DS_Store`, AppleDouble `._x`) and macOS
    /// `__MACOSX/` resource forks: never part of a skill, silently skipped.
    static func isIgnored(_ path: String) -> Bool {
        path.split(separator: "/").contains { $0.hasPrefix(".") || $0 == "__MACOSX" }
    }

    /// Collision key: APFS on macOS is case-insensitive and both platforms
    /// normalize Unicode, so `A.md`/`a.md` or NFC/NFD twins would overwrite
    /// each other on disk.
    static func collisionKey(_ path: String) -> String {
        path.precomposedStringWithCanonicalMapping.lowercased()
    }

    static func printable(_ s: String) -> String {
        String(String.UnicodeScalarView(s.unicodeScalars.map { $0.value < 0x20 || $0.value == 0x7F ? "?" : $0 }))
    }
}

/// Decides which files of a skill survive. Scripts can't run on device, so
/// they're dropped rather than shown to the model as if they could; what's
/// left is exactly what `read_skill_file` can return (UTF-8 text).
enum SkillFileFilter {
    static let executableExtensions: Set<String> = [
        // Scripts
        "py", "pyc", "pyo", "pyw", "pyz", "ipynb", "sh", "bash", "zsh", "fish", "ksh", "csh", "tcsh", "command",
        "js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx", "rb", "pl", "pm", "php", "lua", "tcl", "r",
        "ps1", "psm1", "bat", "cmd", "vbs", "applescript", "scpt", "awk", "groovy", "kts", "swift",
        // Binaries and packages
        "exe", "com", "bin", "elf", "o", "a", "so", "dylib", "dll", "jar", "class", "war", "wasm", "msi",
        "app", "pkg", "dmg", "deb", "rpm", "apk", "ipa", "node",
    ]

    /// Known document types: an execute bit on these is meaningless (some
    /// zip tools mark every file 0755) and is ignored.
    static let documentExtensions: Set<String> = [
        "md", "markdown", "mdx", "txt", "text", "rst", "adoc", "org", "tex", "json", "jsonl", "ndjson",
        "yaml", "yml", "toml", "ini", "cfg", "conf", "csv", "tsv", "html", "htm", "xhtml", "xml", "xsd", "xsl",
        "css", "svg", "sql", "graphql", "proto", "log", "diff", "patch", "tmpl", "template", "j2", "jinja",
        "mustache", "hbs", "bib", "srt", "vtt", "ics", "vcf",
    ]

    /// Decision from the name and permissions alone (no bytes read).
    static func dropReason(path: String, executable: Bool) -> DroppedFile.Reason? {
        if path == "SKILL.md" { return nil }
        let components = path.split(separator: "/")
        if components.dropLast().contains(where: { $0.lowercased() == "scripts" }) { return .scriptsDirectory }
        let ext = (path as NSString).pathExtension.lowercased()
        if executableExtensions.contains(ext) { return .executableType }
        if executable, !documentExtensions.contains(ext) { return .executablePermission }
        return nil
    }

    /// Decision from the content: `#!` scripts and anything that isn't UTF-8 text.
    static func dropReason(content: Data) -> DroppedFile.Reason? {
        if content.starts(with: [0x23, 0x21]) { return .executableType }
        return isText(content) ? nil : .binary
    }

    static func isText(_ data: Data) -> Bool {
        !data.contains(0) && String(data: data, encoding: .utf8) != nil
    }
}

enum SkillHash {
    /// SHA-256 over (path, size, bytes) of every file, sorted by path, so
    /// the hash only depends on content — not on archive order or mtimes.
    static func compute(_ files: [(path: String, data: Data)]) -> String {
        var hasher = SHA256()
        for file in files.sorted(by: { $0.path < $1.path }) {
            hasher.update(data: Data(file.path.utf8))
            hasher.update(data: Data([0]))
            hasher.update(data: Data(String(file.data.count).utf8))
            hasher.update(data: Data([0]))
            hasher.update(data: file.data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

/// Written next to an imported skill (hidden, so it's never listed or
/// readable): the hash computed at import, so loading the catalog doesn't
/// re-read every file, and what the importer dropped.
struct SkillInstallRecord: Codable, Sendable {
    static let fileName = ".skill-install.json"

    var contentHash: String
    var importedAt: Date
    /// File or archive name the skill was imported from.
    var source: String
    var removedFiles: [DroppedFile]
    /// Provenance; absent in records written before it existed (= `.file`).
    var origin: SkillSource?

    static func read(in directory: URL) -> SkillInstallRecord? {
        guard let data = try? Data(contentsOf: directory.appending(path: fileName)) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(SkillInstallRecord.self, from: data)
    }

    func write(in directory: URL) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        try encoder.encode(self).write(to: directory.appending(path: Self.fileName))
    }
}

/// Lists a skill folder without following symlinks.
enum SkillDirectory {
    struct Listing {
        var files: [(path: String, size: Int, executable: Bool)] = []
        var symlinks: [String] = []
        var special: [String] = []
        var truncated = false
    }

    /// Hidden entries are skipped; walking stops after `maxEntries` items
    /// or `maxDepth` levels so a hostile folder can't stall the app.
    static func list(_ root: URL, maxEntries: Int = 2_000, maxDepth: Int = 16) -> Listing {
        var listing = Listing()
        var visited = 0
        let fm = FileManager.default

        func walk(_ relative: String, depth: Int) {
            let dirPath = relative.isEmpty ? root.path : root.appending(path: relative).path
            guard depth <= maxDepth, let names = try? fm.contentsOfDirectory(atPath: dirPath) else {
                if depth > maxDepth { listing.truncated = true }
                return
            }
            for name in names.sorted() where !name.hasPrefix(".") && name != "__MACOSX" {
                visited += 1
                if visited > maxEntries { listing.truncated = true; return }
                let rel = relative.isEmpty ? name : relative + "/" + name
                let fullPath = dirPath + "/" + name
                guard let attrs = try? fm.attributesOfItem(atPath: fullPath) else { continue }
                switch attrs[.type] as? FileAttributeType {
                case .typeDirectory?:
                    walk(rel, depth: depth + 1)
                case .typeRegular?:
                    let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
                    let mode = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0o644
                    listing.files.append((rel, size, mode & 0o111 != 0))
                case .typeSymbolicLink?:
                    listing.symlinks.append(rel)
                default:
                    listing.special.append(rel)
                }
            }
        }
        walk("", depth: 0)
        return listing
    }
}
