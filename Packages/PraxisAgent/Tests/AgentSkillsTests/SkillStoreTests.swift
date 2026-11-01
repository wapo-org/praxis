import Foundation
import Testing
@testable import AgentSkills

/// Bundled root with `alpha`, `beta` (+ files), a broken folder and a
/// duplicate name; imported root with `beta` (override) and `gamma`.
private func makeStore(_ scratch: Scratch) -> SkillStore {
    let bundled = scratch.dir("bundled")
    write([
        "alpha/SKILL.md": skillMarkdown(name: "alpha", description: "Alpha tasks."),
        "beta/SKILL.md": skillMarkdown(name: "beta", description: "Bundled beta.", body: "Bundled body"),
        "beta/reference/guide.md": "guide",
        "beta/scripts/run.py": "print()",
        "broken/SKILL.md": "no frontmatter here",
        "zz-dupe/SKILL.md": skillMarkdown(name: "alpha", description: "Second alpha."),
        "not-a-skill/readme.md": "no SKILL.md",
    ], to: bundled)
    let imported = scratch.dir("imported")
    write([
        "beta/SKILL.md": skillMarkdown(name: "beta", description: "Imported beta.", body: "Imported body"),
        "gamma/SKILL.md": skillMarkdown(name: "gamma", description: "Gamma tasks."),
        ".staging-leftover/SKILL.md": skillMarkdown(name: "ghost"),
    ], to: imported)
    return SkillStore(bundledDirectory: bundled, importedDirectory: imported)
}

@Suite struct SkillStoreTests {
    @Test func catalogMergesRootsAndImportedOverridesBundled() async throws {
        let scratch = Scratch()
        let store = makeStore(scratch)
        let skills = await store.skills()
        #expect(skills.map(\.name) == ["alpha", "beta", "gamma"])
        #expect(skills.map(\.origin) == [.bundled, .imported, .imported])
        #expect(skills.map(\.overridesBundled) == [false, true, false])
        #expect(skills[0].description == "Alpha tasks.")
        #expect(skills[1].description == "Imported beta.")
        #expect(try await store.instructions(for: "beta") == "Imported body")

        let problems = await store.problems()
        #expect(problems.map(\.folder).sorted() == ["broken", "not-a-skill", "zz-dupe"])
        #expect(problems.first { $0.folder == "zz-dupe" }?.message.contains("already provides") == true)
        #expect(problems.first { $0.folder == "broken" }?.message.contains("frontmatter") == true)
    }

    @Test func removingAnImportRevealsTheBundledSkill() async throws {
        let scratch = Scratch()
        let store = makeStore(scratch)
        try await store.remove(named: "beta")
        let beta = try #require(await store.skill(named: "beta"))
        #expect(beta.origin == .bundled)
        #expect(beta.files.map(\.path) == ["reference/guide.md"])
        #expect(beta.removedFiles == [DroppedFile(path: "scripts/run.py", reason: .scriptsDirectory)])
        #expect(try await store.instructions(for: "beta") == "Bundled body")

        await #expect(throws: SkillError.readOnly("“beta” is built into the app and can't be removed.")) {
            try await store.remove(named: "beta")
        }
        await #expect(throws: SkillError.self) { try await store.remove(named: "nope") }
        try await store.remove(named: "gamma")
        #expect(await store.skills().map(\.name) == ["alpha", "beta"])
    }

    @Test func bundledSkillsHideLinksAndBinaries() async throws {
        let scratch = Scratch()
        let bundled = scratch.dir("bundled")
        write(["docs/SKILL.md": skillMarkdown(name: "docs"), "docs/a.md": "a", "docs/tool.sh": "echo"], to: bundled)
        let secret = scratch.file("secret.txt", Data("outside".utf8))
        try FileManager.default.createSymbolicLink(atPath: bundled.appending(path: "docs/link.md").path, withDestinationPath: secret.path)
        try Data([0x00, 0x01, 0x02]).write(to: bundled.appending(path: "docs/blob.dat"))

        let store = SkillStore(bundledDirectory: bundled, importedDirectory: scratch.url.appending(path: "imported"))
        let docs = try #require(await store.skill(named: "docs"))
        #expect(docs.files.map(\.path) == ["a.md"])
        #expect(docs.removedFiles.map(\.path) == ["blob.dat", "tool.sh"])
        await #expect(throws: SkillError.self) { try await store.readText(skill: "docs", path: "link.md") }
    }

    @Test func contentHashDependsOnlyOnContent() async throws {
        let scratch = Scratch()
        let bundled = scratch.dir("bundled")
        let files = ["SKILL.md": skillMarkdown(name: "same"), "x/y.md": "content"]
        write(files.reduce(into: [:]) { $0["same/" + $1.key] = $1.value }, to: bundled)
        let imported = scratch.dir("imported")
        write(files.reduce(into: [:]) { $0["same/" + $1.key] = $1.value }, to: imported) // placed by hand: no record

        let store = SkillStore(bundledDirectory: bundled, importedDirectory: imported)
        let fromBundled = SkillHash.compute([("SKILL.md", Data(files["SKILL.md"]!.utf8)), ("x/y.md", Data("content".utf8))])
        #expect(await store.skill(named: "same")?.contentHash == fromBundled)

        write(["same/x/y.md": "changed"], to: imported)
        await store.reload()
        #expect(await store.skill(named: "same")?.contentHash != fromBundled)
    }

    @Test func missingRootsAreAnEmptyCatalog() async {
        let store = SkillStore(bundledDirectory: URL(fileURLWithPath: "/nonexistent-\(UUID())"),
                               importedDirectory: URL(fileURLWithPath: "/nonexistent-\(UUID())"))
        #expect(await store.skills().isEmpty)
        #expect(await store.problems().isEmpty)
    }
}
