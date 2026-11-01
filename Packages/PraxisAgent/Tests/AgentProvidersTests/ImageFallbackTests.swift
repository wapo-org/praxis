import Foundation
import Testing
import AgentCore
import AgentTestSupport
@testable import AgentProviders

@Suite struct ImageFallbackTests {
    let png = MediaData(mediaType: "image/png", data: Data([0x89, 0x50, 0x4E, 0x47]), name: "chart.png")
    let lookTool = ToolSpec(name: "look_at_image", description: "Look", inputSchema: ["type": "object"])

    private var blind: Capabilities {
        var caps = ProviderPreset.openAI.defaultCapabilities
        caps.vision = false
        return caps
    }

    @Test func placeholdersPointToTheLookToolWhenOffered() throws {
        let id = ImageReference.id(for: png)
        #expect(id.hasPrefix("img_") && id.count == 16)
        let messages = [Message(role: .user, parts: [.image(png), .text("What's this?")])]

        let openAI = OpenAIChatProvider(endpoint: openAIEndpoint(blind), transport: ScriptedTransport(replies: []))
        let body = try bodyJSON(openAI, request(messages, tools: [lookTool]))
        let content = try #require(body["messages"]?[1]?["content"]?.stringValue)
        #expect(content.contains("[Image \(id) “chart.png” (image/png, 4 B)"))
        #expect(content.contains("Call look_at_image with image_id \"\(id)\""))
        #expect(!body.encodedString().contains("image_url"))

        var anthropicCaps = ProviderPreset.anthropic.defaultCapabilities
        anthropicCaps.vision = false
        let anthropic = AnthropicProvider(endpoint: anthropicEndpoint(anthropicCaps), transport: ScriptedTransport(replies: []))
        let aBody = try bodyJSON(anthropic, request(messages, tools: [lookTool]))
        let first = try #require(aBody["messages"]?[0]?["content"]?[0]?["text"]?.stringValue)
        #expect(first.contains("Call look_at_image with image_id \"\(id)\""))
        #expect(!aBody.encodedString().contains("\"base64\""))

        // Same transcript, same bytes: placeholders never move the prefix.
        #expect(try bodyJSON(openAI, request(messages, tools: [lookTool])) == body)
    }

    @Test func toolResultImagesGetPlaceholdersToo() throws {
        let messages: [Message] = [
            .user("shoot"),
            Message(role: .assistant, parts: [.toolCall(ToolCall(id: "a", name: "screenshot", arguments: "{}"))]),
            Message(role: .user, parts: [.toolResult(ToolResult(callID: "a", toolName: "screenshot", content: [.text("ok"), .image(png)]))]),
        ]
        let openAI = OpenAIChatProvider(endpoint: openAIEndpoint(blind), transport: ScriptedTransport(replies: []))
        let body = try bodyJSON(openAI, request(messages, tools: [lookTool]))
        let tool = try #require(body["messages"]?[3]?["content"]?.stringValue)
        #expect(tool.contains(ImageReference.id(for: png)))
        #expect(tool.contains("look_at_image"))
    }

    @Test func visionModelsStillGetTheImage() throws {
        let messages = [Message(role: .user, parts: [.image(png), .text("What's this?")])]
        let openAI = OpenAIChatProvider(endpoint: openAIEndpoint(), transport: ScriptedTransport(replies: []))
        let body = try bodyJSON(openAI, request(messages, tools: [lookTool]))
        #expect(body.encodedString().contains("image_url"))
        #expect(!body.encodedString().contains("img_"))
    }

    @Test func modelListsReportImageInput() async throws {
        let openRouter = """
        {"data": [
          {"id": "vision", "architecture": {"input_modalities": ["text", "image"], "output_modalities": ["text"]}},
          {"id": "text-only", "architecture": {"input_modalities": ["text"], "modality": "text->text"}},
          {"id": "old-style", "architecture": {"modality": "text+image->text"}},
          {"id": "lmstudio", "capabilities": ["tool_use", "vision"]},
          {"id": "unknown"}
        ]}
        """
        let openAI = OpenAIChatProvider(endpoint: openAIEndpoint(), transport: ScriptedTransport(replies: [.json(openRouter)]))
        let models = try await openAI.listModels()
        #expect(models.map(\.supportsImages) == [true, false, true, true, nil])

        let anthropicList = """
        {"data": [
          {"id": "claude-x", "display_name": "Claude X", "capabilities": {"image_input": {"supported": true}}},
          {"id": "claude-text", "capabilities": {"image_input": {"supported": false}}},
          {"id": "plain"}
        ], "has_more": false}
        """
        let anthropic = AnthropicProvider(endpoint: anthropicEndpoint(), transport: ScriptedTransport(replies: [.json(anthropicList)]))
        #expect(try await anthropic.listModels().map(\.supportsImages) == [true, false, nil])

        // Old caches without the field still decode.
        let old = try JSONDecoder().decode(ModelInfo.self, from: Data(#"{"id":"m","displayName":"m"}"#.utf8))
        #expect(old.supportsImages == nil)
    }
}
