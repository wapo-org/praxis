import Foundation
import AgentCore

/// The skills available on this device: a read-only bundled directory
/// (shipped in the app) plus a writable imported directory, one folder per
/// skill.
///
/// **Name clashes:** an imported skill overrides a bundled one with the
/// same name (`Skill.overridesBundled`). Bundled folders can't be edited,
/// so this is the only way for a user to update or customize one; removing
/// the import brings the bundled version back. Within one root, the first
/// folder (by folder name) wins and the others are reported as problems.
///
/// The catalog (names, descriptions, file lists) is scanned once and
/// cached; bodies and files are read from disk on demand, so a large
/// catalog costs little memory. Callers freeze `skills()` into the system
/// prompt at a conversation's first send — later imports are visible to
/// `load_skill` immediately and are announced with `SkillCatalog.additionNote`.
public actor SkillStore {
    public nonisolated let bundledDirectory: URL?
    public nonisolated let importedDirectory: URL
    public nonisolated let limits: SkillLimits

    private var catalog: [String: Skill]?
    private var loadProblems: [SkillLoadProblem] = []
    /// Bundled folders never change at runtime: hash each one once.
    private var bundledHashes: [String: (hash: String, binaries: [DroppedFile])] = [:]

    public init(bundledDirectory: URL?, importedDirectory: URL, limits: SkillLimits = SkillLimits()) {
        self.bundledDirectory = bundledDirectory
        self.importedDirectory = importedDirectory
        self.limits = limits
    }

    // MARK: Catalog

    /// Every loadable skill, sorted by name.
    public func skills() -> [Skill] {
        loadedCatalog().values.sorted { $0.name < $1.name }
    }

    public func skill(named name: String) -> Skill? {
        loadedCatalog()[name]
    }

    /// Folders that couldn't be loaded and why (from the last scan).
    public func problems() -> [SkillLoadProblem] {
        _ = loadedCatalog()
        return loadProblems
    }

    /// Rescans both roots (e.g. after files changed outside the store).
    public func reload() {
        catalog = nil
        _ = loadedCatalog()
    }

    private func loadedCatalog() -> [String: Skill] {
        if let catalog { return catalog }
        var problems: [SkillLoadProblem] = []
        let bundled = bundledDirectory.map { scan($0, origin: .bundled, problems: &problems) } ?? [:]
        let imported = scan(importedDirectory, origin: .imported, problems: &problems)
        var merged = bundled
        for (name, var skill) in imported {
            skill.overridesBundled = bundled[name] != nil
            merged[name] = skill
        }
        catalog = merged
        loadProblems = problems
        return merged
    }

    private func scan(_ root: URL, origin: SkillOrigin, problems: inout [SkillLoadProblem]) -> [String: Skill] {
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: root.path) else { return [:] }
        var result: [String: Skill] = [:]
        for folder in names.sorted() where !folder.hasPrefix(".") {
            let url = root.appending(path: folder, directoryHint: .isDirectory)
            guard let attrs = try? fm.attributesOfItem(atPath: url.path),
                  attrs[.type] as? FileAttributeType == .typeDirectory else { continue }
            do {
                let skill = try loadSkill(at: url, folder: folder, origin: origin)
                if let existing = result[skill.name] {
                    problems.append(SkillLoadProblem(folder: folder, origin: origin,
                                                     message: "Another folder (“\(existing.directory.lastPathComponent)”) already provides the skill “\(skill.name)”."))
                    continue
                }
                result[skill.name] = skill
            } catch {
                problems.append(SkillLoadProblem(folder: folder, origin: origin, message: (error as? SkillError)?.description ?? error.localizedDescription))
            }
        }
        return result
    }

    private func loadSkill(at directory: URL, folder: String, origin: SkillOrigin) throws -> Skill {
        let (document, warnings) = try SkillDocument.load(readSkillFile(in: directory), folderName: folder)
        let listing = SkillDirectory.list(directory)
        var files: [SkillFile] = []
        var removed: [DroppedFile] = []
        var hashed: [(path: String, data: Data)] = []
        for file in listing.files where file.path != "SKILL.md" {
            if let reason = SkillFileFilter.dropReason(path: file.path, executable: file.executable) {
                removed.append(DroppedFile(path: file.path, reason: reason))
            } else {
                files.append(SkillFile(path: file.path, size: file.size))
            }
        }

        let hash: String
        var source: SkillSource?
        if origin == .imported, let record = SkillInstallRecord.read(in: directory) {
            hash = record.contentHash
            removed += record.removedFiles
            source = record.origin ?? .file
        } else if let cached = bundledHashes[directory.path], origin == .bundled {
            hash = cached.hash
            files.removeAll { file in cached.binaries.contains { $0.path == file.path } }
            removed += cached.binaries
        } else {
            // No record (bundled, or placed by hand): read everything once to
            // hash it and to hide files that aren't text.
            var binaries: [DroppedFile] = []
            hashed.append(("SKILL.md", try Data(contentsOf: directory.appending(path: "SKILL.md"))))
            for file in files {
                guard let data = try? Data(contentsOf: directory.appending(path: file.path)) else { continue }
                if let reason = SkillFileFilter.dropReason(content: data) {
                    binaries.append(DroppedFile(path: file.path, reason: reason))
                } else {
                    hashed.append((file.path, data))
                }
            }
            hash = SkillHash.compute(hashed)
            files.removeAll { file in binaries.contains { $0.path == file.path } }
            removed += binaries
            if origin == .bundled { bundledHashes[directory.path] = (hash, binaries) }
        }

        return Skill(name: document.name!, description: document.description!, license: document.license,
                     compatibility: document.compatibility, metadata: document.metadata,
                     files: files.sorted { $0.path < $1.path },
                     removedFiles: removed.sorted { $0.path < $1.path }, origin: origin, contentHash: hash,
                     warnings: warnings, directory: directory, source: source)
    }

    private func readSkillFile(in directory: URL) throws -> String {
        let url = directory.appending(path: "SKILL.md")
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) else {
            throw SkillError.invalidSkill(["No SKILL.md in this folder."])
        }
        guard attrs[.type] as? FileAttributeType == .typeRegular else {
            throw SkillError.invalidSkill(["SKILL.md isn't a regular file."])
        }
        let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
        guard size <= limits.maxSkillFileBytes else {
            throw SkillError.tooLarge("SKILL.md is \(SkillImporter.formatBytes(size)); the limit is \(SkillImporter.formatBytes(limits.maxSkillFileBytes)).")
        }
        let data = try Data(contentsOf: url)
        guard SkillFileFilter.isText(data) else { throw SkillError.invalidSkill(["SKILL.md isn't UTF-8 text."]) }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: Content

    /// The `SKILL.md` body, re-read from disk so it always matches the
    /// installed version.
    public func instructions(for name: String) throws -> String {
        guard let skill = skill(named: name) else { throw SkillError.notFound("There's no skill named “\(name)”.") }
        return try SkillDocument(parsing: readSkillFile(in: skill.directory)).body
    }

    /// Whole text of one of a skill's files. Only files in the skill's
    /// listing (plus `SKILL.md`) are readable, the resolved path must stay
    /// inside the skill folder, and the file itself can't be a link.
    public func readText(skill name: String, path rawPath: String) throws -> String {
        try readFile(skill: name, path: rawPath).text
    }

    /// `readText` plus the canonical path the request resolved to.
    func readFile(skill name: String, path rawPath: String) throws -> (path: String, text: String) {
        guard let skill = skill(named: name) else { throw SkillError.notFound("There's no skill named “\(name)”.") }
        let path = try resolvePath(rawPath, in: skill)
        let base = skill.directory.resolvingSymlinksInPath().standardizedFileURL.path
        let url = skill.directory.appending(path: path)
        let resolved = url.resolvingSymlinksInPath().standardizedFileURL.path
        guard resolved.hasPrefix(base.hasSuffix("/") ? base : base + "/") else {
            throw SkillError.unsafeContent("“\(rawPath)” is outside the skill folder.")
        }
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              attrs[.type] as? FileAttributeType == .typeRegular else {
            throw SkillError.notFound("“\(path)” isn't a readable file in \(skill.name).")
        }
        let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
        guard size <= limits.maxTotalBytes else { throw SkillError.tooLarge("“\(path)” is too large to read.") }
        let data = try Data(contentsOf: url)
        guard SkillFileFilter.isText(data) else { throw SkillError.notFound("“\(path)” isn't a text file, so it can't be read.") }
        return (path, String(decoding: data, as: UTF8.self))
    }

    /// Maps a model-supplied path onto a listed file. Tolerates `./x` and a
    /// leading `<skill-name>/` (models often include it).
    private func resolvePath(_ raw: String, in skill: Skill) throws -> String {
        let path = try SkillPath.normalize(raw)
        let known = Set(skill.files.map(\.path) + ["SKILL.md"])
        if known.contains(path) { return path }
        if path.hasPrefix(skill.name + "/"), known.contains(String(path.dropFirst(skill.name.count + 1))) {
            return String(path.dropFirst(skill.name.count + 1))
        }
        throw SkillError.notFound("“\(raw)” isn't a file in \(skill.name).")
    }

    // MARK: Changes

    /// Imports a folder or `.zip` / `.skill` archive. Re-importing a name
    /// replaces the earlier import (new content hash); a bundled skill of
    /// the same name is overridden.
    @discardableResult
    public func importSkill(from source: URL) throws -> SkillImportReport {
        let importer = SkillImporter(limits: limits)
        let extracted = try importer.extract(from: source)
        let installed = try importer.install(extracted, into: importedDirectory)
        reload()
        guard let skill = catalog?[extracted.name] else {
            let reason = loadProblems.first { $0.folder == extracted.name }?.message ?? "unknown error"
            throw SkillError.fileSystem("The skill was saved but couldn't be loaded: \(reason)")
        }
        return SkillImportReport(skill: skill, dropped: extracted.dropped, warnings: extracted.warnings,
                                 replacedExisting: installed.replaced, previousContentHash: installed.previousHash)
    }

    /// Installs files fetched from a registry (or anywhere else in
    /// memory), with the same validation as an import. Replaces an
    /// installed skill of the same name, like a re-import.
    @discardableResult
    public func install(files: [(path: String, data: Data)], sourceName: String, source: SkillSource,
                        folderName: String? = nil, executable: Set<String> = []) throws -> SkillImportReport {
        try install(SkillImporter(limits: limits).extract(files: files, sourceName: sourceName, folderName: folderName,
                                                          executable: executable), source: source)
    }

    /// Validates without installing (registry previews of archives).
    public func inspect(archive: Data, sourceName: String) throws -> SkillInspection {
        let extracted = try SkillImporter(limits: limits).extract(archive: archive, name: sourceName)
        let skillMD = extracted.files.first { $0.path == "SKILL.md" }.map { String(decoding: $0.data, as: UTF8.self) } ?? ""
        return SkillInspection(name: extracted.name, skillMarkdown: skillMD,
                               files: extracted.files.filter { $0.path != "SKILL.md" }.map { SkillFile(path: $0.path, size: $0.data.count) },
                               dropped: extracted.dropped, warnings: extracted.warnings)
    }

    /// Installs a `.zip` or `.tar.gz` held in memory (registry downloads).
    @discardableResult
    public func install(archive: Data, sourceName: String, source: SkillSource) throws -> SkillImportReport {
        try install(SkillImporter(limits: limits).extract(archive: archive, name: sourceName), source: source)
    }

    private func install(_ extracted: ExtractedSkill, source: SkillSource) throws -> SkillImportReport {
        let installed = try SkillImporter(limits: limits).install(extracted, into: importedDirectory, origin: source)
        reload()
        guard let skill = catalog?[extracted.name] else {
            let reason = loadProblems.first { $0.folder == extracted.name }?.message ?? "unknown error"
            throw SkillError.fileSystem("The skill was saved but couldn't be loaded: \(reason)")
        }
        return SkillImportReport(skill: skill, dropped: extracted.dropped, warnings: extracted.warnings,
                                 replacedExisting: installed.replaced, previousContentHash: installed.previousHash)
    }

    // MARK: Agent-written skills

    /// Saves a skill written by the agent (or an edit of one in the app).
    ///
    /// The `SKILL.md` is composed from the draft and the whole skill goes
    /// through the importer, so it obeys every import rule: name format,
    /// description length and no XML, size and file caps, no scripts
    /// (script files are dropped and reported). Only agent-created skills
    /// can be replaced; replacing keeps existing reference files unless
    /// the draft overwrites or removes them.
    @discardableResult
    public func saveAgentSkill(_ draft: SkillDraft, replace: Bool, conversationID: String? = nil) throws -> SkillImportReport {
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let nameProblems = SkillDocument.nameProblems(name)
        guard nameProblems.isEmpty else { throw SkillError.invalidSkill(nameProblems) }

        var files: [String: Data] = [:]
        var creator = conversationID
        if let existing = skill(named: name) {
            guard replace else {
                throw SkillError.alreadyExists("A skill named “\(name)” already exists. Pick another name, or replace it (only skills the agent created can be replaced).")
            }
            try Self.checkAgentOwned(existing)
            creator = existing.source?.conversationID ?? conversationID
            for file in existing.files {
                if let data = try? Data(contentsOf: existing.directory.appending(path: file.path)) { files[file.path] = data }
            }
        }
        for raw in draft.removeFiles {
            let path = try SkillPath.normalize(raw)
            guard files.removeValue(forKey: path) != nil else {
                throw SkillError.notFound("“\(raw)” isn't a file in \(name), so it can't be removed.")
            }
        }
        for (raw, text) in draft.files {
            let path = try SkillPath.normalize(raw)
            guard !path.isEmpty else { throw SkillError.unsafeContent("A file path is empty.") }
            guard path.caseInsensitiveCompare("SKILL.md") != .orderedSame else {
                throw SkillError.invalidSkill(["Put the SKILL.md text in instructions, not in files."])
            }
            files[path] = Data(text.utf8)
        }
        files["SKILL.md"] = Data(SkillDocument.compose(name: name, description: draft.description,
                                                       body: draft.instructions).utf8)
        let extracted = try SkillImporter(limits: limits).extract(files: files.map { ($0.key, $0.value) },
                                                                  sourceName: "agent", folderName: name)
        return try install(extracted, source: .agent(conversationID: creator))
    }

    /// Deletes a skill the agent created; other skills are the user's.
    public func deleteAgentSkill(named name: String) throws {
        guard let skill = skill(named: name) else { throw SkillError.notFound("There's no skill named “\(name)”.") }
        try Self.checkAgentOwned(skill)
        try remove(named: name)
    }

    /// The editable parts of an installed skill (the app's editor).
    public func draft(for name: String) throws -> SkillDraft {
        guard let skill = skill(named: name) else { throw SkillError.notFound("There's no skill named “\(name)”.") }
        return SkillDraft(name: skill.name, description: skill.description, instructions: try instructions(for: name))
    }

    private static func checkAgentOwned(_ skill: Skill) throws {
        guard skill.origin == .imported else {
            throw SkillError.readOnly("“\(skill.name)” is built into the app and can't be changed.")
        }
        guard skill.isAgentCreated else {
            throw SkillError.readOnly("“\(skill.name)” was installed by the user, so it can't be changed or deleted here. Save your version under a different name.")
        }
    }

    /// Deletes an imported skill. Bundled skills are read-only.
    public func remove(named name: String) throws {
        guard let skill = skill(named: name) else { throw SkillError.notFound("There's no skill named “\(name)”.") }
        guard skill.origin == .imported else {
            throw SkillError.readOnly("“\(name)” is built into the app and can't be removed.")
        }
        let fm = FileManager.default
        // Rename first so a half-finished delete never looks like a skill.
        let trash = importedDirectory.appending(path: ".trash-\(UUID().uuidString)")
        do {
            try fm.moveItem(at: skill.directory, to: trash)
        } catch {
            throw SkillError.fileSystem("Couldn't remove “\(name)”: \(error.localizedDescription)")
        }
        try? fm.removeItem(at: trash)
        reload()
    }

    // MARK: Tools

    /// `load_skill` and `read_skill_file` bound to this store. Pass the name
    /// of a code tool (e.g. `run_javascript`) when one is registered, so
    /// the scripts note can point the model at it.
    public nonisolated func tools(codeToolName: String? = nil) -> [any AgentTool] {
        [LoadSkillTool(store: self, codeToolName: codeToolName), ReadSkillFileTool(store: self)]
    }

    /// `save_skill` and `delete_skill`: the agent writes its own skills.
    /// Side-effecting, so `ToolPolicy` refuses them in Ask and Plan.
    public nonisolated func authoringTools() -> [any AgentTool] {
        [SaveSkillTool(store: self), DeleteSkillTool(store: self)]
    }
}
