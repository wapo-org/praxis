import Foundation
import Testing
import CryptoKit
import Synchronization
@testable import AgentCore
@testable import AgentSkills
import AgentTestSupport

private let commitA = String(repeating: "a", count: 40)
private let commitB = String(repeating: "b", count: 40)

/// A fake GitHub: `commits/HEAD`, one recursive tree, raw files.
final class FakeGitHub: Sendable {
    struct State {
        var commit = commitA
        var files: [String: (text: String, mode: String)] = [:]
        var folderSHA: [String: String] = [:]
        var rateLimited = false
    }
    final class Box: Sendable {
        let value: Mutex<State>
        init(_ s: State) { value = Mutex(s) }
        func withLock<R>(_ body: (inout State) -> R) -> R { value.withLock { body(&$0) } }
    }
    let state: Box
    let transport: ScriptedTransport

    init(files: [String: String], executable: Set<String> = []) {
        var s = State()
        for (path, text) in files { s.files[path] = (text, executable.contains(path) ? "100755" : "100644") }
        let state = Box(s)
        self.state = state
        transport = ScriptedTransport { request, _ in
            let url = request.url!
            let snapshot = state.withLock { $0 }
            if url.host() == "api.github.com" {
                if snapshot.rateLimited {
                    return .json(#"{"message":"API rate limit exceeded"}"#, status: 403,
                                 headers: ["x-ratelimit-remaining": "0", "x-ratelimit-reset": "4102444800"])
                }
                if url.path().hasSuffix("/commits/HEAD") {
                    #expect(request.value(forHTTPHeaderField: "Accept") == "application/vnd.github.sha")
                    if request.value(forHTTPHeaderField: "If-None-Match") == "\"\(snapshot.commit)\"" {
                        return ScriptedTransport.Reply(status: 304, body: Data())
                    }
                    return ScriptedTransport.Reply(status: 200, headers: ["etag": "\"\(snapshot.commit)\""], body: Data(snapshot.commit.utf8))
                }
                if url.path().contains("/git/trees/") {
                    #expect(url.path().removingPercentEncoding?.hasSuffix("\(snapshot.commit):skills") == true)
                    var items: [JSONValue] = []
                    var folders = Set<String>()
                    for (path, file) in snapshot.files where path.hasPrefix("skills/") {
                        let rel = String(path.dropFirst("skills/".count))
                        items.append(["path": .string(rel), "type": "blob", "mode": .string(file.mode),
                                      "sha": .string(Self.sha(file.text)), "size": .number(Double(file.text.utf8.count))])
                        var parent = (rel as NSString).deletingLastPathComponent
                        while !parent.isEmpty { folders.insert(parent); parent = (parent as NSString).deletingLastPathComponent }
                    }
                    for folder in folders {
                        items.append(["path": .string(folder), "type": "tree", "mode": "040000",
                                      "sha": .string(snapshot.folderSHA[folder] ?? "tree-\(folder)-\(snapshot.commit.prefix(4))")])
                    }
                    return .json(JSONValue.object(["sha": "root", "tree": .array(items), "truncated": false]).encodedString())
                }
            }
            if url.host() == "raw.githubusercontent.com" {
                let prefix = "/acme/skills/\(snapshot.commit)/"
                let path = url.path().removingPercentEncoding!
                guard path.hasPrefix(prefix), let file = snapshot.files[String(path.dropFirst(prefix.count))] else {
                    return ScriptedTransport.Reply(status: 404, body: Data("404".utf8))
                }
                return ScriptedTransport.Reply(status: 200, body: Data(file.text.utf8))
            }
            return ScriptedTransport.Reply(status: 404, body: Data())
        }
    }

    static func sha(_ text: String) -> String { Insecure.SHA1.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }

    func requests(host: String) -> [String] {
        transport.requests.compactMap(\.url).filter { $0.host() == host }.map { $0.path().removingPercentEncoding ?? $0.path() }
    }
}

private let registry = SkillRegistry(name: "Acme", source: .github(owner: "acme", repo: "skills", path: "skills", ref: nil))

private func digest(_ data: Data) -> String {
    "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

@Suite struct SkillRegistrySourceTests {
    @Test func parsesWhatUsersPaste() throws {
        #expect(try SkillRegistrySource.parse("anthropics/skills") == .github(owner: "anthropics", repo: "skills", path: nil, ref: nil))
        #expect(try SkillRegistrySource.parse("https://github.com/openai/skills/tree/main/skills/.curated")
                == .github(owner: "openai", repo: "skills", path: "skills/.curated", ref: "main"))
        #expect(try SkillRegistrySource.parse("github.com/acme/tools.git") == .github(owner: "acme", repo: "tools", path: nil, ref: nil))
        #expect(try SkillRegistrySource.parse("https://github.com/a/b/blob/dev/x/SKILL.md") == .github(owner: "a", repo: "b", path: "x", ref: "dev"))
        #expect(try SkillRegistrySource.parse("developers.cloudflare.com")
                == .index(URL(string: "https://developers.cloudflare.com/.well-known/agent-skills/index.json")!))
        #expect(try SkillRegistrySource.parse("https://example.com/skills/index.json") == .index(URL(string: "https://example.com/skills/index.json")!))
        #expect(throws: SkillRegistryError.self) { try SkillRegistrySource.parse("http://example.com/index.json") }
        #expect(throws: SkillRegistryError.self) { try SkillRegistrySource.parse("") }
        #expect(SkillRegistry.builtIns.allSatisfy { $0.isBuiltIn })
    }
}

@Suite struct SkillRegistryTests {
    private func github() -> FakeGitHub {
        FakeGitHub(files: [
            "skills/pdf/SKILL.md": skillMarkdown(name: "pdf", description: "PDF work. Use for PDFs."),
            "skills/pdf/reference.md": "forms",
            "skills/pdf/scripts/fill.py": "print(1)",
            "skills/pdf/tool": "binary-ish",
            "skills/docs/SKILL.md": skillMarkdown(name: "docs", description: "Docs. Use for docs."),
            "skills/docs/nested/SKILL.md": skillMarkdown(name: "nested"),
            "skills/broken/SKILL.md": "no frontmatter",
            "README.md": "outside the registry path",
        ], executable: ["skills/pdf/tool"])
    }

    @Test func githubListingCostsTwoAPICallsAndIsCached() async throws {
        let hub = github()
        let scratch = Scratch()
        let client = SkillRegistryClient(transport: hub.transport, cacheDirectory: scratch.url)
        let listing = try await client.listing(for: registry)
        #expect(listing.skills.map(\.name) == ["broken", "docs", "pdf"])
        let pdf = try #require(listing.skills.first { $0.name == "pdf" })
        #expect(pdf.description == "PDF work. Use for PDFs.")
        #expect(pdf.revision == "tree-pdf-aaaa")
        #expect(pdf.skippedFiles.map(\.path) == ["scripts/fill.py", "tool"])
        #expect(pdf.pageURL?.absoluteString == "https://github.com/acme/skills/tree/\(commitA)/skills/pdf")
        #expect(listing.skills.first { $0.name == "broken" }?.problem != nil)
        #expect(listing.skills.first { $0.name == "docs" }?.listedFiles.map(\.path) == ["nested/SKILL.md"])
        #expect(hub.requests(host: "api.github.com").count == 2)
        #expect(hub.requests(host: "raw.githubusercontent.com").count == 3)

        // Fresh cache: no network at all.
        _ = try await client.listing(for: registry)
        #expect(hub.transport.requests.count == 5)

        // Refresh, same commit: one conditional call (304), no tree, no raw.
        _ = try await client.listing(for: registry, refresh: true)
        #expect(hub.requests(host: "api.github.com").count == 3)
        #expect(hub.requests(host: "raw.githubusercontent.com").count == 3)

        // A new commit changes one skill: one tree call; unchanged SKILL.md blobs aren't re-read.
        hub.state.withLock {
            $0.commit = commitB
            $0.files["skills/docs/SKILL.md"]!.text = skillMarkdown(name: "docs", description: "Docs v2. Use for docs.")
        }
        let next = try await client.listing(for: registry, refresh: true)
        #expect(next.skills.first { $0.name == "docs" }?.description == "Docs v2. Use for docs.")
        #expect(hub.requests(host: "raw.githubusercontent.com").count == 4)

        // Another client on the same cache directory starts from disk.
        let other = SkillRegistryClient(transport: hub.transport, cacheDirectory: scratch.url)
        #expect(await other.cachedListing(for: registry)?.commit == commitB)
    }

    @Test func rateLimitServesCacheAndStopsCalling() async throws {
        let hub = github()
        let client = SkillRegistryClient(transport: hub.transport)
        _ = try await client.listing(for: registry)
        hub.state.withLock { $0.rateLimited = true }
        let stale = try await client.listing(for: registry, refresh: true)
        #expect(stale.skills.count == 3)
        #expect(stale.warnings.contains { $0.contains("limit") })
        let calls = hub.requests(host: "api.github.com").count
        _ = try await client.listing(for: registry, refresh: true)
        #expect(hub.requests(host: "api.github.com").count == calls) // blocked until reset

        let fresh = SkillRegistryClient(transport: hub.transport)
        await #expect(throws: SkillRegistryError.self) { try await fresh.listing(for: registry) }
    }

    @Test func installSkipsScriptsRecordsSourceAndFindsUpdates() async throws {
        let hub = github()
        let scratch = Scratch()
        let store = SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"))
        let client = SkillRegistryClient(transport: hub.transport)
        let listing = try await client.listing(for: registry)
        let pdf = try #require(listing.skills.first { $0.name == "pdf" })

        let preview = try await client.preview(pdf)
        #expect(preview.skillMarkdown.contains("name: pdf"))
        #expect(preview.files.map(\.path) == ["reference.md"])
        #expect(preview.skipped.map(\.path) == ["scripts/fill.py", "tool"])

        let report = try await client.install(pdf, from: registry, into: store)
        #expect(report.skill.files.map(\.path) == ["reference.md"])
        #expect(Set(report.dropped.map(\.path)) == ["scripts/fill.py", "tool"])
        #expect(!hub.requests(host: "raw.githubusercontent.com").contains { $0.hasSuffix("fill.py") || $0.hasSuffix("/tool") })
        let installed = try #require(await store.skill(named: "pdf"))
        #expect(installed.source?.kind == .registry)
        #expect(installed.source?.registryID == registry.id)
        #expect(installed.source?.revision == "tree-pdf-aaaa")
        #expect(Set(installed.removedFiles.map(\.path)) == ["scripts/fill.py", "tool"])

        let none = await client.updates(installed: await store.skills(), registries: [registry])
        #expect(none.updates.isEmpty && none.errors.isEmpty)

        hub.state.withLock { $0.commit = commitB }
        let some = await client.updates(installed: await store.skills(), registries: [registry], refresh: true)
        #expect(some.updates.map(\.installedName) == ["pdf"])
        #expect(some.updates.first?.latest.revision == "tree-pdf-bbbb")

        await #expect(throws: SkillRegistryError.self) {
            try await client.install(listing.skills.first { $0.name == "broken" }!, from: registry, into: store)
        }
    }

    // MARK: Discovery index

    private func indexTransport(_ index: String, files: [String: Data]) -> ScriptedTransport {
        ScriptedTransport { request, _ in
            let url = request.url!
            if url.path() == "/.well-known/agent-skills/index.json" { return .json(index) }
            if let data = files[url.path()] { return ScriptedTransport.Reply(status: 200, body: data) }
            return ScriptedTransport.Reply(status: 404, body: Data())
        }
    }

    @Test func discoveryIndexInstallsVerifiedArtifacts() async throws {
        let md = Data(skillMarkdown(name: "code-review", description: "Reviews code. Use for reviews.").utf8)
        let zip = TestZip.make([ZipEntrySpec("SKILL.md", skillMarkdown(name: "zipped")), ZipEntrySpec("notes.md", "n"),
                                ZipEntrySpec("scripts/x.sh", "echo")])
        let tgz = TestTar.gzip(TestTar.make([.file("SKILL.md", skillMarkdown(name: "wrangler")), .file("references/a.md", "a")]))
        let index = """
        {"$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json", "skills": [
          {"name": "code-review", "type": "skill-md", "description": "Reviews code.", "url": "code-review/SKILL.md", "digest": "\(digest(md))"},
          {"name": "zipped", "type": "archive", "description": "Zip.", "url": "/.well-known/agent-skills/zipped.zip", "digest": "\(digest(zip))"},
          {"name": "wrangler", "type": "archive", "description": "Tgz.", "url": "https://example.com/.well-known/agent-skills/wrangler.tar.gz", "digest": "\(digest(tgz))"},
          {"name": "tampered", "type": "skill-md", "description": "Bad.", "url": "code-review/SKILL.md", "digest": "sha256:\(String(repeating: "0", count: 64))"},
          {"name": "nodigest", "type": "skill-md", "description": "No digest.", "url": "code-review/SKILL.md"},
          {"name": "future", "type": "wasm-bundle", "description": "?", "url": "x", "digest": "\(digest(md))"}
        ]}
        """
        let transport = indexTransport(index, files: [
            "/.well-known/agent-skills/code-review/SKILL.md": md,
            "/.well-known/agent-skills/zipped.zip": zip,
            "/.well-known/agent-skills/wrangler.tar.gz": tgz,
        ])
        let source = try SkillRegistrySource.parse("example.com")
        let site = SkillRegistry(name: "Example", source: source)
        let client = SkillRegistryClient(transport: transport)
        let listing = try await client.listing(for: site)
        #expect(listing.skills.map(\.name) == ["code-review", "nodigest", "tampered", "wrangler", "zipped"])
        #expect(listing.warnings.contains { $0.contains("type") })
        #expect(listing.skills.first { $0.name == "nodigest" }?.problem?.contains("digest") == true)

        let scratch = Scratch()
        let store = SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"))
        for name in ["code-review", "zipped", "wrangler"] {
            let skill = try #require(listing.skills.first { $0.name == name })
            let report = try await client.install(skill, from: site, into: store)
            #expect(report.skill.name == name)
            #expect(report.skill.source?.revision == skill.revision)
        }
        #expect(await store.skill(named: "zipped")?.removedFiles.map(\.path) == ["scripts/x.sh"])

        let zipPreview = try await client.preview(try #require(listing.skills.first { $0.name == "zipped" }))
        #expect(zipPreview.files.map(\.path) == ["notes.md"])
        #expect(zipPreview.skipped.map(\.path) == ["scripts/x.sh"])

        await #expect(throws: SkillRegistryError.digestMismatch("tampered")) {
            try await client.install(listing.skills.first { $0.name == "tampered" }!, from: site, into: store)
        }
        await #expect(throws: SkillRegistryError.self) {
            try await client.install(listing.skills.first { $0.name == "nodigest" }!, from: site, into: store)
        }
    }

    @Test func unknownSchemaIsRefused() async throws {
        let transport = indexTransport(#"{"$schema": "https://schemas.agentskills.io/discovery/9.0.0/schema.json", "skills": []}"#, files: [:])
        let client = SkillRegistryClient(transport: transport)
        let site = SkillRegistry(name: "x", source: .index(URL(string: "https://example.com/.well-known/agent-skills/index.json")!))
        await #expect(throws: SkillRegistryError.self) { try await client.listing(for: site) }
    }

    @Test func legacyIndexListsFiles() async throws {
        let index = #"{"skills": [{"name": "git-flow", "description": "Git conventions.", "files": ["SKILL.md", "notes.md", "run.sh"]}]}"#
        let transport = indexTransport(index, files: [
            "/.well-known/agent-skills/git-flow/SKILL.md": Data(skillMarkdown(name: "git-flow").utf8),
            "/.well-known/agent-skills/git-flow/notes.md": Data("n".utf8),
        ])
        let client = SkillRegistryClient(transport: transport)
        let site = SkillRegistry(name: "x", source: .index(URL(string: "https://example.com/.well-known/agent-skills/index.json")!))
        let skill = try #require(try await client.listing(for: site).skills.first)
        let scratch = Scratch()
        let store = SkillStore(bundledDirectory: nil, importedDirectory: scratch.url.appending(path: "imported"))
        let report = try await client.install(skill, from: site, into: store)
        #expect(report.skill.files.map(\.path) == ["notes.md"])
        #expect(report.dropped.map(\.path) == ["run.sh"])
        #expect(!transport.requests.contains { $0.url?.path().hasSuffix("run.sh") == true })
    }
}
