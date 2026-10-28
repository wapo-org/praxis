import Foundation
import Testing
import Synchronization
import AgentCore
import AgentTestSupport
@testable import AgentJS

@Suite struct FetchTests {
    @Test func getJSONWithHeadersAndTrace() async {
        let transport = ScriptedTransport(replies: [.json(#"{"items":[1,2,3]}"#, headers: ["X-Rate": "9"])])
        let runner = QuickJSRunner(configuration: .init(transport: transport))
        let log = EmitLog()
        let r = await runner.run("""
            const res = await fetch('https://api.example.com/items?q=1', { headers: { Authorization: 'Bearer t', 'X-Test': 'yes' } });
            const body = await res.json();
            return { status: res.status, ok: res.ok, statusText: res.statusText, url: res.url,
                     rate: res.headers.get('x-rate'), type: res.headers.get('Content-Type'),
                     names: [...res.headers.entries()].map(e => e[0]), n: body.items.length };
            """, context: makeContext(log: log))
        #expect(r.error == nil)
        #expect(r.value == ["status": 200, "ok": true, "statusText": "OK", "url": "https://api.example.com/items?q=1",
                            "rate": "9", "type": "application/json", "names": ["content-type", "x-rate"], "n": 3])
        let request = try! #require(transport.requests.first)
        #expect(request.method == "GET")
        #expect(request.url?.absoluteString == "https://api.example.com/items?q=1")
        #expect(request.headers["authorization"] == "Bearer t" || request.headers["Authorization"] == "Bearer t")
        #expect(request.headers.contains { $0.key.lowercased() == "x-test" && $0.value == "yes" })
        #expect(log.traces == ["GET https://api.example.com/items?q=1 → 200 · 17 B"])
        #expect(r.fetchCount == 1)
    }

    @Test func postBodies() async {
        let transport = ScriptedTransport { _, _ in .json(#"{"ok":true}"#, status: 201) }
        let runner = QuickJSRunner(configuration: .init(transport: transport))
        let r = await runner.run("""
            const a = await fetch('https://example.com/a', { method: 'POST', body: { name: 'x', n: 1 } });
            await fetch('https://example.com/b', { method: 'put', body: 'plain text' });
            await fetch('https://example.com/c', { method: 'POST', body: new Uint8Array([0, 255]), headers: { 'content-type': 'application/octet-stream' } });
            const t = await a.text();
            return [a.status, a.statusText, t];
            """, context: makeContext())
        #expect(r.error == nil)
        #expect(r.value == [201, "Created", #"{"ok":true}"#])
        let reqs = transport.requests
        #expect(reqs.map(\.method) == ["POST", "PUT", "POST"])
        #expect(reqs[0].json == ["name": "x", "n": 1])
        #expect(reqs[0].headers.first { $0.key.lowercased() == "content-type" }?.value == "application/json")
        #expect(reqs[1].body == Data("plain text".utf8))
        #expect(reqs[2].body == Data([0, 255]))
    }

    @Test func responseSizeIsCapped() async {
        let transport = ScriptedTransport { _, _ in .init(body: Data(repeating: 65, count: 4096)) }
        let runner = QuickJSRunner(configuration: .init(transport: transport, maxResponseBytes: 1024))
        let r = await runner.run("""
            try { await fetch('https://example.com/big'); return 'no'; } catch (e) { return e.name + ': ' + e.message; }
            """, context: makeContext())
        #expect(r.value?.stringValue?.hasPrefix("TypeError: fetch: response body exceeds") == true)
    }

    @Test func requestCountIsCapped() async {
        let transport = ScriptedTransport { _, _ in .json("{}") }
        let runner = QuickJSRunner(configuration: .init(transport: transport, maxFetches: 2))
        let r = await runner.run("""
            await fetch('https://example.com/1'); await fetch('https://example.com/2');
            try { await fetch('https://example.com/3'); } catch (e) { return e.message; }
            """, context: makeContext())
        #expect(r.value?.stringValue?.contains("request limit reached (2 per run)") == true)
        #expect(transport.requests.count == 2)
    }

    @Test func onlyPublicHTTPURLs() async {
        let transport = ScriptedTransport { _, _ in .json("{}") }
        let runner = QuickJSRunner(configuration: .init(transport: transport))
        let r = await runner.run("""
            const out = [];
            for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'data:text/plain,hi', 'http://localhost:8080/', 'http://192.168.1.1/', 'not a url']) {
              try { await fetch(u); out.push('allowed ' + u); } catch (e) { out.push(e.name); }
            }
            return out;
            """, context: makeContext())
        #expect(r.value == .array(Array(repeating: "TypeError", count: 6)))
        #expect(transport.requests.isEmpty)
    }

    @Test func planModeAllowsOnlyGetAndHead() async {
        let transport = ScriptedTransport { _, _ in .json("{}") }
        let runner = QuickJSRunner(configuration: .init(transport: transport))
        let r = await runner.run("""
            const get = (await fetch('https://example.com/')).status;
            const head = (await fetch('https://example.com/', { method: 'HEAD' })).status;
            let post;
            try { await fetch('https://example.com/', { method: 'POST', body: 'x' }); } catch (e) { post = e.message; }
            return { get, head, post };
            """, context: makeContext(mode: .plan))
        #expect(r.value?["get"] == 200)
        #expect(r.value?["head"] == 200)
        #expect(r.value?["post"]?.stringValue?.contains("Plan mode only allows GET and HEAD") == true)
        #expect(transport.requests.map(\.method) == ["GET", "HEAD"])
    }

    @Test func transportFailureRejects() async {
        let transport = ScriptedTransport { _, _ in throw ProviderError.network("offline") }
        let runner = QuickJSRunner(configuration: .init(transport: transport))
        let log = EmitLog()
        let r = await runner.run("await fetch('https://example.com/');", context: makeContext(log: log))
        #expect(r.error?.kind == .thrown)
        #expect(r.error?.name == "TypeError")
        #expect(r.error?.message.contains("fetch failed") == true)
        #expect(log.traces == ["GET https://example.com/ → failed"])
    }
}

@Suite struct FilesAndKVTests {
    @Test func fsReadsAttachments() async {
        let files = StubFiles(files: ["notes.txt": Data("hello\nworld".utf8), "data.bin": Data([1, 2, 3, 4])])
        let runner = QuickJSRunner()
        let r = await runner.run("""
            const names = await fs.list();
            const text = await fs.readText('notes.txt');
            const head = await fs.readText('notes.txt', { maxBytes: 5 });
            const bytes = await fs.readBytes('data.bin');
            let missing;
            try { await fs.readText('nope.txt'); } catch (e) { missing = e.message.startsWith("fs: couldn't read nope.txt"); }
            return { names, text, head, bytes: [bytes instanceof Uint8Array, ...bytes], missing };
            """, context: makeContext(files: files))
        #expect(r.error == nil)
        #expect(r.value == ["names": ["data.bin", "notes.txt"], "text": "hello\nworld", "head": "hello",
                            "bytes": [true, 1, 2, 3, 4], "missing": true])
    }

    @Test func fsWithoutFiles() async {
        let r = await QuickJSRunner().run("return [await fs.list(), await fs.readText('x').catch(e => e.message)]", context: makeContext())
        #expect(r.value == [[], "fs: no files are attached to this conversation"])
    }

    @Test func kvPersistsPerConversation() async {
        let runner = QuickJSRunner()
        let first = await runner.run("kv.set('count', { n: 1 }); kv.set('tmp', 1); kv.delete('tmp'); return kv.keys();", context: makeContext("conv-a"))
        #expect(first.value == ["count"])
        let second = await runner.run("const c = kv.get('count'); kv.set('count', { n: c.n + 1 }); return kv.get('count').n;", context: makeContext("conv-a"))
        #expect(second.resultJSON == "2")
        let other = await runner.run("return [kv.get('count') === undefined, kv.keys().length];", context: makeContext("conv-b"))
        #expect(other.value == [true, 0])
        await runner.removeStore(conversationID: "conv-a")
        let cleared = await runner.run("return kv.keys()", context: makeContext("conv-a"))
        #expect(cleared.value == [])
    }

    @Test func kvRejectsUnserializableAndOversizedValues() async {
        let runner = QuickJSRunner(configuration: .init(maxKVBytes: 1024))
        let r = await runner.run("""
            const errs = [];
            try { kv.set('f', () => 1); } catch (e) { errs.push(e.name); }
            try { kv.set('big', 'x'.repeat(2000)); } catch (e) { errs.push(e.name); }
            return errs;
            """, context: makeContext())
        #expect(r.value == ["TypeError", "RangeError"])
    }
}

@Suite struct ToolBridgeTests {
    static let specs = [
        ToolSpec(name: "mcp__github__search_issues", description: "Search issues.\nMore detail.",
                 inputSchema: ["type": "object", "properties": ["query": ["type": "string"], "repo": ["type": "string"]], "required": ["query"]]),
        ToolSpec(name: "plain_tool", description: "Returns text.", inputSchema: ["type": "object", "properties": [:]]),
    ]

    @Test func toolsCallThroughContextAndParseJSON() async {
        let calls = Mutex<[(String, JSONValue)]>([])
        let context = makeContext(callTool: { name, args in
            calls.withLock { $0.append((name, args)) }
            switch name {
            case "plain_tool": return .text("just text")
            default: return .text(#"{"total":2,"items":[{"id":1},{"id":2}]}"#)
            }
        })
        let r = await QuickJSRunner().run("""
            const a = await tools.github.search_issues({ query: 'bug', repo: 'x/y' });
            const b = await tools.mcp__github__search_issues({ query: 'again' });
            const c = await tools.plain_tool();
            return { total: a.total, ids: a.items.map(i => i.id), same: b.total, c };
            """, context: context, hostTools: Self.specs)
        #expect(r.error == nil)
        #expect(r.value == ["total": 2, "ids": [1, 2], "same": 2, "c": "just text"])
        let recorded = calls.withLock { $0 }
        #expect(recorded.map(\.0) == ["mcp__github__search_issues", "mcp__github__search_issues", "plain_tool"])
        #expect(recorded[0].1 == ["query": "bug", "repo": "x/y"])
        #expect(recorded[2].1 == [:])
        #expect(r.toolCallCount == 3)
    }

    @Test func toolErrorsReject() async {
        let context = makeContext(callTool: { _, _ in .error("rate limited") })
        let r = await QuickJSRunner().run("""
            try { await tools.plain_tool({}); } catch (e) { return [e.name, e.message]; }
            """, context: context, hostTools: Self.specs)
        #expect(r.value == ["ToolError", "rate limited"])
    }

    @Test func concurrencyAndCallLimits() async {
        let state = Mutex((inFlight: 0, peak: 0, total: 0))
        let context = makeContext(callTool: { _, _ in
            state.withLock { $0.inFlight += 1; $0.total += 1; $0.peak = max($0.peak, $0.inFlight) }
            try await Task.sleep(for: .milliseconds(20))
            state.withLock { $0.inFlight -= 1 }
            return .text("1")
        })
        let r = await QuickJSRunner().run("""
            const results = await Promise.allSettled(Array.from({ length: 30 }, () => tools.plain_tool()));
            return results.map(r => r.status === 'fulfilled' ? r.value : r.reason.name);
            """, context: context, hostTools: Self.specs)
        #expect(r.error == nil)
        let values = r.value?.arrayValue ?? []
        #expect(values.filter { $0 == 1 }.count == 25)
        #expect(values.filter { $0 == "RangeError" }.count == 5)
        let s = state.withLock { $0 }
        #expect(s.peak == 4)
        #expect(s.total == 25)
    }

    @Test func toolsObjectIsEmptyWithoutHostTools() async {
        let r = await QuickJSRunner().run("return Object.keys(tools)", context: makeContext())
        #expect(r.value == [])
    }

    @Test func descriptionListsSignatures() {
        let tool = RunJavaScriptTool(runner: QuickJSRunner(), hostTools: Self.specs)
        let d = tool.spec.description
        #expect(d.contains("tools.github.search_issues({query, repo?}) — Search issues."))
        #expect(d.contains("tools.plain_tool() — Returns text."))
        #expect(!d.contains("More detail."))
        #expect(RunJavaScriptTool.accessor("mcp__my-server__do.it") == #"tools["my-server"]["do.it"]"#)
        let bare = RunJavaScriptTool(runner: QuickJSRunner()).spec.description
        #expect(!bare.contains("Host tools"))
        #expect(bare.contains("fetch("))
    }
}
