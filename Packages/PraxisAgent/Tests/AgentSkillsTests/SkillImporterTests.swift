import Foundation
import Testing
@testable import AgentSkills

/// Imports `data` as an archive into a fresh store; returns the store too.
private func importArchive(_ data: Data, scratch: Scratch, limits: SkillLimits = SkillLimits(),
                           named: String = "upload.zip") async throws -> (SkillImportReport, SkillStore) {
    let store = SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"), limits: limits)
    let report = try await store.importSkill(from: scratch.file(named, data))
    return (report, store)
}

private func importError(_ data: Data, limits: SkillLimits = SkillLimits()) async -> SkillError? {
    let scratch = Scratch()
    do {
        _ = try await importArchive(data, scratch: scratch, limits: limits)
        return nil
    } catch let error as SkillError {
        // Nothing may be left behind after a refused import.
        let imported = scratch.url.appending(path: "imported")
        let leftovers = (try? FileManager.default.contentsOfDirectory(atPath: imported.path)) ?? []
        #expect(leftovers.isEmpty, "left behind: \(leftovers)")
        return error
    } catch {
        Issue.record("unexpected error \(error)")
        return nil
    }
}

private let skillMD = skillMarkdown(name: "widget-skill")

@Suite struct ZipImportTests {
    @Test func importsStoredAndDeflatedEntries() async throws {
        let scratch = Scratch()
        let reference = String(repeating: "Reference text. ", count: 2_000)
        let zip = TestZip.make([
            ZipEntrySpec("SKILL.md", skillMD),
            ZipEntrySpec("reference/guide.md", reference, deflate: true),
            ZipEntrySpec("data/table.csv", "a,b\n1,2\n", deflate: true),
            ZipEntrySpec("empty.txt", ""),
        ])
        let (report, store) = try await importArchive(zip, scratch: scratch)
        #expect(report.skill.name == "widget-skill")
        #expect(report.skill.origin == .imported)
        #expect(report.dropped.isEmpty)
        #expect(!report.replacedExisting)
        #expect(report.skill.files.map(\.path) == ["data/table.csv", "empty.txt", "reference/guide.md"])
        #expect(report.skill.contentHash.count == 64)
        #expect(try await store.readText(skill: "widget-skill", path: "reference/guide.md") == reference)
        #expect(try await store.instructions(for: "widget-skill") == "# Widgets\n\nStep 1: do the thing.")
    }

    #if os(macOS)
    @Test func importsArchivesMadeByMacOSTools() async throws {
        let scratch = Scratch()
        let src = scratch.dir("src")
        write(["zip-skill/SKILL.md": skillMarkdown(name: "zip-skill"),
               "zip-skill/reference/notes.md": String(repeating: "notes ", count: 500)], to: src)

        // zip(1): deflate, Unix attributes, single top-level folder.
        #expect(try runTool("/usr/bin/zip", ["-r", "-q", "../made.zip", "zip-skill"], in: src) == 0)
        let store = SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"))
        let report = try await store.importSkill(from: scratch.url.appending(path: "made.zip"))
        #expect(report.skill.name == "zip-skill")
        #expect(report.skill.files.map(\.path) == ["reference/notes.md"])

        // ditto (Finder's "Compress"): data descriptors and __MACOSX resource forks.
        #expect(try runTool("/usr/bin/xattr", ["-w", "com.example.test", "x", "zip-skill/SKILL.md"], in: src) == 0)
        #expect(try runTool("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", "zip-skill", "../ditto.zip"], in: src) == 0)
        let again = try await store.importSkill(from: scratch.url.appending(path: "ditto.zip"))
        #expect(again.replacedExisting)
        #expect(again.skill.files.map(\.path) == ["reference/notes.md"])
        #expect(again.previousContentHash == report.skill.contentHash)
        #expect(again.skill.contentHash == report.skill.contentHash)
    }

    @Test func rejectsSymlinkStoredByZipTool() async throws {
        let scratch = Scratch()
        let src = scratch.dir("src")
        write(["s/SKILL.md": skillMarkdown(name: "s")], to: src)
        try FileManager.default.createSymbolicLink(atPath: src.appending(path: "s/passwd").path, withDestinationPath: "/etc/passwd")
        #expect(try runTool("/usr/bin/zip", ["-r", "-q", "-y", "../link.zip", "s"], in: src) == 0)
        let error = await importError(try Data(contentsOf: scratch.url.appending(path: "link.zip")))
        guard case .unsafeContent(let m)? = error else { Issue.record("expected unsafeContent, got \(String(describing: error))"); return }
        #expect(m.contains("symbolic link"))
    }
    #endif

    @Test(arguments: ["../evil.md", "skill/../../evil.md", "/etc/passwd", "C:/Windows/evil.md", "..\\evil.md", "a/\u{1}b.md"])
    func rejectsUnsafePaths(name: String) async {
        let error = await importError(TestZip.make([ZipEntrySpec("SKILL.md", skillMD), ZipEntrySpec(name, "x")]))
        guard case .unsafeContent? = error else { Issue.record("expected unsafeContent, got \(String(describing: error))"); return }
    }

    @Test func rejectsSymlinksAndSpecialFiles() async {
        let link = await importError(TestZip.make([ZipEntrySpec("SKILL.md", skillMD), ZipEntrySpec("ref.md", "/etc/passwd", unixMode: 0o120777)]))
        guard case .unsafeContent(let m)? = link else { Issue.record("got \(String(describing: link))"); return }
        #expect(m.contains("symbolic link"))
        let fifo = await importError(TestZip.make([ZipEntrySpec("SKILL.md", skillMD), ZipEntrySpec("pipe", "", unixMode: 0o010644)]))
        guard case .unsafeContent? = fifo else { Issue.record("got \(String(describing: fifo))"); return }
    }

    @Test func rejectsDuplicateAndCollidingPaths() async {
        for entries in [
            [ZipEntrySpec("SKILL.md", skillMD), ZipEntrySpec("a.md", "1"), ZipEntrySpec("a.md", "2")],
            [ZipEntrySpec("SKILL.md", skillMD), ZipEntrySpec("Notes.md", "1"), ZipEntrySpec("notes.md", "2")],
            [ZipEntrySpec("SKILL.md", skillMD), ZipEntrySpec("caf\u{E9}.md", "1"), ZipEntrySpec("cafe\u{301}.md", "2")],
            [ZipEntrySpec("SKILL.md", skillMD), ZipEntrySpec("ref", "file"), ZipEntrySpec("ref/inner.md", "2")],
        ] {
            let error = await importError(TestZip.make(entries))
            guard case .unsafeContent? = error else { Issue.record("expected unsafeContent for \(entries.map(\.name)), got \(String(describing: error))"); continue }
        }
    }

    @Test func rejectsEncryptedZip64AndMultiDisk() async {
        var encrypted = ZipEntrySpec("SKILL.md", skillMD)
        encrypted.flags = 1
        var lzma = ZipEntrySpec("SKILL.md", skillMD)
        lzma.method = 14
        let cases: [(Data, String)] = [
            (TestZip.make([encrypted]), "encrypted"),
            (TestZip.make([ZipEntrySpec("SKILL.md", skillMD)], zip64Locator: true), "ZIP64"),
            (TestZip.make([ZipEntrySpec("SKILL.md", skillMD)], totalEntries: 0xFFFF), "ZIP64"),
            (TestZip.make([ZipEntrySpec("SKILL.md", skillMD)], diskNumber: 1), "multi-part"),
            (TestZip.make([lzma]), "compression method 14"),
            (Data("PK\u{3}\u{4} starts like a zip but has no directory".utf8), "isn't a ZIP archive"),
            (Data("PK\u{3}\u{4}tiny".utf8), "too small"),
            (Data("plain text".utf8), "isn't a ZIP archive"),
        ]
        for (data, expected) in cases {
            let error = await importError(data)
            guard case .unreadableArchive(let m)? = error else { Issue.record("expected unreadableArchive(\(expected)), got \(String(describing: error))"); continue }
            #expect(m.contains(expected), "\(m)")
        }
    }

    @Test func rejectsZipBombsAndLyingHeaders() async {
        // 5 MB of zeros deflates to a few KB: over the ratio guard.
        let bomb = await importError(TestZip.make([ZipEntrySpec("SKILL.md", skillMD),
                                                   ZipEntrySpec("zeros.txt", data: Data(count: 5 << 20), deflate: true)]))
        guard case .unsafeContent(let m)? = bomb else { Issue.record("got \(String(describing: bomb))"); return }
        #expect(m.contains("zip bomb"))

        // Header claims 10 bytes; the stream inflates to far more.
        var liar = ZipEntrySpec("big.txt", data: Data(repeating: 65, count: 100_000), deflate: true)
        liar.declaredSize = 10
        let lie = await importError(TestZip.make([ZipEntrySpec("SKILL.md", skillMD), liar]))
        guard case .unsafeContent(let lm)? = lie else { Issue.record("got \(String(describing: lie))"); return }
        #expect(lm.contains("declared size"))

        var corrupt = ZipEntrySpec("ref.md", "hello", deflate: true)
        corrupt.crc = 0xDEAD_BEEF
        let crc = await importError(TestZip.make([ZipEntrySpec("SKILL.md", skillMD), corrupt]))
        guard case .unreadableArchive(let cm)? = crc else { Issue.record("got \(String(describing: crc))"); return }
        #expect(cm.contains("CRC"))
    }

    @Test func rejectsOverlappingEntries() async throws {
        // Point the third central-directory entry at the second entry's
        // local data: two names sharing one blob ("overlapped" zip bomb).
        let zip = TestZip.make([ZipEntrySpec("SKILL.md", skillMD), ZipEntrySpec("a.md", "same"), ZipEntrySpec("b.md", "same")])
        let target = UInt32(try ZipArchive(data: zip).entries[1].localHeaderOffset)
        var bytes = [UInt8](zip)
        let headers = (0..<(bytes.count - 4)).filter { bytes[$0] == 0x50 && bytes[$0 + 1] == 0x4b && bytes[$0 + 2] == 1 && bytes[$0 + 3] == 2 }
        for k in 0..<4 { bytes[headers[2] + 42 + k] = UInt8((target >> (8 * UInt32(k))) & 0xFF) }
        let error = await importError(Data(bytes))
        guard case .unsafeContent(let m)? = error else { Issue.record("got \(String(describing: error))"); return }
        #expect(m.contains("overlaps"))
    }

    @Test func enforcesCaps() async {
        let small = SkillLimits(maxTotalBytes: 1_000, maxFiles: 3, maxSkillFileBytes: 200)
        let tooMany = await importError(TestZip.make([ZipEntrySpec("SKILL.md", skillMD)] + (1...3).map { ZipEntrySpec("f\($0).md", "x") }),
                                        limits: SkillLimits(maxFiles: 3))
        guard case .tooLarge(let m1)? = tooMany else { Issue.record("got \(String(describing: tooMany))"); return }
        #expect(m1.contains("4 files"))

        let tooBig = await importError(TestZip.make([ZipEntrySpec("SKILL.md", skillMD), ZipEntrySpec("big.md", String(repeating: "x", count: 2_000))]),
                                       limits: small)
        guard case .tooLarge? = tooBig else { Issue.record("got \(String(describing: tooBig))"); return }

        let bigSkillFile = await importError(TestZip.make([ZipEntrySpec("SKILL.md", skillMarkdown(name: "x", body: String(repeating: "y", count: 70_000)))]))
        guard case .tooLarge(let m3)? = bigSkillFile else { Issue.record("got \(String(describing: bigSkillFile))"); return }
        #expect(m3.contains("SKILL.md"))
    }

    @Test func dropsScriptsExecutablesAndBinaries() async throws {
        let scratch = Scratch()
        var png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])
        png.append(Data(count: 64))
        let zip = TestZip.make([
            ZipEntrySpec("SKILL.md", skillMD, unixMode: 0o100755), // exec bit on a document is ignored
            ZipEntrySpec("scripts/fill_form.py", "print('hi')"),
            ZipEntrySpec("scripts/README.md", "docs inside scripts/ go too"),
            ZipEntrySpec("helper.sh", "echo hi"),
            ZipEntrySpec("lib/tool.js", "console.log(1)"),
            ZipEntrySpec("bin/run", "binary-ish", unixMode: 0o100755),
            ZipEntrySpec("notes.txt", "#!/bin/sh\necho sneaky"),
            ZipEntrySpec("assets/logo.png", data: png),
            ZipEntrySpec("reference/forms.md", "# Forms", unixMode: 0o100755),
            ZipEntrySpec("LICENSE", "MIT License"),
            ZipEntrySpec("data.json", "{}", deflate: true),
            ZipEntrySpec(".hidden/secret.md", "ignored"),
            ZipEntrySpec("__MACOSX/._SKILL.md", "resource fork"),
            ZipEntrySpec(".DS_Store", "junk"),
        ])
        let (report, _) = try await importArchive(zip, scratch: scratch)
        let dropped = Dictionary(uniqueKeysWithValues: report.dropped.map { ($0.path, $0.reason) })
        #expect(dropped == [
            "scripts/fill_form.py": .scriptsDirectory,
            "scripts/README.md": .scriptsDirectory,
            "helper.sh": .executableType,
            "lib/tool.js": .executableType,
            "bin/run": .executablePermission,
            "notes.txt": .executableType,
            "assets/logo.png": .binary,
        ])
        #expect(report.skill.files.map(\.path) == ["LICENSE", "data.json", "reference/forms.md"])
        #expect(report.skill.removedFiles == report.dropped)
        // Only kept files reach the disk (plus the hidden install record).
        #expect(listFiles(report.skill.directory) == ["LICENSE", "SKILL.md", "data.json", "reference/forms.md"])
        let mode = try FileManager.default.attributesOfItem(atPath: report.skill.directory.appending(path: "SKILL.md").path)[.posixPermissions] as? Int
        #expect(mode.map { $0 & 0o111 } == 0)
    }

    @Test func findsSkillInSingleTopLevelFolder() async throws {
        let scratch = Scratch()
        let (report, _) = try await importArchive(TestZip.make([
            ZipEntrySpec("my-folder/", ""),
            ZipEntrySpec("my-folder/SKILL.md", skillMD),
            ZipEntrySpec("my-folder/ref/a.md", "a"),
            ZipEntrySpec("__MACOSX/my-folder/._SKILL.md", "fork"),
        ]), scratch: scratch)
        #expect(report.skill.files.map(\.path) == ["ref/a.md"])
        // Installed under the skill's name, not the archive's folder name.
        #expect(report.skill.directory.lastPathComponent == "widget-skill")
        #expect(report.warnings.contains { $0.contains("my-folder") })
    }

    @Test func rejectsAmbiguousOrMissingSkillFile() async {
        let two = await importError(TestZip.make([ZipEntrySpec("a/SKILL.md", skillMD), ZipEntrySpec("b/SKILL.md", skillMD)]))
        guard case .invalidSkill(let m1)? = two else { Issue.record("got \(String(describing: two))"); return }
        #expect(m1.first?.contains("single top-level folder") == true)

        let none = await importError(TestZip.make([ZipEntrySpec("README.md", "hi")]))
        guard case .invalidSkill(let m2)? = none else { Issue.record("got \(String(describing: none))"); return }
        #expect(m2.first?.contains("No SKILL.md") == true)

        let invalid = await importError(TestZip.make([ZipEntrySpec("SKILL.md", "---\nname: Bad Name\n---\nbody")]))
        guard case .invalidSkill(let m3)? = invalid else { Issue.record("got \(String(describing: invalid))"); return }
        #expect(m3.count == 2) // bad name + missing description, reported together
    }

    @Test func reimportReplacesByNameWithNewHash() async throws {
        let scratch = Scratch()
        let store = SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"))
        let v1 = try await store.importSkill(from: scratch.file("v1.skill", TestZip.make([
            ZipEntrySpec("SKILL.md", skillMarkdown(name: "evolving", body: "Version one")), ZipEntrySpec("old.md", "old"),
        ])))
        let v2 = try await store.importSkill(from: scratch.file("v2.zip", TestZip.make([
            ZipEntrySpec("SKILL.md", skillMarkdown(name: "evolving", body: "Version two")),
        ])))
        #expect(v2.replacedExisting)
        #expect(v2.previousContentHash == v1.skill.contentHash)
        #expect(v2.skill.contentHash != v1.skill.contentHash)
        #expect(v2.skill.files.isEmpty)
        #expect(try await store.instructions(for: "evolving") == "Version two")
        #expect(await store.skills().map(\.name) == ["evolving"])
        let root = try FileManager.default.contentsOfDirectory(atPath: scratch.url.appending(path: "imported").path)
        #expect(root == ["evolving"], "staging folders must not be left behind")
    }

    @Test func importsFolders() async throws {
        let scratch = Scratch()
        let folder = scratch.dir("folder-skill")
        write(["SKILL.md": skillMarkdown(name: "folder-skill"), "scripts/run.py": "print()", "guide.md": "guide",
               ".git/config": "ignored"], to: folder)
        let store = SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"))
        let report = try await store.importSkill(from: folder)
        #expect(report.skill.files.map(\.path) == ["guide.md"])
        #expect(report.dropped == [DroppedFile(path: "scripts/run.py", reason: .scriptsDirectory)])
        #expect(report.warnings.isEmpty)

        try FileManager.default.createSymbolicLink(atPath: folder.appending(path: "link.md").path, withDestinationPath: "/etc/hosts")
        await #expect(throws: SkillError.self) { try await store.importSkill(from: folder) }
    }
}
