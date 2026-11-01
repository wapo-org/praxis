import Foundation
import Testing
import AgentCore
import AgentTestSupport
import Synchronization
@testable import AgentProviders

@Suite struct ErrorMappingTests {
    private func streamError(_ reply: ScriptedTransport.Reply, flavor: ProviderFlavor = .anthropicMessages) async -> ProviderError? {
        let transport = ScriptedTransport(replies: [reply])
        let provider = ProviderFactory.make(flavor == .anthropicMessages ? anthropicEndpoint() : openAIEndpoint(), transport: transport)
        let (_, error) = await collectUntilError(provider.stream(request([.user("hi")])))
        return error as? ProviderError
    }

    @Test func rateLimitHonoursRetryAfter() async throws {
        let body = #"{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}"#
        let e = try #require(await streamError(.json(body, status: 429, headers: ["Retry-After": "7"])))
        #expect(e == .http(status: 429, message: "Number of request tokens has exceeded your per-minute rate limit", retryAfter: .seconds(7)))
        #expect(e.isRetryable)
        #expect(e.retryAfter == .seconds(7))
    }

    @Test func authenticationErrorBodyIsSurfaced() async throws {
        let anthropic = #"{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_1"}"#
        let a = try #require(await streamError(.json(anthropic, status: 401)))
        #expect(a == .http(status: 401, message: "invalid x-api-key", retryAfter: nil))
        #expect(!a.isRetryable)

        let openAI = #"{"error":{"message":"Incorrect API key provided: sk-test-****6789.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}"#
        let o = try #require(await streamError(.json(openAI, status: 401), flavor: .openAIChat))
        #expect(o == .http(status: 401, message: "Incorrect API key provided: sk-test-****6789.", retryAfter: nil))
    }

    @Test func overloadedIsRetryable() async throws {
        let body = #"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
        let e = try #require(await streamError(.json(body, status: 529)))
        #expect(e == .http(status: 529, message: "Overloaded", retryAfter: nil))
        #expect(e.isRetryable)
    }

    @Test func proxyBodiesWithoutJSON() async throws {
        let text = try #require(await streamError(ScriptedTransport.Reply(status: 502, body: Data("Bad Gateway\n".utf8))))
        #expect(text == .http(status: 502, message: "Bad Gateway", retryAfter: nil))
        let html = try #require(await streamError(ScriptedTransport.Reply(status: 503, body: Data("<html><body>down</body></html>".utf8))))
        #expect(html == .http(status: 503, message: "Service unavailable", retryAfter: nil))
        let detail = try #require(await streamError(.json(#"{"detail":"Model not loaded"}"#, status: 400), flavor: .openAIChat))
        #expect(detail == .http(status: 400, message: "Model not loaded", retryAfter: nil))
    }

    @Test func jsonErrorWithStatus200OnAStreamingRequest() async throws {
        let e = try #require(await streamError(.json(#"{"error":"model 'llama9' not found"}"#), flavor: .openAIChat))
        #expect(e == .stream(type: "error", message: "model 'llama9' not found"))
    }

    @Test func transportFailureAndBadURL() async throws {
        let transport = ScriptedTransport(replies: [])
        let (_, e1) = await collectUntilError(AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport).stream(request([.user("hi")])))
        #expect(e1 as? ProviderError == .network("ScriptedTransport ran out of replies"))

        var bad = anthropicEndpoint()
        bad.baseURL = try #require(URL(string: "ftp://example.com/v1"))
        let (_, e2) = await collectUntilError(AnthropicProvider(endpoint: bad, transport: transport).stream(request([.user("hi")])))
        guard case .invalidConfiguration? = e2 as? ProviderError else {
            Issue.record("expected invalidConfiguration, got \(String(describing: e2))")
            return
        }
        await #expect(throws: ProviderError.self) { try await OpenAIChatProvider(endpoint: bad, transport: transport).listModels() }
    }

    @Test func hugeNumericErrorCodesDoNotTrap() throws {
        for code in ["1e300", "-1e300"] {
            let json = try JSONValue(parsing: Data(#"{"error":{"code":\#(code),"message":"x"}}"#.utf8))
            let details = try #require(HTTPSupport.errorDetails(json))
            #expect(details.type == "error")
            #expect(details.message == "x")
        }
        let rate = try JSONValue(parsing: Data(#"{"error":{"code":429,"message":"slow down"}}"#.utf8))
        #expect(HTTPSupport.errorDetails(rate)?.type == "rate_limit_error")
    }

    @Test func listModelsMapsHTTPErrors() async throws {
        let transport = ScriptedTransport(replies: [.json(#"{"type":"error","error":{"type":"permission_error","message":"nope"}}"#, status: 403)])
        await #expect(throws: ProviderError.http(status: 403, message: "nope", retryAfter: nil)) {
            try await AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport).listModels()
        }
    }
}

/// A body that never ends on its own; records when it's torn down.
private final class HangingTransport: HTTPTransport, Sendable {
    private let state = Mutex(false)
    var terminated: Bool { state.withLock { $0 } }

    func stream(_ request: URLRequest) async throws -> HTTPStreamResponse {
        let body = AsyncThrowingStream<Data, Error> { c in
            c.yield(Data("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":3}}}\n\n".utf8))
            c.onTermination = { _ in self.state.withLock { $0 = true } }
        }
        return HTTPStreamResponse(head: HTTPResponseHead(status: 200, headers: ["content-type": "text/event-stream"]), body: body)
    }
}

@Suite struct CancellationTests {
    @Test func cancellingTheConsumerTearsDownTheBody() async throws {
        let transport = HangingTransport()
        let provider = AnthropicProvider(endpoint: anthropicEndpoint(), transport: transport)
        let (started, signal) = AsyncStream<Void>.makeStream()
        let task = Task {
            for try await _ in provider.stream(request([.user("hi")])) { signal.yield() }
        }
        for await _ in started { break }
        #expect(!transport.terminated)
        // A cancelled consumer must resume promptly even mid-silence (the
        // transport below yields once, then never again): bound the wait so
        // a hang fails instead of stalling the suite.
        let start = ContinuousClock.now
        task.cancel()
        _ = await task.result
        #expect(ContinuousClock.now - start < .seconds(5))
        for _ in 0..<200 where !transport.terminated { try await Task.sleep(for: .milliseconds(5)) }
        #expect(transport.terminated)
    }
}
