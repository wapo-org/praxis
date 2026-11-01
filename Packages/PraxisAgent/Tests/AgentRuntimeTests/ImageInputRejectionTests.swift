import Foundation
import Testing
import AgentCore
import AgentProviders
import AgentTestSupport
@testable import AgentRuntime

/// A provider that turns down image input: the error family is recognized,
/// the run fails without retries, and the same transcript resent with
/// image input off carries placeholders instead of bytes.
@Suite struct ImageInputRejectionTests {
    /// OpenRouter's reply when no endpoint serving the model takes images:
    /// its documented error shape (`{"error":{"code","message"}}`, code =
    /// HTTP status; optional `metadata`), the same one its "No endpoints
    /// found that support tool use" 404 has. Message as in the user's report
    /// ("HTTP 404: No endpoints found that support image input").
    static let openRouter404 = #"{"error":{"message":"No endpoints found that support image input","code":404}}"#
    /// The same with fields OpenRouter sometimes adds around the error.
    static let openRouter404WithExtras = #"{"error":{"message":"No endpoints found that support image input","code":404,"metadata":{"provider_name":null}},"user_id":"user_2x0Example"}"#

    let photo = MediaData(mediaType: "image/png", data: testPNG(width: 40, height: 30), name: "IMG_7712.png")

    private func endpoint(vision: Bool) -> ProviderEndpoint {
        var endpoint = ProviderPreset.openRouterOpenAI.endpoint(apiKey: "sk-or")!
        endpoint.capabilities.vision = vision
        return endpoint
    }

    private func sse(_ text: String) -> ScriptedTransport.Reply {
        let chunk = JSONValue.object(["choices": [["index": 0, "delta": ["content": .string(text)]]]]).encodedString()
        let done = JSONValue.object(["choices": [["index": 0, "delta": [:], "finish_reason": "stop"]]]).encodedString()
        return .sse("data: \(chunk)\n\ndata: \(done)\n\ndata: [DONE]\n\n")
    }

    @Test(arguments: [
        "No endpoints found that support image input",
        "HTTP 404: No endpoints found that support image input",
        "Model inception/mercury-3 does not support image input",
        "This model doesn't support images.",
        "image input is not supported - hint: if this is unexpected, you may need to provide the mmproj",
        "Image input not supported for this model",
        "Qwen/Qwen3-8B is not a multimodal model",
        "At most 0 image(s) may be provided in one request.",
        "this model is missing data required for image input",
        "Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text`",
        "Invalid content type. image_url is only supported by certain models.",
        "Vision is not enabled for this model",
        "The model cannot process images",
    ])
    func recognizesTheFamily(_ message: String) {
        #expect(ImageReference.isImageInputRejection(message))
        #expect(ProviderError.http(status: 400, message: message, retryAfter: nil).isImageInputUnsupported)
    }

    @Test(arguments: [
        "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing",
        "No endpoints found matching your data policy",
        "Rate limit exceeded",
        "inception/mercury-3 is not a valid model ID",
        "Image URL could not be downloaded",
        "Prompt is too long",
    ])
    func leavesOtherErrorsAlone(_ message: String) {
        #expect(!ImageReference.isImageInputRejection(message))
    }

    @Test func rejectionsAreNotRetriedEvenAs5xx() {
        #expect(!ProviderError.http(status: 500, message: "image input is not supported", retryAfter: nil).isRetryable)
        #expect(!ProviderError.stream(type: "server_error", message: "does not support image input").isRetryable)
        #expect(ProviderError.http(status: 500, message: "Internal error", retryAfter: nil).isRetryable)
    }

    @Test func openRouters404FailsTheRunOnceAndTheTextOnlyResendCarriesPlaceholders() async throws {
        let transport = ScriptedTransport(replies: [.json(Self.openRouter404, status: 404), sse("I can't see it.")])
        let runtime = AgentRuntime(providerTransport: transport)
        let setup = await runtime.prepare(includeJavaScript: false, includeSkills: false).setup
        let transcript = [Message(role: .user, parts: [.image(photo), .text("What's on the screenshot?")])]
        #expect(ImageReference.containsImages(transcript))
        let run = RunRequest(conversationID: "c1", model: "inception/mercury-3", setup: setup, transcript: transcript,
                             mode: .auto, effort: .low, approvals: AutoApprove())

        let failed = await runtime.run(run, endpoint: endpoint(vision: true)).collect()
        #expect(failed.outcome == .failed("HTTP 404: No endpoints found that support image input"))
        #expect(failed.outcome?.isImageInputRejection == true)
        #expect(transport.requests.count == 1, "a rejection isn't retried as is")
        #expect(transport.requests[0].body.map { String(decoding: $0, as: UTF8.self) }?.contains("image_url") == true)

        // The resend: same transcript, image input off for the model.
        let retried = await runtime.run(run, endpoint: endpoint(vision: false)).collect()
        #expect(retried.outcome == .completed)
        let body = try #require(transport.requests.last?.json)
        let content = try #require(body["messages"]?.arrayValue?.last?["content"]?.stringValue)
        #expect(content.contains("[Image \(ImageReference.id(for: photo)) “IMG_7712.png” (image/png, 40×30"))
        #expect(content.contains("can't view images"))
        #expect(!body.encodedString().contains("image_url"))
    }

    /// Entries as OpenRouter's `GET /api/v1/models` lists them
    /// (`architecture.input_modalities`, October 2026).
    @Test func openRoutersListSaysMercuryIsTextOnly() async throws {
        let list = """
        {"data":[
          {"id":"inception/mercury-3","name":"Inception: Mercury 3","context_length":1000000,
           "architecture":{"modality":"text->text","input_modalities":["text"],"output_modalities":["text"],"tokenizer":"Other","instruct_type":null},
           "top_provider":{"context_length":1000000,"max_completion_tokens":131072,"is_moderated":false},
           "supported_parameters":["max_tokens","reasoning","tools","tool_choice"]},
          {"id":"moonshotai/kimi-k3.1-pro","name":"MoonshotAI: Kimi K3.1 Pro","context_length":1048576,
           "architecture":{"modality":"text+image+video->text","input_modalities":["text","image","video"],"output_modalities":["text"]},
           "top_provider":{"context_length":1048576,"max_completion_tokens":943718,"is_moderated":false}}
        ]}
        """
        let provider = OpenAIChatProvider(endpoint: endpoint(vision: true), transport: ScriptedTransport(replies: [.json(list)]))
        let models = try await provider.listModels()
        #expect(models.map(\.id) == ["inception/mercury-3", "moonshotai/kimi-k3.1-pro"])
        #expect(models.map(\.supportsImages) == [false, true])
        #expect(models[0].displayName == "Inception: Mercury 3")
        #expect(models[0].maxOutputTokens == 131072)
    }

    @Test(arguments: [ImageInputRejectionTests.openRouter404, ImageInputRejectionTests.openRouter404WithExtras])
    func theRealBodyBecomesTheRunFailureAndIsRecognized(_ body: String) async throws {
        let transport = ScriptedTransport(replies: [.json(body, status: 404)])
        let provider = OpenAIChatProvider(endpoint: endpoint(vision: true), transport: transport)
        var thrown: ProviderError?
        do {
            for try await _ in provider.stream(ProviderRequest(model: "inception/mercury-3", system: "", messages: [.user("hi")],
                                                               tools: [], maxTokens: 100, effort: .low)) {}
        } catch let error as ProviderError {
            thrown = error
        }
        #expect(thrown == .http(status: 404, message: "No endpoints found that support image input", retryAfter: nil))
        #expect(thrown?.isImageInputUnsupported == true)
        #expect(thrown?.isRetryable == false)
    }

    @Test func addingTheReaderKeepsTheFrozenConnectorsAndOtherTools() async throws {
        let server = FakeMCPServer(tools: [FakeMCPServer.tool("search", readOnly: true)])
        let runtime = makeRuntime(connectors: Connectors([server.client()]))
        let plain = await runtime.prepare(mcpServerIDs: ["s1"]).setup
        #expect(!plain.offersImageReader)
        let listed = server.transport.requests.count

        let upgraded = await runtime.addingImageReader(to: plain)
        #expect(upgraded.offersImageReader)
        #expect(upgraded.mcpServers == plain.mcpServers, "the connector snapshot is reused, not listed again")
        #expect(server.transport.requests.count == listed)
        #expect(upgraded.toolSpecs.filter { $0.name != ImageReference.lookToolName } == plain.toolSpecs)
        #expect(upgraded.systemPrompt.contains("look_at_image"))
        #expect(upgraded.skillNames == plain.skillNames)
        #expect(await runtime.addingImageReader(to: upgraded) == upgraded, "idempotent")
    }

    @Test func rejectedFirstRequestThenResendWithTheReaderOffered() async throws {
        // What the app does for a conversation frozen without the tool whose
        // first request was turned down: gain the tool, resend as placeholders.
        let transport = ScriptedTransport(replies: [.json(Self.openRouter404, status: 404), sse("It's a screenshot of a list.")])
        let runtime = AgentRuntime(providerTransport: transport)
        let frozen = await runtime.prepare(includeJavaScript: false, includeSkills: false).setup
        let transcript = [Message(role: .user, parts: [.image(photo), .text("What's on the screenshot?")])]
        func run(_ setup: ConversationSetup) -> RunRequest {
            RunRequest(conversationID: "c1", model: "inception/mercury-3", setup: setup, transcript: transcript,
                       mode: .auto, effort: .low, approvals: AutoApprove())
        }
        let failed = await runtime.run(run(frozen), endpoint: endpoint(vision: true)).collect()
        #expect(failed.outcome?.isImageInputRejection == true)
        #expect(failed.outcome == .failed("HTTP 404: No endpoints found that support image input"))
        #expect(!failed.contains { if case .usage = $0 { return true }; return false }, "nothing was answered")

        let upgraded = await runtime.addingImageReader(to: frozen)
        let retried = await runtime.run(run(upgraded), endpoint: endpoint(vision: false)).collect()
        #expect(retried.outcome == .completed)
        let body = try #require(transport.requests.last?.json)
        #expect(body["tools"]?.arrayValue?.contains { $0["function"]?["name"] == "look_at_image" } == true)
        let content = try #require(body["messages"]?.arrayValue?.last?["content"]?.stringValue)
        #expect(content.contains("Call look_at_image with image_id \"\(ImageReference.id(for: photo))\""))
        #expect(!body.encodedString().contains("image_url"))
        #expect(body["messages"]?.arrayValue?.first?["content"]?.stringValue?.contains("look_at_image") == true,
                "the system prompt names the tool")
    }
}
