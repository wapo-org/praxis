import Foundation
import CryptoKit
import AgentCore

/// Browses and installs skills from public registries over the app's
/// `HTTPTransport`. No account or token, nothing hosted by us.
///
/// **GitHub budget.** Unauthenticated API calls are limited to 60 an hour
/// per IP, so a listing costs at most two: the commit SHA of the ref
/// (`Accept: application/vnd.github.sha`, sent with `If-None-Match`) and,
/// only when that commit changed, one recursive tree of the registry
/// folder. Everything else — `SKILL.md` for descriptions and previews,
/// files on install — comes from raw.githubusercontent.com pinned to that
/// commit, which doesn't count against the API limit. Descriptions are
/// reused by blob SHA across refreshes, listings are cached in memory and
/// on disk for `listingMaxAge`, and once GitHub reports the limit used up
/// no further API call is made until its reset time (the cached listing is
/// shown with a note instead).
///
/// **Discovery indexes** (Agent Skills discovery 0.2.0) are one request;
/// every artifact is checked against its `sha256:` digest and refused on
/// mismatch, as the RFC requires.
///
/// **Installing** goes through the same importer as a zip from Files:
/// path and size rules, `SKILL.md` validation, and scripts left out with
/// a note — never executed (skills on this device are instructions only).
public actor SkillRegistryClient {
    public static let listingMaxAge: TimeInterval = 15 * 60
    /// Most skills a GitHub listing keeps; past this the rest are dropped
    /// with a warning (a hostile repo must not exhaust memory/time).
    static let maxListedSkills = 2000
    static let discoverySchemaV2 = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
    static let userAgent = "PraxisChat-Skills/1.0"

    let transport: any HTTPTransport
    let cacheDirectory: URL?
    let limits: SkillLimits
    let now: @Sendable () -> Date

    private var listings: [String: RegistryListing] = [:]
    /// Conditional-request cache: URL → (ETag, body).
    private var etags: [String: (etag: String, body: Data)] = [:]
    private var githubBlockedUntil: Date?
    /// Archives downloaded for a preview, reused by the install (url+digest → bytes).
    private var archives: [String: Data] = [:]

    public init(transport: any HTTPTransport = URLSessionTransport(), cacheDirectory: URL? = nil,
                limits: SkillLimits = SkillLimits(), now: @escaping @Sendable () -> Date = { Date() }) {
        self.transport = transport
        self.cacheDirectory = cacheDirectory
        self.limits = limits
        self.now = now
    }

    // MARK: Listing

    /// The last listing without touching the network (memory, then disk).
    public func cachedListing(for registry: SkillRegistry) -> RegistryListing? {
        if let listing = listings[registry.id] { return listing }
        guard let listing = readCache(registry.id) else { return nil }
        listings[registry.id] = listing
        return listing
    }

    /// The registry's skills, from cache while it's younger than
    /// `listingMaxAge` unless `refresh`. When GitHub's limit is used up and
    /// an older listing exists, that is returned with a warning.
    public func listing(for registry: SkillRegistry, refresh: Bool = false) async throws -> RegistryListing {
        let previous = cachedListing(for: registry)
        if !refresh, let previous, now().timeIntervalSince(previous.fetchedAt) < Self.listingMaxAge { return previous }
        do {
            let fresh: RegistryListing
            switch registry.source {
            case .github(let owner, let repo, let path, let ref):
                fresh = try await githubListing(registry, owner: owner, repo: repo, path: path, ref: ref, previous: previous)
            case .index(let url):
                fresh = try await indexListing(registry, url: url)
            }
            listings[registry.id] = fresh
            writeCache(fresh)
            return fresh
        } catch let error as SkillRegistryError {
            if case .rateLimited = error, var stale = previous {
                stale.warnings.append("Showing the list as of \(Self.shortTime(stale.fetchedAt)). \(error.description)")
                return stale
            }
            throw error
        }
    }

    private func githubListing(_ registry: SkillRegistry, owner: String, repo: String, path: String?, ref: String?,
                               previous: RegistryListing?) async throws -> RegistryListing {
        let api = "https://api.github.com/repos/\(Self.encode(owner))/\(Self.encode(repo))"
        let shaData = try await get(URL(string: "\(api)/commits/\(Self.encode(ref ?? "HEAD"))")!,
                                    accept: "application/vnd.github.sha", limit: 1_000, conditional: true)
        let commit = String(decoding: shaData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard commit.count == 40, commit.allSatisfy(\.isHexDigit) else {
            throw SkillRegistryError.invalidIndex("GitHub didn't return a commit for \(owner)/\(repo).")
        }
        if var previous, previous.commit == commit {
            previous.fetchedAt = now()
            previous.warnings = previous.warnings.filter { !$0.hasPrefix("Showing the list as of") }
            return previous
        }

        let treeRef = path.map { "\(commit):\($0)" } ?? commit
        let treeURL = URL(string: "\(api)/git/trees/\(Self.encode(treeRef))?recursive=1")!
        let treeData = try await get(treeURL, accept: "application/vnd.github+json", limit: 32 << 20)
        guard let tree = try? JSONValue(parsing: treeData), let items = tree["tree"]?.arrayValue else {
            throw SkillRegistryError.invalidIndex("GitHub returned an unreadable file list for \(owner)/\(repo).")
        }
        var warnings: [String] = []
        if tree["truncated"]?.boolValue == true {
            warnings.append("This repository is too large to list completely; some skills may be missing. Add a registry for a sub-folder instead.")
        }

        var blobs: [(path: String, sha: String, size: Int?, executable: Bool)] = []
        var folders: [String: String] = [:]
        for item in items {
            guard let p = item["path"]?.stringValue, let sha = item["sha"]?.stringValue else { continue }
            switch item["type"]?.stringValue {
            case "blob"?: blobs.append((p, sha, item["size"]?.intValue, item["mode"]?.stringValue == "100755"))
            case "tree"?: folders[p] = sha
            default: break
            }
        }
        // A folder is a skill when it holds SKILL.md; skills nested inside
        // another skill's folder belong to that skill.
        let skillDirs = blobs.filter { $0.path == "SKILL.md" || $0.path.hasSuffix("/SKILL.md") }
            .map { ($0.path as NSString).deletingLastPathComponent }
            .sorted()
        // Sorted order groups each skill's nested skills right after it, so
        // only the last kept dir can be an ancestor — no quadratic scan —
        // and the listing stops at the cap with a warning.
        var kept: [String] = []
        var capped = false
        for dir in skillDirs {
            if let last = kept.last, last.isEmpty || dir.hasPrefix(last + "/") { continue }
            if kept.count >= Self.maxListedSkills { capped = true; break }
            kept.append(dir)
        }
        if capped {
            warnings.append("This registry lists more than \(Self.maxListedSkills) skills; showing the first \(Self.maxListedSkills). Add a registry for a sub-folder instead.")
        }

        // One sort + binary search per skill: per-dir `blobs.filter` scans
        // would be quadratic in the tree size.
        let sortedBlobs = blobs.sorted { $0.path < $1.path }
        var indexByPath: [String: Int] = [:]
        indexByPath.reserveCapacity(sortedBlobs.count)
        for (i, blob) in sortedBlobs.enumerated() { indexByPath[blob.path] = i }
        func lowerBound(_ prefix: String) -> Int {
            var lo = 0, hi = sortedBlobs.count
            while lo < hi {
                let mid = (lo + hi) / 2
                if sortedBlobs[mid].path < prefix { lo = mid + 1 } else { hi = mid }
            }
            return lo
        }

        let known = Dictionary((previous?.skills ?? []).compactMap { skill -> (String, RegistrySkill)? in
            if case .githubFolder(_, _, _, _, let blob, _) = skill.artifact { return (blob, skill) }
            return nil
        }, uniquingKeysWith: { a, _ in a })

        let base = path.map { $0 + "/" } ?? ""
        var drafts: [RegistrySkill] = []
        var toFetch: [(index: Int, url: URL, folder: String)] = []
        for dir in kept {
            let prefix = dir.isEmpty ? "" : dir + "/"
            var files: [RegistryFile] = []
            var i = lowerBound(prefix)
            while i < sortedBlobs.count, sortedBlobs[i].path.hasPrefix(prefix) {
                let blob = sortedBlobs[i]
                let file = RegistryFile(path: String(blob.path.dropFirst(prefix.count)), size: blob.size, executable: blob.executable)
                if !SkillPath.isIgnored(file.path) { files.append(file) }
                i += 1
            }
            files.sort { $0.path < $1.path }
            let skillBlob = sortedBlobs[indexByPath[prefix + "SKILL.md"]!]
            let folder = dir.isEmpty ? (path.map { ($0 as NSString).lastPathComponent } ?? repo) : (dir as NSString).lastPathComponent
            let fullPath = base + prefix + "SKILL.md"
            var skill = RegistrySkill(
                id: dir.isEmpty ? "." : dir, registryID: registry.id, name: folder, description: "",
                revision: dir.isEmpty ? tree["sha"]?.stringValue : folders[dir],
                pageURL: URL(string: "https://github.com/\(owner)/\(repo)/tree/\(commit)/\(base + dir)"),
                artifact: .githubFolder(owner: owner, repo: repo, commit: commit, path: base + dir, skillBlob: skillBlob.sha, files: files))
            if let size = skillBlob.size, size > limits.maxSkillFileBytes {
                skill.problem = "SKILL.md is \(SkillImporter.formatBytes(size)); the limit on this device is \(SkillImporter.formatBytes(limits.maxSkillFileBytes))."
            } else if let cached = known[skillBlob.sha] {
                skill.name = cached.name
                skill.description = cached.description
                skill.problem = cached.problem
            } else {
                toFetch.append((drafts.count, Self.rawURL(owner: owner, repo: repo, commit: commit, path: fullPath), folder))
            }
            drafts.append(skill)
        }

        // Descriptions: raw SKILL.md files, a few at a time. Each fetch is
        // parsed to its summary inside its own task, so at most a handful
        // of file bodies are ever held at once.
        let transport = self.transport
        let maxBytes = limits.maxSkillFileBytes
        await withTaskGroup(of: (Int, Result<(name: String?, description: String, problem: String?), SkillRegistryError>).self) { group in
            var pending = toFetch[...]
            func addNext() {
                guard let next = pending.popFirst() else { return }
                group.addTask {
                    let result = await Self.fetchRaw(next.url, transport: transport, limit: maxBytes)
                    switch result {
                    case .success(let data):
                        let parsed = Self.summary(of: data, folder: next.folder)
                        return (next.index, .success(parsed))
                    case .failure(let error):
                        return (next.index, .failure(error))
                    }
                }
            }
            for _ in 0..<6 { addNext() }
            for await (index, result) in group {
                switch result {
                case .success(let parsed):
                    // Listing text stays small no matter what the file holds
                    // (descriptions over 1024 chars are invalid anyway).
                    drafts[index].name = parsed.name.map { String($0.prefix(200)) } ?? drafts[index].name
                    drafts[index].description = String(parsed.description.prefix(1024))
                    drafts[index].problem = parsed.problem
                case .failure(let error):
                    drafts[index].problem = "Couldn't read SKILL.md: \(error.description)"
                }
                addNext()
            }
        }
        return RegistryListing(registryID: registry.id, skills: drafts.sorted { $0.name < $1.name }, fetchedAt: now(),
                               warnings: warnings, commit: commit)
    }

    private func indexListing(_ registry: SkillRegistry, url: URL) async throws -> RegistryListing {
        let data = try await get(url, accept: "application/json", limit: 5 << 20, conditional: true)
        let index = try AgentSkillsIndex(data: data, url: url)
        let skills = index.entries.map { entry in
            RegistrySkill(id: entry.name, registryID: registry.id, name: entry.name, description: entry.description,
                          revision: entry.digest, pageURL: url, artifact: entry.artifact, problem: entry.problem)
        }
        return RegistryListing(registryID: registry.id, skills: skills.sorted { $0.name < $1.name }, fetchedAt: now(),
                               warnings: index.warnings, commit: nil)
    }

    /// Name, description and the reason it can't be installed, from SKILL.md bytes.
    static func summary(of data: Data, folder: String?) -> (name: String?, description: String, problem: String?) {
        guard SkillFileFilter.isText(data) else { return (nil, "", "SKILL.md isn't UTF-8 text.") }
        do {
            let document = try SkillDocument(parsing: String(decoding: data, as: UTF8.self))
            let validation = document.validate(folderName: folder)
            return (document.name.flatMap { $0.isEmpty ? nil : $0 }, document.description ?? "",
                    validation.isValid ? nil : validation.errors.joined(separator: " "))
        } catch {
            return (nil, "", (error as? SkillError)?.description ?? error.localizedDescription)
        }
    }

    // MARK: Preview

    /// `SKILL.md` plus what would be installed and left out.
    public func preview(_ skill: RegistrySkill) async throws -> RegistryPreview {
        switch skill.artifact {
        case .githubFolder(let owner, let repo, let commit, let path, _, _):
            let data = try await raw(Self.rawURL(owner: owner, repo: repo, commit: commit, path: Self.join(path, "SKILL.md")),
                                     limit: limits.maxSkillFileBytes)
            let skipped = skill.skippedFiles
            let files = skill.listedFiles.filter { f in !skipped.contains { $0.path == f.path } }
                .map { SkillFile(path: $0.path, size: $0.size ?? 0) }
            return RegistryPreview(skill: skill, skillMarkdown: String(decoding: data, as: UTF8.self), files: files,
                                   skipped: skipped, warnings: Self.warnings(for: data, skill: skill))
        case .skillMarkdown(let url, let digest):
            let data = try await verified(url, digest: digest, name: skill.name, limit: limits.maxSkillFileBytes)
            return RegistryPreview(skill: skill, skillMarkdown: String(decoding: data, as: UTF8.self), files: [], skipped: [],
                                   warnings: Self.warnings(for: data, skill: skill))
        case .archive(let url, let digest):
            let data = try await archive(url, digest: digest, name: skill.name)
            do {
                let extracted = try SkillImporter(limits: limits).extract(archive: data, name: url.lastPathComponent)
                let md = extracted.files.first { $0.path == "SKILL.md" }.map { String(decoding: $0.data, as: UTF8.self) } ?? ""
                return RegistryPreview(skill: skill, skillMarkdown: md,
                                       files: extracted.files.filter { $0.path != "SKILL.md" }.map { SkillFile(path: $0.path, size: $0.data.count) },
                                       skipped: extracted.dropped, warnings: extracted.warnings)
            } catch let error as SkillError {
                throw SkillRegistryError.notInstallable(error.description)
            }
        case .files(let base, let paths):
            let data = try await raw(base.appending(path: "SKILL.md"), limit: limits.maxSkillFileBytes)
            let others = paths.filter { $0 != "SKILL.md" }
            let skipped = others.compactMap { p in SkillFileFilter.dropReason(path: p, executable: false).map { DroppedFile(path: p, reason: $0) } }
            return RegistryPreview(skill: skill, skillMarkdown: String(decoding: data, as: UTF8.self),
                                   files: others.filter { p in !skipped.contains { $0.path == p } }.map { SkillFile(path: $0, size: 0) },
                                   skipped: skipped, warnings: Self.warnings(for: data, skill: skill))
        }
    }

    private static func warnings(for data: Data, skill: RegistrySkill) -> [String] {
        if let problem = skill.problem { return [problem] }
        guard let document = try? SkillDocument(parsing: String(decoding: data, as: UTF8.self)) else {
            return ["SKILL.md couldn't be read."]
        }
        let validation = document.validate()
        return validation.errors + validation.warnings
    }

    // MARK: Install

    /// Downloads and installs through `store` (same validation as a file
    /// import). Scripts and executables are never downloaded; they're
    /// reported as left out. Replaces an installed skill with the same name.
    @discardableResult
    public func install(_ skill: RegistrySkill, from registry: SkillRegistry, into store: SkillStore) async throws -> SkillImportReport {
        if let problem = skill.problem { throw SkillRegistryError.notInstallable(problem) }
        let source = SkillSource(kind: .registry, registryID: registry.id, registryName: registry.name, entryID: skill.id,
                                 revision: skill.revision, pageURL: skill.pageURL)
        do {
            switch skill.artifact {
            case .githubFolder(let owner, let repo, let commit, let path, _, let listed):
                let skippable = Set(skill.skippedFiles.map(\.path))
                let wanted = listed.filter { !skippable.contains($0.path) }
                guard wanted.count <= limits.maxFiles else {
                    throw SkillRegistryError.notInstallable("This skill has \(wanted.count) files; the limit is \(limits.maxFiles).")
                }
                let total = wanted.reduce(0) { $0 + ($1.size ?? 0) }
                guard total <= limits.maxTotalBytes else {
                    throw SkillRegistryError.notInstallable("This skill is \(SkillImporter.formatBytes(total)); the limit is \(SkillImporter.formatBytes(limits.maxTotalBytes)).")
                }
                var files = try await downloadAll(wanted.map { file in
                    (file.path, Self.rawURL(owner: owner, repo: repo, commit: commit, path: Self.join(path, file.path)))
                })
                // Left-out files aren't downloaded; empty stand-ins let the
                // importer record them as removed, exactly as on import.
                for file in listed where skippable.contains(file.path) { files.append((file.path, Data())) }
                let executable = Set(listed.filter(\.executable).map(\.path))
                let folder = (path as NSString).lastPathComponent
                return try await store.install(files: files, sourceName: "\(owner)/\(repo)/\(path)", source: source,
                                               folderName: folder.isEmpty ? repo : folder, executable: executable)
            case .skillMarkdown(let url, let digest):
                let data = try await verified(url, digest: digest, name: skill.name, limit: limits.maxSkillFileBytes)
                return try await store.install(files: [("SKILL.md", data)], sourceName: url.lastPathComponent, source: source,
                                               folderName: skill.name)
            case .archive(let url, let digest):
                let data = try await archive(url, digest: digest, name: skill.name)
                return try await store.install(archive: data, sourceName: url.lastPathComponent, source: source)
            case .files(let base, let paths):
                var wanted: [(String, URL)] = []
                var skipped: [(String, Data)] = []
                for raw in paths {
                    let path = try SkillPath.normalize(raw)
                    if SkillFileFilter.dropReason(path: path, executable: false) != nil { skipped.append((path, Data())); continue }
                    wanted.append((path, base.appending(path: path)))
                }
                guard wanted.contains(where: { $0.0 == "SKILL.md" }) else {
                    throw SkillRegistryError.notInstallable("The index doesn't list a SKILL.md for \(skill.name).")
                }
                guard wanted.count <= limits.maxFiles else {
                    throw SkillRegistryError.notInstallable("This skill has \(wanted.count) files; the limit is \(limits.maxFiles).")
                }
                let files = try await downloadAll(wanted) + skipped
                return try await store.install(files: files, sourceName: skill.name, source: source, folderName: skill.name)
            }
        } catch let error as SkillError {
            throw SkillRegistryError.notInstallable(error.description)
        }
    }

    private func downloadAll(_ wanted: [(path: String, url: URL)]) async throws -> [(path: String, data: Data)] {
        let transport = self.transport
        let limit = limits.maxTotalBytes
        return try await withThrowingTaskGroup(of: (String, Data).self) { group in
            var out: [(path: String, data: Data)] = []
            // Listed sizes are advisory (a hostile registry lies), so the
            // running total — not the pre-check — enforces the cap.
            var total = 0
            var pending = wanted[...]
            func addNext() {
                guard let next = pending.popFirst() else { return }
                group.addTask {
                    switch await Self.fetchRaw(next.url, transport: transport, limit: limit) {
                    case .success(let data): return (next.path, data)
                    case .failure(let error): throw error
                    }
                }
            }
            for _ in 0..<6 { addNext() }
            while let result = try await group.next() {
                total += result.1.count
                guard total <= limits.maxTotalBytes else {
                    group.cancelAll()
                    throw SkillRegistryError.notInstallable(
                        "This skill downloads \(SkillImporter.formatBytes(total)); the limit is \(SkillImporter.formatBytes(limits.maxTotalBytes)).")
                }
                out.append(result)
                addNext()
            }
            return out
        }
    }

    // MARK: Updates

    /// Installed registry skills whose registry now lists other content.
    /// Uses cached listings while fresh, so it's cheap to call on open.
    public func updates(installed: [Skill], registries: [SkillRegistry], refresh: Bool = false) async -> (updates: [RegistryUpdate], errors: [String]) {
        var updates: [RegistryUpdate] = []
        var errors: [String] = []
        let fromRegistries = installed.filter { $0.source?.kind == .registry }
        for registry in registries {
            let mine = fromRegistries.filter { $0.source?.registryID == registry.id }
            guard !mine.isEmpty else { continue }
            do {
                let listing = try await listing(for: registry, refresh: refresh)
                for skill in mine {
                    guard let entry = listing.skills.first(where: { $0.id == skill.source?.entryID }),
                          let latest = entry.revision, let have = skill.source?.revision, latest != have else { continue }
                    updates.append(RegistryUpdate(installedName: skill.name, registry: registry, latest: entry))
                }
            } catch {
                errors.append("\(registry.name): \((error as? SkillRegistryError)?.description ?? error.localizedDescription)")
            }
        }
        return (updates, errors)
    }

    // MARK: HTTP

    private func get(_ url: URL, accept: String, limit: Int, conditional: Bool = false) async throws -> Data {
        let isGitHubAPI = url.host() == "api.github.com"
        if isGitHubAPI, let until = githubBlockedUntil, until > now() { throw SkillRegistryError.rateLimited(resetsAt: until) }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 30
        request.setValue(accept, forHTTPHeaderField: "Accept")
        request.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")
        if isGitHubAPI { request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version") }
        let cached = conditional ? etags[url.absoluteString] : nil
        if let cached { request.setValue(cached.etag, forHTTPHeaderField: "If-None-Match") }

        let (data, head) = try await Self.send(request, transport: transport, limit: limit)
        if head.status == 304, let cached { return cached.body }
        if isGitHubAPI, head.status == 429 || (head.status == 403 && head.header("x-ratelimit-remaining") == "0") {
            let reset = head.header("x-ratelimit-reset").flatMap(Double.init).map { Date(timeIntervalSince1970: $0) }
                ?? head.retryAfter.map { now().addingTimeInterval(Double($0.components.seconds)) }
            githubBlockedUntil = reset ?? now().addingTimeInterval(60)
            throw SkillRegistryError.rateLimited(resetsAt: reset)
        }
        guard head.isSuccess else { throw SkillRegistryError.http(status: head.status, url: Self.shortURL(url)) }
        guard data.count <= limit else {
            throw SkillRegistryError.notInstallable("\(Self.shortURL(url)) is larger than \(SkillImporter.formatBytes(limit)).")
        }
        if conditional, let etag = head.header("etag") { etags[url.absoluteString] = (etag, data) }
        return data
    }

    private func raw(_ url: URL, limit: Int) async throws -> Data {
        try await Self.fetchRaw(url, transport: transport, limit: limit).get()
    }

    private func verified(_ url: URL, digest: String?, name: String, limit: Int) async throws -> Data {
        let data = try await raw(url, limit: limit)
        try Self.verify(data, digest: digest, name: name)
        return data
    }

    private func archive(_ url: URL, digest: String?, name: String) async throws -> Data {
        let key = url.absoluteString + "#" + (digest ?? "")
        if let data = archives[key] { return data }
        let data = try await verified(url, digest: digest, name: name, limit: limits.maxTotalBytes + 4 * 1024 * 1024)
        if archives.count >= 3 { archives.removeAll() }
        archives[key] = data
        return data
    }

    static func verify(_ data: Data, digest: String?, name: String) throws {
        guard let digest else { return }
        let actual = "sha256:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard actual == digest.lowercased() else { throw SkillRegistryError.digestMismatch(name) }
    }

    static func fetchRaw(_ url: URL, transport: any HTTPTransport, limit: Int) async -> Result<Data, SkillRegistryError> {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 60
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        do {
            let (data, head) = try await send(request, transport: transport, limit: limit)
            guard head.isSuccess else { return .failure(.http(status: head.status, url: shortURL(url))) }
            guard data.count <= limit else {
                return .failure(.notInstallable("\(url.lastPathComponent) is larger than \(SkillImporter.formatBytes(limit))."))
            }
            return .success(data)
        } catch let error as SkillRegistryError {
            return .failure(error)
        } catch {
            return .failure(.network(error.localizedDescription))
        }
    }

    private static func send(_ request: URLRequest, transport: any HTTPTransport, limit: Int) async throws -> (Data, HTTPResponseHead) {
        do {
            return try await transport.data(request, limit: limit)
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as ProviderError {
            throw SkillRegistryError.network(error.description)
        } catch {
            throw SkillRegistryError.network(error.localizedDescription)
        }
    }

    // MARK: Helpers

    static func rawURL(owner: String, repo: String, commit: String, path: String) -> URL {
        let encodedPath = path.split(separator: "/").map { encode(String($0)) }.joined(separator: "/")
        return URL(string: "https://raw.githubusercontent.com/\(encode(owner))/\(encode(repo))/\(commit)/\(encodedPath)")!
    }

    static func join(_ a: String, _ b: String) -> String { a.isEmpty ? b : a + "/" + b }

    static func encode(_ s: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "?#")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    static func shortURL(_ url: URL) -> String { (url.host() ?? "") + url.path() }

    static func shortTime(_ date: Date) -> String {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .short
        f.doesRelativeDateFormatting = true
        return f.string(from: date)
    }

    // MARK: Disk cache

    private func cacheURL(_ id: String) -> URL? {
        let name = SHA256.hash(data: Data(id.utf8)).prefix(10).map { String(format: "%02x", $0) }.joined()
        return cacheDirectory?.appending(path: "registry-\(name).json")
    }

    private func readCache(_ id: String) -> RegistryListing? {
        guard let url = cacheURL(id), let data = try? Data(contentsOf: url) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        guard let listing = try? decoder.decode(RegistryListing.self, from: data), listing.registryID == id else { return nil }
        return listing
    }

    private func writeCache(_ listing: RegistryListing) {
        guard let url = cacheURL(listing.registryID) else { return }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? encoder.encode(listing).write(to: url, options: .atomic)
    }
}
