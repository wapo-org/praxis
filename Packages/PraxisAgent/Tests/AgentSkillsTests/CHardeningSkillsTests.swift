import Foundation
import Testing
@testable import AgentCore
@testable import AgentSkills
import AgentTestSupport

/// Regression tests for R2-M4: registry downloads are bounded by actual
/// bytes, not advisory listed sizes; `.files` indexes are count-checked.
@Suite struct CHardeningRegistryDownloadTests {
    /// A GitHub whose tree LIES about sizes (1 byte each) but serves 1 MB
    /// per file: the pre-check passes, the cumulative budget must catch it.
    @Test func lyingSizesStillHitTheCumulativeCap() async throws {
        let commit = String(repeating: "c", count: 40)
        let big = String(repeating: "z", count: 1 << 20)
        let transport = ScriptedTransport { request, _ in
            let url = request.url!
            if url.host() == "api.github.com", url.path().hasSuffix("/commits/HEAD") {
                return ScriptedTransport.Reply(status: 200, body: Data(commit.utf8))
            }
            if url.host() == "api.github.com", url.path().contains("/git/trees/") {
                var items: [JSONValue] = [
                    ["path": .string("SKILL.md"), "type": "blob", "mode": "100644", "sha": "s0", "size": 100],
                ]
                for i in 0..<12 {
                    items.append(["path": .string("data-\(i).md"), "type": "blob", "mode": "100644",
                                  "sha": .string("s\(i)"), "size": 1])
                }
                return .json(JSONValue.object(["sha": "root", "tree": .array(items), "truncated": false]).encodedString())
            }
            if url.host() == "raw.githubusercontent.com" {
                if url.path().hasSuffix("/SKILL.md") {
                    return ScriptedTransport.Reply(status: 200, body: Data(skillMarkdown(name: "big").utf8))
                }
                return ScriptedTransport.Reply(status: 200, body: Data(big.utf8))
            }
            return ScriptedTransport.Reply(status: 404, body: Data())
        }
        let client = SkillRegistryClient(transport: transport)
        let registry = SkillRegistry(name: "Liar", source: .github(owner: "evil", repo: "big", path: nil, ref: nil))
        let listing = try await client.listing(for: registry)
        let skill = try #require(listing.skills.first)
        let scratch = Scratch()
        let store = SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"))
        do {
            _ = try await client.install(skill, from: registry, into: store)
            Issue.record("expected notInstallable, install succeeded")
        } catch let error as SkillRegistryError {
            #expect(error.description.contains("downloads"))
        }
        // The pre-check passed (bytes flowed: listing SKILL.md + install
        // downloads) and the cumulative budget fired instead.
        let fetched = transport.requests.filter { $0.url?.host() == "raw.githubusercontent.com" }.count
        #expect(fetched >= 13)
    }

    @Test func filesIndexOverTheCountCapIsRefusedBeforeDownloading() async throws {
        let transport = ScriptedTransport { _, _ in ScriptedTransport.Reply(status: 200, body: Data("x".utf8)) }
        let client = SkillRegistryClient(transport: transport)
        let registry = SkillRegistry(name: "x", source: .index(URL(string: "https://example.com/.well-known/agent-skills/index.json")!))
        var paths = ["SKILL.md"]
        paths += (0...SkillLimits().maxFiles).map { "file-\($0).md" }
        let skill = RegistrySkill(id: "many", registryID: registry.id, name: "many", description: "d",
                                  revision: nil, pageURL: nil,
                                  artifact: .files(base: URL(string: "https://example.com/skills/many/")!, paths: paths),
                                  problem: nil)
        let scratch = Scratch()
        let store = SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"))
        await #expect(throws: SkillRegistryError.self) { try await client.install(skill, from: registry, into: store) }
        #expect(transport.requests.isEmpty) // refused before any download
    }
}

/// Regression tests for R2-M5: giant GitHub listings are capped, warned
/// about, and cheap.
@Suite struct CHardeningRegistryListingTests {
    @Test func hugeRepoListsAtMostTheCapWithAWarning() async throws {
        var files: [String: String] = [:]
        for i in 0..<2500 {
            files["skills/skill-\(i)/SKILL.md"] = skillMarkdown(name: "skill-\(i)", description: "Does thing \(i).")
        }
        let hub = FakeGitHub(files: files)
        let client = SkillRegistryClient(transport: hub.transport)
        let registry = SkillRegistry(name: "Acme", source: .github(owner: "acme", repo: "skills", path: "skills", ref: nil))
        let listing = try await client.listing(for: registry)
        #expect(listing.skills.count == 2000)
        #expect(listing.warnings.contains { $0.contains("more than 2000") })
        #expect(hub.requests(host: "raw.githubusercontent.com").count <= 2000)
    }
}
