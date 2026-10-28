import Foundation
import Testing
import Synchronization
import AgentCore
@testable import AgentJS

/// Records every path that reaches the file system.
private final class SpyFiles: VirtualFileSystem {
    let seen = Mutex<[String]>([])
    func list() async -> [String] { ["a.txt"] }
    func read(_ path: String, maxBytes: Int) async throws -> Data {
        seen.withLock { $0.append(path) }
        return Data("A".utf8)
    }
}

@Suite struct ScopedFilesTests {
    @Test func navigationPathsNeverReachTheFileSystem() async {
        let files = SpyFiles()
        let code = """
            const out = [];
            for (const p of ['../a.txt', '/a.txt', 'x/a.txt', '..', '~/a.txt', '']) {
              try { await fs.readText(p); out.push('read ' + p); } catch (e) { out.push(e.name); }
            }
            out.push(await fs.readText('a.txt'));
            return out;
            """
        let r = await QuickJSRunner().run(code, context: makeContext(files: files))
        #expect(r.value == ["TypeError", "TypeError", "TypeError", "TypeError", "TypeError", "TypeError", "A"])
        #expect(files.seen.withLock { $0 } == ["a.txt"])
    }

    @Test func kvStoreIsSavedAndRestored() async throws {
        let root = FileManager.default.temporaryDirectory.appending(path: "kv-\(UUID().uuidString)", directoryHint: .isDirectory)
        defer { try? FileManager.default.removeItem(at: root) }
        let storage = ScratchStore(root: root)
        let config = QuickJSRunner.Configuration(kvStorage: storage)
        _ = await QuickJSRunner(configuration: config).run("kv.set('a', {x: [1, 2]}); kv.set('b', 'two')", context: makeContext("c9"))
        #expect(storage.read(conversationID: "c9", name: "kv.json") != nil)

        let restored = QuickJSRunner(configuration: config)
        let r = await restored.run("return [kv.get('a').x[1], kv.get('b'), kv.keys()]", context: makeContext("c9"))
        #expect(r.value == [2, "two", ["a", "b"]])
        // Emptying the store removes the file; dropping it does too.
        _ = await restored.run("kv.delete('a'); kv.delete('b')", context: makeContext("c9"))
        #expect(storage.read(conversationID: "c9", name: "kv.json") == nil)
        _ = await restored.run("kv.set('c', 1)", context: makeContext("c9"))
        await restored.removeStore(conversationID: "c9")
        #expect(storage.read(conversationID: "c9", name: "kv.json") == nil)
        let fresh = await QuickJSRunner(configuration: config).run("return kv.keys().length", context: makeContext("c9"))
        #expect(fresh.value == 0)
    }
}
