import Foundation
import Testing
import AgentCore
import AgentSkills
import AgentTestSupport
@testable import AgentRuntime

@Suite struct TurnNotesTests {
    private func notes(_ message: Message) -> [String] {
        message.parts.compactMap { if case .note(let n) = $0 { return n }; return nil }
    }

    @Test func modeNoteOnFirstTurnAndOnChange() async throws {
        let runtime = makeRuntime()
        let setup = await runtime.prepare().setup
        var transcript: [Message] = []

        let first = await runtime.userMessage(text: "hi", mode: .auto, effort: .high, previous: transcript, setup: setup)
        #expect(notes(first) == ["Current mode: auto. Effort: high."])
        #expect(first.parts.last == .text("hi"))
        transcript += [first, Message(role: .assistant, parts: [.text("hello")])]

        let same = await runtime.userMessage(text: "again", mode: .auto, effort: .high, previous: transcript, setup: setup)
        #expect(notes(same).isEmpty)
        transcript += [same, Message(role: .assistant, parts: [.text("ok")])]

        let effort = await runtime.userMessage(text: "harder", mode: .auto, effort: .max, previous: transcript, setup: setup)
        #expect(notes(effort) == ["Current mode: auto. Effort: max."])
        transcript += [effort, Message(role: .assistant, parts: [.text("ok")])]

        let mode = await runtime.userMessage(text: "plan it", mode: .plan, effort: .max, previous: transcript, setup: setup)
        #expect(notes(mode) == ["Current mode: plan. Effort: max."])

        // Retry cuts the tail: the cut announcement is made again.
        let retried = await runtime.userMessage(text: "plan it", mode: .plan, effort: .max, previous: transcript, setup: setup)
        #expect(retried == mode)
    }

    @Test func attachmentsAndNoteOrder() async throws {
        let setup = await makeRuntime().prepare().setup
        let image = MediaData(mediaType: "image/png", data: Data([1]))
        let pdf = MediaData(mediaType: "application/pdf", data: Data([2]), name: "a.pdf")
        let message = TurnNotes.userMessage(text: "look", images: [image], documents: [pdf], mode: .ask, effort: .low,
                                            previous: [], setup: setup, skills: [])
        #expect(message.role == .user)
        #expect(message.parts == [.note("Current mode: ask. Effort: low."), .image(image), .document(pdf), .text("look")])
    }

    @Test func skillsImportedAfterFreezeAreAnnouncedOnce() async throws {
        let skills = SkillFolder(["alpha": "Alpha things."])
        let runtime = makeRuntime(skills: skills.store)
        let setup = await runtime.prepare().setup
        var transcript: [Message] = [await runtime.userMessage(text: "hi", mode: .auto, effort: .high, previous: [], setup: setup)]
        #expect(notes(transcript[0]).count == 1) // frozen skills aren't announced

        skills.write("beta", "Beta things.")
        skills.write("gamma", "Gamma\nthings.")
        await skills.store.reload()
        let next = await runtime.userMessage(text: "more", mode: .auto, effort: .high, previous: transcript, setup: setup)
        let current = await skills.store.skills()
        #expect(notes(next) == [SkillCatalog.additionNote(for: current.filter { $0.name != "alpha" })])
        transcript += [next, Message(role: .assistant, parts: [.text("ok")])]

        let after = await runtime.userMessage(text: "again", mode: .auto, effort: .high, previous: transcript, setup: setup)
        #expect(notes(after).isEmpty)

        // Deleting and re-adding a frozen skill announces nothing.
        try await skills.store.remove(named: "alpha")
        skills.write("alpha", "Alpha things, v2.")
        await skills.store.reload()
        let readded = await runtime.userMessage(text: "x", mode: .auto, effort: .high, previous: transcript, setup: setup)
        #expect(notes(readded).isEmpty)
    }

    @Test func noSkillNotesWithoutSkillTools() async throws {
        let skills = SkillFolder()
        let runtime = makeRuntime(skills: skills.store)
        let setup = await runtime.prepare(includeSkills: false).setup
        #expect(!setup.includesSkills)
        #expect(!setup.toolSpecs.contains { $0.name == "load_skill" })
        skills.write("beta", "Beta things.")
        await skills.store.reload()
        let message = await runtime.userMessage(text: "hi", mode: .auto, effort: .high, previous: [], setup: setup)
        #expect(notes(message) == ["Current mode: auto. Effort: high."])
    }

    @Test func emptyCatalogStillOffersSkillToolsForLaterImports() async throws {
        let skills = SkillFolder()
        let runtime = makeRuntime(skills: skills.store)
        let setup = await runtime.prepare().setup
        #expect(setup.skillNames.isEmpty)
        #expect(setup.toolSpecs.contains { $0.name == "load_skill" })
        #expect(!setup.systemPrompt.contains("<available_skills>"))
    }
}
