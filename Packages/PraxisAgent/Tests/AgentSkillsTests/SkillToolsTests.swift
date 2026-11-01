import Foundation
import Testing
@testable import AgentCore
@testable import AgentSkills
import AgentTestSupport

private let context = ToolContext(conversationID: "c1", mode: .ask)

private func call(_ tool: any AgentTool, _ args: JSONValue) async throws -> ToolOutput {
    try await tool.execute(ToolInvocation(id: "t1", name: tool.spec.name, arguments: args), context: context)
}

/// Bundled `pdf-tools` (body + reference + a 50K-char file) and a sibling
/// skill whose files must stay out of reach.
private func fixture(_ scratch: Scratch) async throws -> SkillStore {
    let bundled = scratch.dir("bundled")
    write([
        "pdf-tools/SKILL.md": skillMarkdown(name: "pdf-tools", description: "Works with PDFs. Use for PDF tasks.",
                                            body: "# PDF tools\n\nRun `scripts/extract.py` to extract text.\nSee reference/forms.md."),
        "pdf-tools/reference/forms.md": "# Forms\nFill them in.",
        "pdf-tools/big.txt": String(repeating: "0123456789", count: 5_000),
        "pdf-tools/scripts/extract.py": "print('x')",
        "other/SKILL.md": skillMarkdown(name: "other"),
        "other/secret.md": "other skill's file",
    ], to: bundled)
    let store = SkillStore(bundledDirectory: bundled, importedDirectory: scratch.url.appending(path: "imported"))
    let secret = scratch.file("outside.md", Data("top secret".utf8))
    try FileManager.default.createSymbolicLink(atPath: bundled.appending(path: "pdf-tools/escape.md").path, withDestinationPath: secret.path)
    return store
}

@Suite struct SkillToolsTests {
    @Test func specsTraitsAndPresentation() {
        let store = SkillStore(bundledDirectory: nil, importedDirectory: FileManager.default.temporaryDirectory)
        let tools = store.tools()
        #expect(tools.map(\.spec.name) == ["load_skill", "read_skill_file"])
        for tool in tools {
            #expect(tool.source == .skill)
            #expect(tool.traits == [.readOnly, .idempotent])
            // Skills run in every mode, including ask.
            #expect(ToolPolicy().decide(tool, mode: .ask) == .allow)
        }
        let load = tools[0].presentation(for: ["name": "pdf-tools"])
        #expect(load == ToolPresentation(category: .skill, runningTitle: "Loading pdf-tools skill…", finishedTitle: "Loaded pdf-tools skill"))
        #expect(tools[0].presentation(for: [:]).runningTitle == "Loading skill…")
        #expect(tools[1].presentation(for: ["skill": "x", "path": "a.md"]).category == .skill)
    }

    @Test func loadSkillReturnsBodyFilesAndScriptsNote() async throws {
        let scratch = Scratch()
        let store = try await fixture(scratch)
        let output = try await call(LoadSkillTool(store: store, codeToolName: "run_javascript"), ["name": "pdf-tools"])
        #expect(!output.isError)
        #expect(output.summary == "Loaded pdf-tools skill")
        let text = output.text
        #expect(text.hasPrefix("<skill name=\"pdf-tools\">\n# PDF tools"))
        #expect(text.contains("- big.txt (50 KB)"))
        #expect(text.contains("- reference/forms.md ("))
        #expect(!text.contains("escape.md"))
        #expect(text.contains("Scripts can't run on this device"))
        #expect(text.contains("run_javascript"))
        #expect(text.contains("removed and aren't available: scripts/extract.py"))

        let plain = try await call(LoadSkillTool(store: store), ["name": "other"])
        #expect(plain.text.contains("by hand or with the tools you have"))
        #expect(plain.text.contains("- secret.md ("))
        #expect(!plain.text.contains("run_javascript"))
    }

    @Test func unknownSkillListsValidNames() async throws {
        let scratch = Scratch()
        let store = try await fixture(scratch)
        let load = try await call(LoadSkillTool(store: store), ["name": "nope"])
        #expect(load.isError)
        #expect(load.text.contains("Available skills: other, pdf-tools."))
        #expect(try await call(LoadSkillTool(store: store), [:]).isError)

        let read = try await call(ReadSkillFileTool(store: store), ["skill": "nope", "path": "SKILL.md"])
        #expect(read.isError)
        #expect(read.text.contains("Available skills: other, pdf-tools."))

        let missing = try await call(ReadSkillFileTool(store: store), ["skill": "pdf-tools", "path": "nothing.md"])
        #expect(missing.isError)
        #expect(missing.text.contains("Files in pdf-tools: SKILL.md, big.txt, reference/forms.md."))
    }

    @Test func readSkillFilePagesThroughLongFiles() async throws {
        let scratch = Scratch()
        let tool = ReadSkillFileTool(store: try await fixture(scratch))

        let first = try await call(tool, ["skill": "pdf-tools", "path": "big.txt"])
        let firstLines = first.text.split(separator: "\n", maxSplits: 1)
        #expect(firstLines[0] == "[pdf-tools/big.txt · characters 0–20000 of 50000 · call read_skill_file with offset 20000 to continue]")
        #expect(firstLines[1].count == 20_000)

        let last = try await call(tool, ["skill": "pdf-tools", "path": "big.txt", "offset": 45_000, "limit": 10_000])
        #expect(last.text.hasPrefix("[pdf-tools/big.txt · characters 45000–50000 of 50000 · end of file]\n"))

        let capped = try await call(tool, ["skill": "pdf-tools", "path": "big.txt", "limit": 1_000_000])
        #expect(capped.text.split(separator: "\n", maxSplits: 1)[1].count == 40_000)

        let past = try await call(tool, ["skill": "pdf-tools", "path": "big.txt", "offset": 60_000])
        #expect(past.isError)

        let small = try await call(tool, ["skill": "pdf-tools", "path": "reference/forms.md"])
        #expect(small.text == "[pdf-tools/reference/forms.md · 21 characters]\n# Forms\nFill them in.")
        #expect(small.summary == "Read reference/forms.md")

        // Model-style variants of a valid path resolve to the same file.
        for path in ["./reference/forms.md", "pdf-tools/reference/forms.md", "reference//forms.md"] {
            #expect(try await call(tool, ["skill": "pdf-tools", "path": .string(path)]).text == small.text)
        }
        #expect(try await call(tool, ["skill": "pdf-tools", "path": "SKILL.md"]).text.contains("name: pdf-tools"))
    }

    @Test(arguments: ["../other/secret.md", "reference/../../other/secret.md", "/etc/passwd", "escape.md",
                      "scripts/extract.py", "~/secret.md", "..\\other\\secret.md"])
    func readSkillFileStaysInsideTheSkill(path: String) async throws {
        let scratch = Scratch()
        let output = try await call(ReadSkillFileTool(store: try await fixture(scratch)), ["skill": "pdf-tools", "path": .string(path)])
        #expect(output.isError, "\(path) → \(output.text)")
        #expect(!output.text.contains("top secret"))
        #expect(!output.text.contains("other skill's file"))
    }
}

@Suite struct SkillCatalogTests {
    private func skill(_ name: String, _ description: String) -> Skill {
        Skill(name: name, description: description, origin: .bundled, directory: URL(fileURLWithPath: "/tmp/\(name)"))
    }

    @Test func systemPromptSectionIsSortedAndDeterministic() {
        let skills = [skill("zeta", "Last one."), skill("alpha", "First\n  wraps   lines."), skill("mid", "Middle.")]
        let text = SkillCatalog.systemPromptSection(for: skills)
        #expect(text == SkillCatalog.systemPromptSection(for: skills.reversed()))
        #expect(text == SkillCatalog.systemPromptSection(for: skills + [skills[0]]))
        #expect(text.hasPrefix("# Skills\n\n"))
        #expect(text.contains("call load_skill with its name"))
        #expect(text.hasSuffix("""
        <available_skills>
        - alpha: First wraps lines.
        - mid: Middle.
        - zeta: Last one.
        </available_skills>
        """))
        #expect(SkillCatalog.systemPromptSection(for: []) == "")
    }

    @Test func additionNoteListsNewSkills() {
        #expect(SkillCatalog.additionNote(for: [skill("b", "B."), skill("a", "A.")])
                == "New skills are now available (load with load_skill when relevant):\n- a: A.\n- b: B.")
        #expect(SkillCatalog.additionNote(for: [skill("a", "A.")]).hasPrefix("A new skill is now available"))
        #expect(SkillCatalog.additionNote(for: []) == "")
    }
}

@Suite struct SkillLoopTests {
    @Test func agentLoopLoadsASkillInAskMode() async throws {
        let scratch = Scratch()
        let store = try await fixture(scratch)
        let system = SystemPrompt.build(.init(skillsCatalog: SkillCatalog.systemPromptSection(for: await store.skills())))
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("t1", "load_skill", #"{"name": "pdf-tools"}"#),
                                        ("t2", "read_skill_file", #"{"skill": "pdf-tools", "path": "reference/forms.md"}"#)]),
            ScriptedProvider.text("Done"),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry(store.tools(codeToolName: "run_javascript")))
        let events = await loop.run(transcript: [.user("Fill my PDF form")],
                                    configuration: AgentRunConfiguration(conversationID: "c1", model: "m", system: system, mode: .ask)).collect()

        guard case .finished(.completed) = events.last else { Issue.record("run didn't complete: \(String(describing: events.last))"); return }
        #expect(provider.requests[0].system.contains("- pdf-tools: Works with PDFs. Use for PDF tasks."))
        #expect(provider.requests[0].tools.map(\.name) == ["load_skill", "read_skill_file"])

        let results = provider.requests[1].messages.last!.toolResults
        #expect(results.map(\.isError) == [false, false])
        #expect(results[0].content.first?.text?.contains("# PDF tools") == true)
        #expect(results[1].content.first?.text?.contains("Fill them in.") == true)

        let ready = events.compactMap { if case .toolCallReady(let a) = $0 { return a.presentation.runningTitle }; return nil }
        #expect(ready == ["Loading pdf-tools skill…", "Reading reference/forms.md…"])
        let finished = events.compactMap { if case .toolFinished(_, let c) = $0 { return c.summary }; return nil }
        #expect(finished.sorted() == ["Loaded pdf-tools skill", "Read reference/forms.md"]) // tools run in parallel
        let traces = events.compactMap { if case .toolProgress(_, .trace(.skill, let t)) = $0 { return t }; return nil }
        #expect(traces.sorted() == ["Loaded pdf-tools", "Read pdf-tools/reference/forms.md"])
    }
}
