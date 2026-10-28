import Foundation
import Testing
import AgentCore
@testable import AgentJS

@Suite struct RunnerTests {
    let runner = QuickJSRunner()

    @Test func returnsValueAsJSON() async {
        let r = await runner.run("const x = 2;\nreturn { b: x * 21, a: [1, 'two', null, true] };", context: makeContext())
        #expect(r.error == nil)
        // Key order of the script survives.
        #expect(r.resultJSON == #"{"b":42,"a":[1,"two",null,true]}"#)
        #expect(r.truncated == false)
    }

    @Test func undefinedResultIsNil() async {
        let r = await runner.run("let a = 1;", context: makeContext())
        #expect(r.error == nil)
        #expect(r.resultJSON == nil)
    }

    @Test func topLevelAwaitAndNonJSONValues() async {
        let r = await runner.run("""
            const v = await Promise.resolve(5);
            return { v, big: 10n, nan: NaN, map: new Map([['k', 1]]), set: new Set([1, 2]), bytes: new Uint8Array([1, 2]), fn() {} };
            """, context: makeContext())
        #expect(r.error == nil)
        #expect(r.value == ["v": 5, "big": "10", "nan": "NaN", "map": ["k": 1], "set": [1, 2], "bytes": [1, 2], "fn": "[Function: fn]"])
    }

    @Test func consoleIsCapturedAndStreamed() async {
        let log = EmitLog()
        let r = await runner.run("""
            console.log('hello', 42, { a: 1, nested: { deep: [1, 2] } });
            console.warn('careful %s', 'now');
            console.error(new Error('bad'));
            return 1;
            """, context: makeContext(log: log))
        #expect(r.error == nil)
        #expect(r.console.map(\.level) == [.log, .warn, .error])
        #expect(r.console[0].text == "hello 42 { a: 1, nested: { deep: [ 1, 2 ] } }")
        #expect(r.console[1].text == "careful now")
        #expect(r.console[2].text.hasPrefix("Error: bad"))
        #expect(log.outputLines.first == "hello 42 { a: 1, nested: { deep: [ 1, 2 ] } }")
        #expect(log.outputLines.contains("careful now"))
    }

    @Test func syntaxErrorReportsUserLine() async {
        let r = await runner.run("const a = 1;\nconst b = ;\nreturn a;", context: makeContext())
        let e = try! #require(r.error)
        #expect(e.kind == .syntax)
        #expect(e.name == "SyntaxError")
        #expect(e.line == 2)
    }

    @Test func thrownErrorHasNameMessageAndLine() async {
        let r = await runner.run("const x = 1;\n\nthrow new TypeError('boom ' + x);", context: makeContext())
        let e = try! #require(r.error)
        #expect(e.kind == .thrown)
        #expect(e.name == "TypeError")
        #expect(e.message == "boom 1")
        #expect(e.line == 3)
        #expect(e.stack?.contains("code.js:3") == true)
    }

    @Test func asyncRejectionAfterAwait() async {
        let r = await runner.run("await null;\nfunction f() { throw new RangeError('later'); }\nf();", context: makeContext())
        let e = try! #require(r.error)
        #expect(e.kind == .thrown)
        #expect(e.name == "RangeError")
        #expect(e.line == 2)
    }

    @Test func thrownNonErrorValue() async {
        let r = await runner.run("throw 'plain string';", context: makeContext())
        #expect(r.error?.kind == .thrown)
        #expect(r.error?.message == "plain string")
    }

    @Test func infiniteLoopTimesOutQuickly() async {
        let (r, elapsed) = await measure {
            await runner.run("while (true) {}", options: JSRunOptions(timeout: .milliseconds(200)), context: makeContext())
        }
        #expect(r.error?.kind == .timeout)
        #expect(elapsed < .seconds(2))
        // The runner is still usable.
        #expect(await runner.run("return 1", context: makeContext()).resultJSON == "1")
    }

    @Test func busyLoopExhaustsCPUBudget() async {
        let r = await runner.run("for (;;) { try { Math.random(); } catch {} }",
                                 options: JSRunOptions(timeout: .seconds(10), cpuBudget: .milliseconds(150)), context: makeContext())
        #expect(r.error?.kind == .cpuBudget)
    }

    @Test func catchingTheInterruptDoesNotHelp() async {
        let r = await runner.run("while (true) { try { while (true) {} } catch (e) {} }",
                                 options: JSRunOptions(timeout: .milliseconds(200)), context: makeContext())
        #expect(r.error?.kind == .timeout)
    }

    @Test func taskCancellationStopsABusyLoop() async {
        let runner = self.runner
        let task = Task { await runner.run("while (true) {}", options: JSRunOptions(timeout: .seconds(30)), context: makeContext()) }
        try? await Task.sleep(for: .milliseconds(100))
        let (r, elapsed) = await measure {
            task.cancel()
            return await task.value
        }
        #expect(r.error?.kind == .cancelled)
        #expect(elapsed < .seconds(1))
    }

    @Test func taskCancellationStopsAWait() async {
        let runner = self.runner
        let task = Task {
            await runner.run("await new Promise(r => setTimeout(r, 20000)); return 1", options: JSRunOptions(timeout: .seconds(30)),
                             context: makeContext())
        }
        try? await Task.sleep(for: .milliseconds(100))
        task.cancel()
        let (r, elapsed) = await measure { await task.value }
        #expect(r.error?.kind == .cancelled)
        #expect(elapsed < .seconds(1))
    }

    @Test func memoryBombIsStoppedAndRunnerRecovers() async {
        let runner = QuickJSRunner(configuration: .init(memoryLimit: 32 << 20))
        let r = await runner.run("const a = []; while (true) a.push('x'.repeat(1 << 20) + a.length);", context: makeContext())
        #expect(r.error?.kind == .outOfMemory)
        let caught = await runner.run("""
            try { const a = []; while (true) a.push(new Array(1 << 20).fill(1)); } catch (e) {}
            return 'survived';
            """, context: makeContext())
        #expect(caught.error?.kind == .outOfMemory)
        let ok = await runner.run("return [1, 2, 3].map(x => x * 2)", context: makeContext())
        #expect(ok.resultJSON == "[2,4,6]")
    }

    @Test func deepRecursionIsAStackOverflow() async {
        let r = await runner.run("function f(n) { return f(n + 1) + 1; }\nreturn f(0);", context: makeContext())
        #expect(r.error?.kind == .stackOverflow)
        #expect(r.error?.name == "RangeError")
        let ok = await runner.run("function f(n) { return n === 0 ? 0 : 1 + f(n - 1); }\nreturn f(200);", context: makeContext())
        #expect(ok.resultJSON == "200")
    }

    @Test func timersWork() async {
        let (r, elapsed) = await measure {
            await runner.run("""
                const t0 = performance.now();
                await new Promise(r => setTimeout(r, 10));
                const order = [];
                setTimeout(() => order.push('b'), 5);
                setTimeout(() => order.push('a'), 0);
                const cancelled = setTimeout(() => order.push('never'), 1);
                clearTimeout(cancelled);
                let ticks = 0;
                await new Promise(resolve => {
                  const id = setInterval(() => { if (++ticks === 3) { clearInterval(id); resolve(); } }, 2);
                });
                queueMicrotask(() => order.push('micro'));
                await null;
                return { order, ticks, waited: performance.now() - t0 >= 10 };
                """, context: makeContext())
        }
        #expect(r.error == nil)
        #expect(r.value == ["order": ["a", "b", "micro"], "ticks": 3, "waited": true])
        #expect(elapsed < .seconds(2))
    }

    @Test func promiseNothingCanSettleFailsFast() async {
        let (r, elapsed) = await measure { await runner.run("await new Promise(() => {});", context: makeContext()) }
        #expect(r.error?.kind == .unsettled)
        #expect(elapsed < .seconds(1))
    }

    @Test func longTimerHitsTheWallTimeout() async {
        let r = await runner.run("await new Promise(r => setTimeout(r, 60000));", options: JSRunOptions(timeout: .milliseconds(150)),
                                 context: makeContext())
        #expect(r.error?.kind == .timeout)
    }

    @Test func unhandledRejectionsAreLogged() async {
        let r = await runner.run("Promise.reject(new Error('lost')); await null; return 1;", context: makeContext())
        #expect(r.resultJSON == "1")
        #expect(r.console.contains { $0.level == .error && $0.text.contains("Uncaught (in promise) Error: lost") })
    }

    @Test func webGlobals() async {
        let r = await runner.run("""
            const bytes = new TextEncoder().encode('héllo €');
            const back = new TextDecoder().decode(bytes);
            const u = new URL('/a/b?x=1&y=two#frag', 'https://Example.com:443/base');
            u.searchParams.append('z', 'a b');
            const clone = structuredClone({ d: new Date(0), m: new Map([[1, { k: 'v' }]]) });
            const rnd = crypto.getRandomValues(new Uint8Array(8));
            return {
              len: bytes.length, back, b64: btoa('hi!'), unb64: atob('aGkh'),
              href: u.href, host: u.host, path: u.pathname, q: u.searchParams.get('y'),
              cloned: clone.m.get(1).k, date: clone.d instanceof Date,
              uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()),
              rnd: rnd.length, hasRequire: typeof require, hasHost: typeof __host,
              params: new URLSearchParams({ a: '1', b: 'x y' }).toString(),
            };
            """, context: makeContext())
        #expect(r.error == nil)
        #expect(r.value == [
            "len": 10, "back": "héllo €", "b64": "aGkh", "unb64": "hi!",
            "href": "https://example.com/a/b?x=1&y=two&z=a+b#frag", "host": "example.com", "path": "/a/b", "q": "two",
            "cloned": "v", "date": true, "uuid": true, "rnd": 8, "hasRequire": "undefined", "hasHost": "undefined",
            "params": "a=1&b=x+y",
        ])
    }

    @Test func globalsDoNotLeakBetweenRuns() async {
        _ = await runner.run("globalThis.leak = 1; return 1", context: makeContext())
        let r = await runner.run("return typeof leak", context: makeContext())
        #expect(r.resultJSON == #""undefined""#)
    }

    @Test func concurrentRunsAreIsolated() async {
        let runner = self.runner
        async let a = runner.run("globalThis.who = 'a'; await new Promise(r => setTimeout(r, 30)); return who;", context: makeContext("a"))
        async let b = runner.run("globalThis.who = 'b'; await new Promise(r => setTimeout(r, 10)); return who;", context: makeContext("b"))
        let (ra, rb) = await (a, b)
        #expect(ra.resultJSON == #""a""#)
        #expect(rb.resultJSON == #""b""#)
    }

    @Test func consoleIsCapped() async {
        let log = EmitLog()
        let r = await runner.run("for (let i = 0; i < 500; i++) console.log('line ' + i); return 'done';", context: makeContext(log: log))
        #expect(r.console.count == 200)
        #expect(r.droppedConsoleLines == 300)
        #expect(r.truncated)
        #expect(log.outputLines.last?.contains("300 more console lines") == true)
    }

    @Test func longStringsAndResultsAreCut() async {
        let nested = await runner.run("return { s: 'x'.repeat(10000) };", context: makeContext())
        #expect(nested.truncated)
        let s = nested.value?["s"]?.stringValue ?? ""
        #expect(s.hasPrefix(String(repeating: "x", count: 4096)) && s.contains("truncated"))

        let big = await runner.run("return Array.from({ length: 5000 }, (_, i) => ({ i, pad: 'p'.repeat(20) }));", context: makeContext())
        #expect(big.resultTruncated)
        #expect(big.resultJSON!.utf8.count <= 32 << 10)
        #expect(big.value?.stringValue?.contains("[truncated") == true)
    }
}
