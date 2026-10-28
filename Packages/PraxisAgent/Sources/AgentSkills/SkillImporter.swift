import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// A validated skill held in memory, ready to install.
struct ExtractedSkill {
    var name: String
    var document: SkillDocument
    var warnings: [String]
    /// Every kept file including `SKILL.md`, relative to the skill folder.
    var files: [(path: String, data: Data)]
    var dropped: [DroppedFile]
    var contentHash: String
    var sourceName: String
}

/// Turns a folder or a `.zip` / `.skill` archive into an installed skill.
///
/// Everything is validated in memory before a byte is written: paths
/// (traversal, absolute, duplicates), entry types (symlinks, devices),
/// caps (files, total size, `SKILL.md` size, compression ratio) and the
/// `SKILL.md` format. Scripts and binaries are dropped and reported.
/// Installation writes to a hidden staging folder and swaps it into place,
/// so a failed or interrupted import never leaves a half-written skill.
struct SkillImporter: Sendable {
    var limits: SkillLimits

    init(limits: SkillLimits = SkillLimits()) {
        self.limits = limits
    }

    /// One file or folder of the source, before any filtering.
    private struct SourceEntry {
        var rawPath: String
        var size: Int
        var compressedSize: Int?
        var isDirectory: Bool
        var isSymlink: Bool
        var isSpecial: Bool
        var isExecutable: Bool
        var read: () throws -> Data
    }

    // MARK: Extract

    func extract(from source: URL) throws -> ExtractedSkill {
        // Document-picker URLs are security-scoped; harmless for plain URLs.
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: source.path, isDirectory: &isDirectory) else {
            throw SkillError.notFound("Couldn't find \(source.lastPathComponent).")
        }
        let entries: [SourceEntry]
        let sourceFolderName: String?
        if isDirectory.boolValue {
            entries = try folderEntries(source)
            sourceFolderName = source.lastPathComponent
        } else {
            entries = try archiveEntries(source)
            sourceFolderName = nil
        }
        return try process(entries, sourceName: source.lastPathComponent, sourceFolderName: sourceFolderName)
    }

    /// Validates files held in memory (agent-written skills, registry
    /// downloads) exactly like an import: same path rules, caps, format
    /// checks and script dropping.
    ///
    /// `executable` marks files that carried an execute bit at the source
    /// (registry listings); they're judged by the same rule as archives.
    func extract(files: [(path: String, data: Data)], sourceName: String, folderName: String? = nil,
                 executable: Set<String> = []) throws -> ExtractedSkill {
        let entries = files.map { file in
            SourceEntry(rawPath: file.path, size: file.data.count, compressedSize: nil, isDirectory: false, isSymlink: false,
                        isSpecial: false, isExecutable: executable.contains(file.path), read: { file.data })
        }
        return try process(entries, sourceName: sourceName, sourceFolderName: folderName)
    }

    /// Validates an archive held in memory: ZIP (`.zip` / `.skill`) or
    /// gzip-compressed tar (`.tar.gz`, the Agent Skills discovery default).
    func extract(archive data: Data, name: String) throws -> ExtractedSkill {
        let maxArchive = limits.maxTotalBytes + 4 * 1024 * 1024
        guard data.count <= maxArchive else {
            throw SkillError.tooLarge("\(name) is \(Self.formatBytes(data.count)); skills are limited to \(Self.formatBytes(limits.maxTotalBytes)).")
        }
        let entries: [SourceEntry]
        if ZipArchive.isZip(data) {
            entries = try zipEntries(data)
        } else if TarArchive.isGzip(data) {
            entries = try tarEntries(data)
        } else {
            throw SkillError.unreadableArchive("\(name) isn't a ZIP or .tar.gz archive.")
        }
        return try process(entries, sourceName: name, sourceFolderName: nil)
    }

    private func tarEntries(_ data: Data) throws -> [SourceEntry] {
        let archive = try TarArchive(gzipped: data, maxBytes: limits.maxTotalBytes + 1024 * 1024,
                                     maxEntries: max(1_000, limits.maxFiles * 5))
        return archive.entries.map { entry in
            SourceEntry(rawPath: entry.name, size: entry.data.count, compressedSize: nil, isDirectory: entry.isDirectory,
                        isSymlink: entry.isLink, isSpecial: entry.isSpecial, isExecutable: entry.isExecutable,
                        read: { entry.data })
        }
    }

    private func folderEntries(_ root: URL) throws -> [SourceEntry] {
        let listing = SkillDirectory.list(root, maxEntries: max(1_000, limits.maxFiles * 5))
        if let link = listing.symlinks.first {
            throw SkillError.unsafeContent("“\(link)” is a symbolic link. Skills can't contain links.")
        }
        if let special = listing.special.first {
            throw SkillError.unsafeContent("“\(special)” isn't a regular file.")
        }
        if listing.truncated {
            throw SkillError.tooLarge("This folder has too many files or is nested too deeply to be a skill.")
        }
        return listing.files.map { file in
            SourceEntry(rawPath: file.path, size: file.size, compressedSize: nil, isDirectory: false, isSymlink: false,
                        isSpecial: false, isExecutable: file.executable,
                        read: { try Self.readRegularFile(root.appending(path: file.path), expectedSize: file.size) })
        }
    }

    /// Reads a file only if it's still the regular file we listed (not
    /// swapped for a link) and no larger than when it was counted.
    private static func readRegularFile(_ url: URL, expectedSize: Int) throws -> Data {
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attrs[.type] as? FileAttributeType == .typeRegular else {
            throw SkillError.unsafeContent("“\(url.lastPathComponent)” changed while importing.")
        }
        let data = try Data(contentsOf: url)
        guard data.count <= expectedSize else { throw SkillError.unsafeContent("“\(url.lastPathComponent)” changed while importing.") }
        return data
    }

    private func archiveEntries(_ url: URL) throws -> [SourceEntry] {
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        // Compressed data is never larger than the uncompressed cap plus
        // per-entry overhead; anything bigger can't hold a valid skill.
        let maxArchive = limits.maxTotalBytes + 4 * 1024 * 1024
        guard size <= maxArchive else {
            throw SkillError.tooLarge("\(url.lastPathComponent) is \(Self.formatBytes(size)); skills are limited to \(Self.formatBytes(limits.maxTotalBytes)).")
        }
        let data: Data
        do { data = try Data(contentsOf: url, options: .mappedIfSafe) } catch {
            throw SkillError.fileSystem("Couldn't read \(url.lastPathComponent): \(error.localizedDescription)")
        }
        if TarArchive.isGzip(data) { return try tarEntries(data) }
        guard ZipArchive.isZip(data) else {
            throw SkillError.unreadableArchive("\(url.lastPathComponent) isn't a ZIP archive or a skill folder.")
        }
        return try zipEntries(data)
    }

    private func zipEntries(_ data: Data) throws -> [SourceEntry] {
        let archive = try ZipArchive(data: data, maxEntries: max(1_000, limits.maxFiles * 5))
        try archive.checkLayout()
        return archive.entries.map { entry in
            SourceEntry(rawPath: entry.name, size: entry.uncompressedSize, compressedSize: entry.compressedSize,
                        isDirectory: entry.isDirectory, isSymlink: entry.isSymlink, isSpecial: entry.isSpecial,
                        isExecutable: entry.isExecutable, read: { try archive.contents(of: entry) })
        }
    }

    private func process(_ entries: [SourceEntry], sourceName: String, sourceFolderName: String?) throws -> ExtractedSkill {
        // 1. Paths and entry types. Checked for every entry — even ones that
        //    would be skipped — so a hostile archive is refused, not trimmed.
        var files: [(path: String, entry: SourceEntry)] = []
        var directories = Set<String>()
        var seen: [String: String] = [:]
        for entry in entries {
            let path = try SkillPath.normalize(entry.rawPath)
            if path.isEmpty { continue }
            if SkillPath.isIgnored(path) { continue }
            if entry.isSymlink {
                throw SkillError.unsafeContent("“\(path)” is a symbolic link. Skills can't contain links.")
            }
            if entry.isSpecial { throw SkillError.unsafeContent("“\(path)” isn't a regular file.") }
            if entry.isDirectory { directories.insert(SkillPath.collisionKey(path)); continue }
            let key = SkillPath.collisionKey(path)
            if let other = seen[key] {
                throw SkillError.unsafeContent(other == path ? "“\(path)” appears twice in the archive." : "“\(other)” and “\(path)” would overwrite each other.")
            }
            seen[key] = path
            files.append((path, entry))
        }
        // A file and a folder with the same name can't both exist on disk.
        for key in seen.keys {
            var parent = key
            while let slash = parent.lastIndex(of: "/") {
                parent = String(parent[..<slash])
                if let clash = seen[parent] { throw SkillError.unsafeContent("“\(clash)” is both a file and a folder.") }
            }
            if directories.contains(key) { throw SkillError.unsafeContent("“\(seen[key]!)” is both a file and a folder.") }
        }

        // 2. Caps, from declared sizes, before anything is decompressed.
        guard files.count <= limits.maxFiles else {
            throw SkillError.tooLarge("This skill has \(files.count) files; the limit is \(limits.maxFiles).")
        }
        let total = files.reduce(0) { $0 + $1.entry.size }
        guard total <= limits.maxTotalBytes else {
            throw SkillError.tooLarge("This skill is \(Self.formatBytes(total)) uncompressed; the limit is \(Self.formatBytes(limits.maxTotalBytes)).")
        }

        // 3. SKILL.md at the root, or inside a single top-level folder.
        let prefix: String
        var topFolder = sourceFolderName
        if files.contains(where: { $0.path == "SKILL.md" }) {
            prefix = ""
        } else {
            let tops = Set(files.map { $0.path.split(separator: "/").first.map(String.init) ?? "" })
            if tops.count == 1, let top = tops.first, files.contains(where: { $0.path == top + "/SKILL.md" }) {
                prefix = top + "/"
                topFolder = top
            } else if files.contains(where: { $0.path.hasSuffix("/SKILL.md") }) {
                throw SkillError.invalidSkill(["SKILL.md must be at the top of the archive or inside a single top-level folder (one skill per import)."])
            } else {
                throw SkillError.invalidSkill(["No SKILL.md found. A skill is a folder with a SKILL.md file (name in capitals)."])
            }
        }

        // 4. Filter and read.
        var kept: [(path: String, data: Data)] = []
        var dropped: [DroppedFile] = []
        for (fullPath, entry) in files {
            let path = String(fullPath.dropFirst(prefix.count))
            if path == "SKILL.md", entry.size > limits.maxSkillFileBytes {
                throw SkillError.tooLarge("SKILL.md is \(Self.formatBytes(entry.size)); the limit is \(Self.formatBytes(limits.maxSkillFileBytes)). Move detail into separate files.")
            }
            if let reason = SkillFileFilter.dropReason(path: path, executable: entry.isExecutable) {
                dropped.append(DroppedFile(path: path, reason: reason))
                continue
            }
            if let compressed = entry.compressedSize, entry.size > 256 * 1024,
               entry.size / max(compressed, 1) > limits.maxCompressionRatio {
                throw SkillError.unsafeContent("“\(path)” expands \(entry.size / max(compressed, 1))× when decompressed — this archive looks like a zip bomb.")
            }
            let data = try entry.read()
            if path == "SKILL.md" {
                guard SkillFileFilter.isText(data) else { throw SkillError.invalidSkill(["SKILL.md isn't UTF-8 text."]) }
            } else if let reason = SkillFileFilter.dropReason(content: data) {
                dropped.append(DroppedFile(path: path, reason: reason))
                continue
            }
            kept.append((path, data))
        }

        // 5. SKILL.md format.
        let skillData = kept.first { $0.path == "SKILL.md" }!.data
        let (document, warnings) = try SkillDocument.load(String(decoding: skillData, as: UTF8.self), folderName: topFolder)
        let name = document.name!

        kept.sort { $0.path < $1.path }
        dropped.sort { $0.path < $1.path }
        return ExtractedSkill(name: name, document: document, warnings: warnings, files: kept, dropped: dropped,
                              contentHash: SkillHash.compute(kept), sourceName: sourceName)
    }

    // MARK: Install

    struct InstallResult {
        var directory: URL
        var replaced: Bool
        var previousHash: String?
    }

    /// Writes the skill to `<root>/<name>/`, replacing an earlier import of
    /// the same name in one atomic directory swap.
    func install(_ skill: ExtractedSkill, into root: URL, origin: SkillSource = .file) throws -> InstallResult {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: root, withIntermediateDirectories: true)
            Self.removeLeftovers(in: root)

            let staging = root.appending(path: ".staging-\(UUID().uuidString)", directoryHint: .isDirectory)
            try fm.createDirectory(at: staging, withIntermediateDirectories: false)
            defer { try? fm.removeItem(at: staging) }

            for file in skill.files {
                let url = staging.appending(path: file.path)
                try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try file.data.write(to: url)
            }
            try SkillInstallRecord(contentHash: skill.contentHash, importedAt: Date(), source: skill.sourceName,
                                   removedFiles: skill.dropped, origin: origin).write(in: staging)

            let destination = root.appending(path: skill.name, directoryHint: .isDirectory)
            if fm.fileExists(atPath: destination.path) {
                let previous = SkillInstallRecord.read(in: destination)?.contentHash
                try Self.swap(staging, destination)
                return InstallResult(directory: destination, replaced: true, previousHash: previous)
            }
            try fm.moveItem(at: staging, to: destination)
            return InstallResult(directory: destination, replaced: false, previousHash: nil)
        } catch let error as SkillError {
            throw error
        } catch {
            throw SkillError.fileSystem("Couldn't save the skill: \(error.localizedDescription)")
        }
    }

    /// Exchanges two directories atomically (`renamex_np` + `RENAME_SWAP`);
    /// afterwards `staging` holds the old version and is deleted by the caller.
    private static func swap(_ staging: URL, _ destination: URL) throws {
        #if canImport(Darwin)
        if renamex_np(staging.path, destination.path, UInt32(RENAME_SWAP)) == 0 { return }
        #endif
        // Fallback: two renames with rollback.
        let fm = FileManager.default
        let old = destination.deletingLastPathComponent().appending(path: ".trash-\(UUID().uuidString)")
        try fm.moveItem(at: destination, to: old)
        do {
            try fm.moveItem(at: staging, to: destination)
        } catch {
            try? fm.moveItem(at: old, to: destination)
            throw error
        }
        try? fm.moveItem(at: old, to: staging)
    }

    /// Staging folders left by an import that was killed mid-way.
    static func removeLeftovers(in root: URL) {
        let fm = FileManager.default
        for name in (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
        where name.hasPrefix(".staging-") || name.hasPrefix(".trash-") {
            try? fm.removeItem(at: root.appending(path: name))
        }
    }

    static func formatBytes(_ n: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(n), countStyle: .file)
    }
}
