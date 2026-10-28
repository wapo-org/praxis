import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentJS

@Suite struct RunJavaScriptToolTests {
    let tool = RunJavaScriptTool(runner: QuickJSRunner())

    private func run(_ code: String, timeoutMs: Int? = nil) async throws -> (ToolOutput, JSONValue) {
        var args: [String: JSONValue] = ["code": .string(code)]
        if let timeoutMs { args["timeout_ms"] = .number(Double(timeoutMs)) }
        let output = try await tool.execute(ToolInvocation(id: "t1", name: RunJavaScriptTool.name, arguments: .object(args)),
                                            context: makeContext())
        return (output, try JSONValue(parsing: output.text))
    }

    @Test func specAndTraits() {
        #expect(tool.spec.name == "run_javascript")
        #expect(tool.traits == [.sandboxed, .openWorld])
        #expect(tool.source == .javascript)
        let p = tool.presentation(for: [:])
        #expect(p.category == .command && p.runningTitle == "Running code…" && p.finishedTitle == "Ran code")
        #expect(tool.spec.inputSchema["required"] == ["code"])
    }

    @Test func successOutput() async throws {
        let (output, json) = try await run("console.log('hi'); return { answer: 42 };")
        #expect(output.isError == false)
        #expect(json["console"] == [["level": "log", "text": "hi"]])
        #expect(json["result"] == ["answer": 42])
        #expect(json["error"] == nil)
        #expect(json["truncated"] == false)
        #expect(json["ms"]?.doubleValue != nil)
        #expect(output.text.hasPrefix(#"{"console":[{"level":"log","text":"hi"}],"result":{"answer":42},"#))
    }

    @Test func errorOutput() async throws {
        let (output, json) = try await run("\nnull.x;")
        #expect(output.isError)
        #expect(json["error"]?["name"] == "TypeError")
        #expect(json["error"]?["line"] == 2)
        #expect(output.summary?.hasPrefix("Code failed: TypeError") == true)
    }

    @Test func timeoutIsClampedAndReported() async throws {
        let ((output, json), elapsed) = try await measure { try await run("while (true) {}", timeoutMs: 100) }
        #expect(output.isError)
        #expect(json["error"]?["name"] == "TimeoutError")
        #expect(output.summary == "Code timed out after 100 ms")
        #expect(elapsed < .seconds(2))
    }

    @Test func missingCode() async throws {
        let output = try await tool.execute(ToolInvocation(id: "t", name: "run_javascript", arguments: [:]), context: makeContext())
        #expect(output.isError)
    }

    @Test func truncationIsFlagged() async throws {
        let (_, json) = try await run("for (let i = 0; i < 300; i++) console.log(i); return 'x'.repeat(5000);")
        #expect(json["truncated"] == true)
        #expect(json["console_dropped"] == 100)
        #expect(json["console"]?.arrayValue?.count == 200)
        // The top-level string fits the 32 KB result cap, so it is kept whole.
        #expect(json["result"]?.stringValue?.count == 5000)
    }
}

@Suite struct AgentLoopIntegrationTests {
    private func config(_ mode: AgentMode = .auto) -> AgentRunConfiguration {
        AgentRunConfiguration(conversationID: "conv", model: "m", system: "sys", mode: mode, effort: .low)
    }

    @Test func modelRunsJavaScriptThroughTheLoop() async throws {
        let code = #"{"code": "console.log('step'); return [1, 2, 3].reduce((a, b) => a + b);"}"#
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("call1", "run_javascript", code)]),
            ScriptedProvider.text("The sum is 6."),
        ])
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([RunJavaScriptTool(runner: QuickJSRunner())]))
        let events = await loop.run(transcript: [.user("sum")], configuration: config()).collect()

        guard case .finished(.completed) = events.last else { Issue.record("run didn't complete: \(String(describing: events.last))"); return }
        let result = try #require(provider.requests[1].messages.last?.toolResults.first)
        #expect(result.isError == false)
        let json = try JSONValue(parsing: result.content.first?.text ?? "")
        #expect(json["result"] == 6)
        let progress = events.compactMap { if case .toolProgress(_, .output(let l)) = $0 { return l }; return nil }
        #expect(progress.contains(["step"]))
        let finished = events.compactMap { if case .toolFinished(_, let c) = $0 { return c }; return nil }
        #expect(finished.first?.summary == "Ran code")
    }

    @Test func codeModeCallsHostToolsThroughThePolicy() async throws {
        let search = ClosureTool(name: "mcp__github__search", description: "Search.", traits: [.readOnly],
                                 source: .mcp(serverID: "gh", serverName: "GitHub"),
                                 schema: ["type": "object", "properties": ["q": ["type": "string"]]]) { inv, _ in
            .text(#"{"hits":["\#(inv.arguments["q"]?.stringValue ?? "")"]}"#)
        }
        let js = RunJavaScriptTool(runner: QuickJSRunner(), hostTools: [search.spec])
        let code = #"{"code": "const r = await tools.github.search({ q: 'swift' }); return r.hits;"}"#
        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("call1", "run_javascript", code)]),
            ScriptedProvider.text("done"),
        ])
        let approver = RecordingApprover(.allowOnce)
        let loop = AgentLoop(provider: provider, tools: ToolRegistry([js, search]), approvals: approver)
        let events = await loop.run(transcript: [.user("go")], configuration: config()).collect()

        let result = try #require(provider.requests[1].messages.last?.toolResults.first)
        let json = try JSONValue(parsing: result.content.first?.text ?? "")
        #expect(json["result"] == ["swift"], "\(result.content.first?.text ?? "")")
        let traces = events.compactMap { if case .toolProgress(_, .trace(.api, let t)) = $0 { return t }; return nil }
        #expect(traces.contains { $0.hasPrefix("mcp__github__search(") })
    }
}
