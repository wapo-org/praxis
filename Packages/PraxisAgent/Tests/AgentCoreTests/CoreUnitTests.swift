import Foundation
import Testing
@testable import AgentCore
import AgentTestSupport

@Suite struct SSEParserTests {
    @Test func parsesEventsSplitAtEveryByte() {
        let raw = "event: message_start\ndata: {\"a\":1}\n\n: keep-alive\n\nevent: delta\r\ndata: line1\r\ndata: line2\r\n\r\ndata: tail"
        var parser = SSEParser()
        var events: [SSEEvent] = []
        for byte in Data(raw.utf8) { events += parser.feed(Data([byte])) }
        events += parser.finish()
        #expect(events == [
            SSEEvent(event: "message_start", data: "{\"a\":1}"),
            SSEEvent(event: "delta", data: "line1\nline2"),
            SSEEvent(event: nil, data: "tail"),
        ])
    }

    @Test func keepsMultibyteCharactersAcrossChunks() {
        let raw = Data("data: héllo ✓\n\n".utf8)
        var parser = SSEParser()
        var events: [SSEEvent] = []
        for i in stride(from: 0, to: raw.count, by: 3) {
            events += parser.feed(raw.subdata(in: i..<min(i + 3, raw.count)))
        }
        #expect(events.map(\.data) == ["héllo ✓"])
    }

    @Test func tracksLastEventID() {
        var parser = SSEParser()
        let events = parser.feed(Data("id: 7\ndata: a\n\ndata: b\n\n".utf8))
        #expect(events.map(\.id) == ["7", "7"])
    }
}

@Suite struct JSONValueTests {
    @Test func roundTripsDeterministically() throws {
        let v = try JSONValue(parsing: #"{"b": [1, 2.5, true, null], "a": "x"}"#)
        #expect(v.encodedString() == #"{"a":"x","b":[1,2.5,true,null]}"#)
        #expect(v["b"]?[0]?.intValue == 1)
    }

    @Test func emptyArgumentsParseAsEmptyObject() throws {
        #expect(try JSONValue(parsing: "  ") == .object([:]))
    }
}

@Suite struct ToolNameTests {
    @Test func sanitizesToCommonSubset() {
        #expect(ToolName.sanitize("github.search issues") == "github_search_issues")
        let long = ToolName.sanitize(String(repeating: "x", count: 100))
        #expect(long.count == 64)
        #expect(long != ToolName.sanitize(String(repeating: "x", count: 99)))
    }
}

@Suite struct ToolPolicyTests {
    let js = ClosureTool(name: "js", traits: [.sandboxed, .openWorld], source: .javascript) { _, _ in .text("") }
    let skill = ClosureTool(name: "load_skill", source: .skill) { _, _ in .text("") }
    let readMCP = ClosureTool(name: "r", traits: [.readOnly], source: .mcp(serverID: "s", serverName: "S")) { _, _ in .text("") }
    let writeMCP = ClosureTool(name: "w", traits: [.destructive], source: .mcp(serverID: "s", serverName: "S")) { _, _ in .text("") }
    let plainMCP = ClosureTool(name: "p", traits: [], source: .mcp(serverID: "s", serverName: "S")) { _, _ in .text("") }

    @Test func modeTable() {
        let trusted = ToolPolicy(trustedSources: ["mcp:s"])
        #expect(trusted.decide(js, mode: .ask) != .allow)
        for mode in [AgentMode.plan, .build, .auto] { #expect(trusted.decide(js, mode: mode) == .allow) }
        for mode in AgentMode.allCases { #expect(trusted.decide(skill, mode: mode) == .allow) }

        #expect(trusted.decide(readMCP, mode: .plan) == .allow)
        if case .refuse = trusted.decide(writeMCP, mode: .plan) {} else { Issue.record("plan must refuse writes") }
        if case .ask = trusted.decide(plainMCP, mode: .build) {} else { Issue.record("build asks for writes") }
        #expect(trusted.decide(plainMCP, mode: .auto) == .allow)
        if case .ask = trusted.decide(writeMCP, mode: .auto) {} else { Issue.record("auto asks for destructive") }
    }

    @Test func untrustedServerAnnotationsAreIgnored() {
        let policy = ToolPolicy()
        if case .refuse = policy.decide(readMCP, mode: .plan) {} else { Issue.record("untrusted read-only claim must not pass plan") }
        if case .ask = policy.decide(readMCP, mode: .auto) {} else { Issue.record("untrusted tools ask in auto") }
    }

    @Test func alwaysAllowIsRevokedBySchemaChange() {
        var policy = ToolPolicy(trustedSources: ["mcp:s"])
        policy.alwaysAllow.insert(ToolPolicy.alwaysAllowKey(for: writeMCP))
        #expect(policy.decide(writeMCP, mode: .auto) == .allow)
        let changed = ClosureTool(name: "w", description: "now different", traits: [.destructive],
                                  source: .mcp(serverID: "s", serverName: "S")) { _, _ in .text("") }
        if case .ask = policy.decide(changed, mode: .auto) {} else { Issue.record("changed tool must ask again") }
    }
}

@Suite struct CoalescerTests {
    @Test func mergesBurstsAndKeepsOrder() async {
        let (upstream, c) = AsyncStream<AgentEvent>.makeStream()
        for t in ["a", "b", "c"] { c.yield(.textDelta(blockID: "1", text: t)) }
        c.yield(.textFinished(blockID: "1"))
        c.yield(.toolProgress(id: "t", .output(["x"])))
        c.yield(.toolProgress(id: "t", .output(["y"])))
        c.yield(.finished(.completed))
        c.finish()
        let events = await AgentEventCoalescer.coalesce(upstream, interval: .seconds(10)).collect()
        #expect(events.count == 4)
        if case .textDelta(_, let text) = events[0] { #expect(text == "abc") } else { Issue.record("expected text") }
        if case .toolProgress(_, .output(let lines)) = events[2] { #expect(lines == ["x", "y"]) } else { Issue.record("expected output") }
    }

    /// A buffered delta goes out one interval later while the stream is
    /// still open (the timer runs only while something is pending).
    @Test func releasesPendingWithoutUpstreamEnding() async {
        let (upstream, c) = AsyncStream<AgentEvent>.makeStream()
        var output = AgentEventCoalescer.coalesce(upstream, interval: .milliseconds(20)).makeAsyncIterator()
        c.yield(.textDelta(blockID: "1", text: "a"))
        c.yield(.textDelta(blockID: "1", text: "b"))
        if case .textDelta(_, let text)? = await output.next() { #expect(text == "ab") } else { Issue.record("expected text") }
        c.yield(.textDelta(blockID: "1", text: "c"))
        if case .textDelta(_, let text)? = await output.next() { #expect(text == "c") } else { Issue.record("expected text") }
        c.finish()
        #expect(await output.next() == nil)
    }
}

@Suite struct HTTPHeadTests {
    @Test func parsesRetryAfter() {
        #expect(HTTPResponseHead(status: 429, headers: ["Retry-After": "2"]).retryAfter == .seconds(2))
        #expect(HTTPResponseHead(status: 429, headers: ["retry-after-ms": "1500"]).retryAfter == .milliseconds(1500))
    }
}
