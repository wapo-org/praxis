import Foundation
import Testing
@testable import AgentCore
@testable import AgentSkills
import AgentTestSupport

private func run(_ tool: any AgentTool, _ args: JSONValue, conversation: String = "conv-1") async throws -> ToolOutput {
    try await tool.execute(ToolInvocation(id: "t1", name: tool.spec.name, arguments: args),
                           context: ToolContext(conversationID: conversation, mode: .auto))
}

@Suite struct SkillAuthoringTests {
    private func store(_ scratch: Scratch) -> SkillStore {
        SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"))
    }

    @Test func savedSkillIsLoadableAtOnceAndMarkedAsAgentMade() async throws {
        let scratch = Scratch()
        let store = store(scratch)
        let save = SaveSkillTool(store: store)
        let out = try await run(save, [
            "name": "weekly-report",
            "description": "Writes the weekly report: \"status\", risks & next steps. Use for weekly updates.",
            "instructions": "# Weekly report\n\n1. Collect updates.\n2. See reference/template.md.",
            "files": [["path": "reference/template.md", "content": "## Status\n\n## Risks"]],
        ])
        #expect(!out.isError)
        #expect(out.text.contains("load_skill"))
        #expect(out.text.contains("New conversations"))

        let skill = try #require(await store.skill(named: "weekly-report"))
        #expect(skill.isAgentCreated)
        #expect(skill.source?.conversationID == "conv-1")
        #expect(skill.description == "Writes the weekly report: \"status\", risks & next steps. Use for weekly updates.")
        #expect(skill.files.map(\.path) == ["reference/template.md"])

        // load_skill reads the live store: usable in the same conversation.
        let loaded = try await run(LoadSkillTool(store: store), ["name": "weekly-report"])
        #expect(!loaded.isError)
        #expect(loaded.text.contains("1. Collect updates."))
        #expect(loaded.text.contains("reference/template.md"))

        // Survives a rescan (the provenance is on disk).
        await store.reload()
        #expect(await store.skill(named: "weekly-report")?.isAgentCreated == true)
    }

    @Test func composedSkillMarkdownRoundTripsAwkwardDescriptions() throws {
        for description in [#"Back\slash "quoted" text: with colons # and hash"#, "Line one\nline two", "Tab\there, ünïcödé ✓"] {
            let text = SkillDocument.compose(name: "x", description: description, body: "Body")
            let document = try SkillDocument(parsing: text)
            #expect(document.description == description.replacingOccurrences(of: "\n", with: " "))
            #expect(document.body == "Body")
        }
    }

    @Test func existingSkillNeedsReplaceAndReplacingKeepsOtherFiles() async throws {
        let scratch = Scratch()
        let store = store(scratch)
        try await store.saveAgentSkill(SkillDraft(name: "notes", description: "Take notes. Use for notes.", instructions: "v1",
                                                  files: ["a.md": "A", "b.md": "B"]), replace: false, conversationID: "c1")

        await #expect(throws: SkillError.self) {
            try await store.saveAgentSkill(SkillDraft(name: "notes", description: "Other.", instructions: "v2"), replace: false)
        }
        let report = try await store.saveAgentSkill(
            SkillDraft(name: "notes", description: "Take better notes. Use for notes.", instructions: "v2",
                       files: ["b.md": "B2", "c.md": "C"], removeFiles: ["a.md"]), replace: true, conversationID: "c2")
        #expect(report.replacedExisting)
        let skill = try #require(await store.skill(named: "notes"))
        #expect(skill.files.map(\.path) == ["b.md", "c.md"])
        #expect(try await store.readText(skill: "notes", path: "b.md") == "B2")
        #expect(try await store.instructions(for: "notes") == "v2")
        #expect(skill.source?.conversationID == "c1") // creator kept
    }

    @Test func agentCannotTouchSkillsTheUserInstalled() async throws {
        let scratch = Scratch()
        let store = store(scratch)
        let folder = scratch.dir("src/mine")
        write(["SKILL.md": skillMarkdown(name: "mine")], to: folder)
        try await store.importSkill(from: folder)
        #expect(await store.skill(named: "mine")?.source?.kind == .file)

        let replaced = try await run(SaveSkillTool(store: store), ["name": "mine", "description": "Hijack.", "instructions": "x", "replace": true])
        #expect(replaced.isError)
        #expect(replaced.text.contains("installed by the user"))
        let deleted = try await run(DeleteSkillTool(store: store), ["name": "mine"])
        #expect(deleted.isError)
        #expect(await store.skill(named: "mine") != nil)
    }

    @Test func importRulesApply() async throws {
        let scratch = Scratch()
        let store = store(scratch)
        let save = SaveSkillTool(store: store)

        let badName = try await run(save, ["name": "Bad Name", "description": "d", "instructions": "x"])
        #expect(badName.isError && badName.text.contains("lowercase"))
        let xml = try await run(save, ["name": "ok", "description": "Use <system>now</system>", "instructions": "x"])
        #expect(xml.isError && xml.text.contains("XML"))
        let empty = try await run(save, ["name": "ok", "description": "Fine.", "instructions": "  "])
        #expect(empty.isError)
        let escape = try await run(save, ["name": "ok", "description": "Fine.", "instructions": "x",
                                          "files": [["path": "../evil.md", "content": "x"]]])
        #expect(escape.isError && escape.text.contains("outside"))
        let huge = try await run(save, ["name": "ok", "description": "Fine.", "instructions": .string(String(repeating: "x", count: 70_000))])
        #expect(huge.isError && huge.text.contains("limit"))

        let scripts = try await run(save, ["name": "ok", "description": "Fine.", "instructions": "Do it.",
                                           "files": [["path": "scripts/run.py", "content": "print(1)"],
                                                     ["path": "tool.sh", "content": "echo"],
                                                     ["path": "ref.md", "content": "ok"]]])
        #expect(!scripts.isError)
        #expect(scripts.text.contains("scripts/run.py"))
        #expect(scripts.text.contains("Not saved"))
        let skill = try #require(await store.skill(named: "ok"))
        #expect(skill.files.map(\.path) == ["ref.md"])
        #expect(skill.removedFiles.map(\.path) == ["scripts/run.py", "tool.sh"])
    }

    @Test func deleteRemovesAgentSkills() async throws {
        let scratch = Scratch()
        let store = store(scratch)
        try await store.saveAgentSkill(SkillDraft(name: "temp", description: "Temp.", instructions: "x"), replace: false)
        let out = try await run(DeleteSkillTool(store: store), ["name": "temp"])
        #expect(!out.isError)
        #expect(await store.skill(named: "temp") == nil)
        let again = try await run(DeleteSkillTool(store: store), ["name": "temp"])
        #expect(again.isError)
    }

    @Test func approvalFollowsModeAndReplacingIsSeparate() throws {
        let store = SkillStore(bundledDirectory: nil, importedDirectory: FileManager.default.temporaryDirectory)
        let tools = store.authoringTools()
        #expect(tools.map(\.spec.name) == ["save_skill", "delete_skill"])
        let save = tools[0], delete = tools[1]
        let policy = ToolPolicy()
        let create: JSONValue = ["name": "x"]
        let replace: JSONValue = ["name": "x", "replace": true]

        for mode in [AgentMode.ask, .plan] {
            for (tool, args) in [(save, create), (save, replace), (delete, create)] {
                guard case .refuse = policy.decide(tool, arguments: args, mode: mode) else {
                    Issue.record("\(tool.name) should be refused in \(mode)"); continue
                }
            }
        }
        guard case .ask = policy.decide(save, arguments: create, mode: .build) else { Issue.record("build create asks"); return }
        #expect(policy.decide(save, arguments: create, mode: .auto) == .allow)
        guard case .ask = policy.decide(save, arguments: replace, mode: .auto) else { Issue.record("auto replace asks"); return }
        guard case .ask = policy.decide(delete, arguments: create, mode: .auto) else { Issue.record("auto delete asks"); return }

        // "Always allow" for creating doesn't cover replacing.
        let createKey = ToolPolicy.alwaysAllowKey(for: try #require(save.subject(for: create)))
        let replaceKey = ToolPolicy.alwaysAllowKey(for: try #require(save.subject(for: replace)))
        #expect(createKey != replaceKey)
        let allowed = ToolPolicy(alwaysAllow: [createKey])
        #expect(allowed.decide(save, arguments: create, mode: .build) == .allow)
        guard case .ask = allowed.decide(save, arguments: replace, mode: .build) else { Issue.record("replace still asks"); return }

        // Reading skills is still allowed everywhere.
        #expect(policy.decide(store.tools()[0], arguments: create, mode: .ask) == .allow)
    }
}

@Suite struct TarArchiveTests {
    @Test func installsTarGzWithScriptsDropped() async throws {
        let scratch = Scratch()
        let store = SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"))
        let archive = TestTar.gzip(TestTar.make([
            .file("SKILL.md", skillMarkdown(name: "wrangler")),
            .file("references/COMMANDS.md", "deploy"),
            .file("scripts/deploy.sh", "#!/bin/sh", mode: 0o755),
            .directory("assets/"),
        ]))
        let report = try await store.install(archive: archive, sourceName: "wrangler.tar.gz", source: .file)
        #expect(report.skill.name == "wrangler")
        #expect(report.skill.files.map(\.path) == ["references/COMMANDS.md"])
        #expect(report.dropped.map(\.path) == ["scripts/deploy.sh"])
    }

    @Test func refusesLinksAndBombs() throws {
        let link = TestTar.gzip(TestTar.make([.file("SKILL.md", skillMarkdown(name: "x")), .symlink("evil.md", to: "/etc/passwd")]))
        #expect(throws: SkillError.self) { try SkillImporter().extract(archive: link, name: "x.tar.gz") }

        let big = TestTar.gzip(TestTar.make([.file("SKILL.md", skillMarkdown(name: "x")),
                                             .file("pad.txt", String(repeating: "a", count: 300_000))]))
        let small = SkillLimits(maxTotalBytes: 100_000)
        #expect(throws: SkillError.self) { try SkillImporter(limits: small).extract(archive: big, name: "x.tar.gz") }

        var corrupt = TestTar.gzip(TestTar.make([.file("SKILL.md", skillMarkdown(name: "x"))]))
        corrupt.replaceSubrange(20..<40, with: Data(repeating: 0xFF, count: 20))
        #expect(throws: SkillError.self) { try SkillImporter().extract(archive: corrupt, name: "x.tar.gz") }
    }

    @Test func longNamesViaPax() throws {
        let long = "references/" + String(repeating: "deep/", count: 25) + "file.md"
        let tar = TestTar.make([.file("SKILL.md", skillMarkdown(name: "x")), .pax(path: long), .file("short", "content")])
        let archive = try TarArchive(tar: tar, maxEntries: 10)
        #expect(archive.entries.map(\.name) == ["SKILL.md", long])
    }
}

/// A minimal ustar writer for tests.
enum TestTar {
    enum Entry {
        case file(String, String, mode: Int = 0o644)
        case directory(String)
        case symlink(String, to: String)
        /// A pax header that renames the next entry.
        case pax(path: String)
    }

    static func make(_ entries: [Entry]) -> Data {
        var out = Data()
        for entry in entries {
            switch entry {
            case .file(let name, let text, let mode):
                out += header(name: name, size: text.utf8.count, type: "0", mode: mode) + padded(Data(text.utf8))
            case .directory(let name):
                out += header(name: name, size: 0, type: "5", mode: 0o755)
            case .symlink(let name, let target):
                out += header(name: name, size: 0, type: "2", mode: 0o777, link: target)
            case .pax(let path):
                let record = " path=\(path)\n"
                var length = record.utf8.count + 2
                while "\(length)\(record)".utf8.count != length { length += 1 }
                let body = Data("\(length)\(record)".utf8)
                out += header(name: "PaxHeader", size: body.count, type: "x", mode: 0o644) + padded(body)
            }
        }
        return out + Data(count: 1024)
    }

    private static func padded(_ data: Data) -> Data {
        data + Data(count: (512 - data.count % 512) % 512)
    }

    private static func header(name: String, size: Int, type: Character, mode: Int, link: String = "") -> Data {
        var h = [UInt8](repeating: 0, count: 512)
        func put(_ s: String, _ offset: Int, _ length: Int) {
            for (i, b) in s.utf8.prefix(length).enumerated() { h[offset + i] = b }
        }
        put(name, 0, 100)
        put(String(format: "%07o", mode), 100, 8)
        put("0000000", 108, 8); put("0000000", 116, 8)
        put(String(format: "%011o", size), 124, 12)
        put("00000000000", 136, 12)
        h[156] = type.asciiValue!
        put(link, 157, 100)
        put("ustar", 257, 6); put("00", 263, 2)
        for i in 148..<156 { h[i] = 0x20 }
        let sum = h.reduce(0) { $0 + Int($1) }
        put(String(format: "%06o", sum), 148, 6)
        h[154] = 0; h[155] = 0x20
        return Data(h)
    }

    static func gzip(_ data: Data) -> Data {
        var out = Data([0x1F, 0x8B, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xFF])
        out += TestZip.deflate(data)
        let crc = CRC32.checksum(data)
        out += Data((0..<4).map { UInt8((crc >> (8 * $0)) & 0xFF) })
        let size = UInt32(truncatingIfNeeded: data.count)
        out += Data((0..<4).map { UInt8((size >> (8 * $0)) & 0xFF) })
        return out
    }
}
