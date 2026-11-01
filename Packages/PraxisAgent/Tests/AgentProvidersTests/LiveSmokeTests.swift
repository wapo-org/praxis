import Foundation
import Testing
import AgentCore
@testable import AgentProviders

/// Real network calls, skipped unless a key is in the environment:
/// `PRAXIS_LIVE_ANTHROPIC_KEY` / `PRAXIS_LIVE_OPENAI_KEY` (models via
/// `PRAXIS_LIVE_ANTHROPIC_MODEL` / `PRAXIS_LIVE_OPENAI_MODEL`, base URLs
/// via `PRAXIS_LIVE_ANTHROPIC_BASE_URL` / `PRAXIS_LIVE_OPENAI_BASE_URL`).
/// Each test spends a few hundred tokens.
@Suite(.serialized) struct LiveSmokeTests {
    static let env = ProcessInfo.processInfo.environment

    private static func endpoint(_ preset: ProviderPreset, keyVar: String, urlVar: String) -> ProviderEndpoint? {
        guard let key = env[keyVar], !key.isEmpty else { return nil }
        return preset.endpoint(apiKey: key, baseURL: env[urlVar].flatMap(URL.init(string:)))
    }

    private func run(_ endpoint: ProviderEndpoint, model: String) async throws {
        let probe = await ProviderProbe().test(endpoint, model: model)
        for check in probe.checks { print("[live \(endpoint.flavor.rawValue)] \(check.title): \(check.status) — \(check.detail)") }
        #expect(probe.isUsable)
        #expect(probe.checks.first { $0.id == ProbeReport.tools }?.status == .passed)

        let provider = ProviderFactory.make(endpoint)
        var text = ""
        var final: ProviderResponse?
        for try await event in provider.stream(ProviderRequest(model: model, system: "Be brief.", messages: [.user("Reply with the single word: pong")],
                                                                tools: [], maxTokens: 1024, effort: .low)) {
            if case .textDelta(_, let t) = event { text += t }
            if case .completed(let r) = event { final = r }
        }
        let r = try #require(final)
        #expect(text.lowercased().contains("pong"))
        #expect(r.stopReason == .endTurn)
        #expect(r.message.raw != nil)
    }

    @Test(.enabled(if: env["PRAXIS_LIVE_ANTHROPIC_KEY"]?.isEmpty == false))
    func anthropic() async throws {
        let e = try #require(Self.endpoint(.anthropic, keyVar: "PRAXIS_LIVE_ANTHROPIC_KEY", urlVar: "PRAXIS_LIVE_ANTHROPIC_BASE_URL"))
        try await run(e, model: Self.env["PRAXIS_LIVE_ANTHROPIC_MODEL"] ?? "claude-opus-5-5")
    }

    @Test(.enabled(if: env["PRAXIS_LIVE_OPENAI_KEY"]?.isEmpty == false))
    func openAI() async throws {
        let e = try #require(Self.endpoint(.openAI, keyVar: "PRAXIS_LIVE_OPENAI_KEY", urlVar: "PRAXIS_LIVE_OPENAI_BASE_URL"))
        try await run(e, model: Self.env["PRAXIS_LIVE_OPENAI_MODEL"] ?? "gpt-5-mini")
    }
}
