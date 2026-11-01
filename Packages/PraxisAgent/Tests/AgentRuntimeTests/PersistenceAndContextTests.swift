import Foundation
import Testing
import AgentCore
import AgentJS
import AgentTestSupport
@testable import AgentRuntime

/// A scratch root, removed on deinit.
private final class ScratchFolder {
    let url = FileManager.default.temporaryDirectory.appending(path: "runtime-scratch-\(UUID().uuidString)", directoryHint: .isDirectory)
    deinit { try? FileManager.default.removeItem(at: url) }
    func runtime() -> AgentRuntime {
        AgentRuntime(providerTransport: ScriptedTransport(replies: []), scratch: ScratchStore(root: url))
    }
}

@Suite struct PersistenceAndContextTests {
    private func call(_ runtime: AgentRuntime, _ setup: ConversationSetup, _ tool: String, _ arguments: String,
                      conversation: String = "c1") async -> [AgentEvent] {
        let provider = ScriptedProvider(steps: [ScriptedProvider.toolCalls([("t-\(UUID().uuidString.prefix(6))", tool, arguments)]),
                                                ScriptedProvider.text("done")])
        var run = request(setup)
        run.conversationID = conversation
        return await runtime.run(run, provider: provider).collect()
    }

    @Test func spilledOutputIsReadableAfterARelaunch() async throws {
        let folder = ScratchFolder()
        let first = folder.runtime()
        let setup = await first.prepare(includeJavaScript: false).setup
        await first.spills.spill(for: "c1").store(id: "old", text: String(repeating: "y", count: 100))

        // A new runtime over the same directory: what a relaunch sees.
        let relaunched = folder.runtime()
        let events = await call(relaunched, setup, "read_tool_output", #"{"id":"old","offset":95}"#)
        #expect(events.toolResults.first?.content.first?.text == "[characters 95–100 of 100]\nyyyyy")
        let elsewhere = await call(relaunched, setup, "read_tool_output", #"{"id":"old","offset":0}"#, conversation: "c2")
        #expect(elsewhere.toolResults.first?.isError == true)
    }

    @Test func jsKVStorePersistsPerConversationAndForgetDeletesEverything() async throws {
        let folder = ScratchFolder()
        let first = folder.runtime()
        let setup = await first.prepare().setup
        let set = await call(first, setup, "run_javascript", #"{"code":"kv.set('n', 41); return 1"}"#)
        #expect(set.toolResults.first?.isError == false)
        await first.spills.spill(for: "c1").store(id: "s", text: "spilled")

        let relaunched = folder.runtime()
        let read = await call(relaunched, setup, "run_javascript", #"{"code":"return kv.get('n') + 1"}"#)
        #expect(read.toolResults.first?.content.first?.text?.contains(#""result":42"#) == true)
        let other = await call(relaunched, setup, "run_javascript", #"{"code":"return kv.keys().length"}"#, conversation: "c2")
        #expect(other.toolResults.first?.content.first?.text?.contains(#""result":0"#) == true)

        await relaunched.forget(conversationID: "c1")
        #expect(!FileManager.default.fileExists(atPath: folder.url.appending(path: "c1").path))
        let again = folder.runtime()
        let gone = await call(again, setup, "run_javascript", #"{"code":"return kv.get('n') === undefined"}"#)
        #expect(gone.toolResults.first?.content.first?.text?.contains(#""result":true"#) == true)
        #expect(await again.spills.spill(for: "c1").length(id: "s") == nil)
    }

    @Test func requestCarriesWindowAndCompactionIntoTheLoop() async throws {
        let setup = await makeRuntime().prepare(includeJavaScript: false).setup
        let record = ContextCompaction(summary: "S", coveredMessages: 1, fingerprint: "f", model: "m")
        var run = request(setup)
        run.contextWindow = 50_000
        run.compaction = record
        let config = AgentRuntime.configuration(run, capabilities: Capabilities())
        #expect(config.context.contextWindow == 50_000)
        #expect(config.compaction == record)
    }

    @Test func compactedRunsKeepTheFrozenPrefix() async throws {
        let runtime = makeRuntime()
        let setup = await runtime.prepare(includeJavaScript: false).setup
        var transcript: [Message] = []
        for i in 0..<6 {
            transcript.append(.user("q\(i) " + String(repeating: "word ", count: 800)))
            transcript.append(Message(role: .assistant, parts: [.text("a\(i) " + String(repeating: "word ", count: 800))]))
        }
        transcript.append(.user("latest"))
        var run = request(setup, effort: .low)
        run.transcript = transcript
        run.contextWindow = 20_000
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("SUMMARY"), ScriptedProvider.text("ok")])
        let events = await runtime.run(run, provider: provider).collect()
        #expect(events.outcome == .completed)
        let compacted = events.contains { if case .compaction(_, .finished) = $0 { return true }; return false }
        #expect(compacted)
        let main = try #require(provider.requests.last)
        #expect(main.system == setup.systemPrompt)
        #expect(main.tools == setup.toolSpecs)
    }
}
