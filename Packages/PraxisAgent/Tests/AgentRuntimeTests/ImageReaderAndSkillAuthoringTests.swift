import Foundation
import Synchronization
import Testing
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers
import AgentCore
import AgentProviders
import AgentSkills
import AgentTestSupport
@testable import AgentRuntime

/// A real PNG: left half red, right half blue.
func testPNG(width: Int = 400, height: Int = 200) -> Data {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: width / 2, height: height))
    context.setFillColor(red: 0, green: 0, blue: 1, alpha: 1)
    context.fill(CGRect(x: width / 2, y: 0, width: width - width / 2, height: height))
    let out = NSMutableData()
    let destination = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    CGImageDestinationFinalize(destination)
    return out as Data
}

private func pixelSize(_ data: Data) -> (Int, Int)? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let p = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let w = p[kCGImagePropertyPixelWidth] as? Int, let h = p[kCGImagePropertyPixelHeight] as? Int else { return nil }
    return (w, h)
}

private func openAISSE(_ text: String) -> ScriptedTransport.Reply {
    let chunk = JSONValue.object(["choices": [["index": 0, "delta": ["content": .string(text)]]]]).encodedString()
    let done = JSONValue.object(["choices": [["index": 0, "delta": [:], "finish_reason": "stop"]]]).encodedString()
    return .sse("data: \(chunk)\n\ndata: \(done)\n\ndata: [DONE]\n\n")
}

@Suite struct ImageReaderTests {
    let photo = MediaData(mediaType: "image/png", data: testPNG(), name: "photo.png")

    private func reader() -> ImageReader {
        ImageReader(endpoint: ProviderPreset.openAI.endpoint(apiKey: "sk-reader")!, model: "vision-mini", displayName: "Reader · vision-mini")
    }

    private func transcript(_ text: String = "What colour is on the left?") -> [Message] {
        [Message(role: .user, parts: [.image(photo), .text(text)])]
    }

    @Test func toolIsFrozenOnlyWhenAsked() async {
        let runtime = makeRuntime()
        let plain = await runtime.prepare().setup
        #expect(!plain.toolSpecs.map(\.name).contains("look_at_image"))
        #expect(!plain.systemPrompt.contains("look_at_image"))
        let blind = await runtime.prepare(includeImageReader: true).setup
        #expect(blind.toolSpecs.map(\.name).contains("look_at_image"))
        // Worded so a model that turns out to see images isn't told it's blind.
        #expect(blind.systemPrompt.contains("An image you can't see arrives as an [Image img_…] placeholder"))
        #expect(!blind.systemPrompt.contains("You can't see images."))
    }

    @Test func asksTheReaderWithTheImageAndCrops() async throws {
        let readerTransport = ScriptedTransport(replies: [openAISSE("The left half is red."), openAISSE("Blue.")])
        let runtime = AgentRuntime(providerTransport: readerTransport)
        let setup = await runtime.prepare(includeImageReader: true).setup
        let id = ImageReference.id(for: photo)
        let provider = ScriptedProvider(capabilities: Capabilities(vision: false), steps: [
            ScriptedProvider.toolCalls([("t1", "look_at_image", #"{"image_id":"\#(id)","question":"Colour on the left?"}"#)]),
            ScriptedProvider.toolCalls([("t2", "look_at_image", #"{"image_id":"\#(id)","question":"And here?","region":{"x":0.5,"y":0,"width":0.5,"height":1}}"#)]),
            ScriptedProvider.text("Red and blue."),
        ])
        let run = RunRequest(conversationID: "c1", model: "blind", setup: setup, transcript: transcript(), mode: .ask,
                             effort: .low, approvals: RecordingApprover(.deny), imageReader: .ready(reader()))
        let events = await runtime.run(run, provider: provider).collect()
        #expect(events.outcome == .completed)
        let results = events.toolResults
        #expect(results.count == 2)
        #expect(results.allSatisfy { !$0.isError }) // allowed even in Ask mode
        #expect(results[0].content.first?.text?.contains("The left half is red.") == true)
        #expect(results[0].content.first?.text?.contains("answered by Reader · vision-mini") == true)
        #expect(results[1].content.first?.text?.contains("region x 0.50") == true)

        // The reader got the image (and only the question), with vision on.
        let first = try #require(readerTransport.requests.first?.json)
        #expect(first["model"] == "vision-mini")
        #expect(readerTransport.requests.first?.headers["Authorization"] == "Bearer sk-reader")
        let parts = try #require(first["messages"]?[1]?["content"]?.arrayValue)
        #expect(parts[0]["type"] == "image_url")
        #expect(parts[1]["text"] == "Colour on the left?")
        #expect(first["tools"] == nil)

        // The crop: the right half (200×200), scaled up to the 768 px minimum.
        let cropURL = try #require(readerTransport.requests[1].json?["messages"]?[1]?["content"]?[0]?["image_url"]?["url"]?.stringValue)
        let cropData = try #require(Data(base64Encoded: String(cropURL.split(separator: ",")[1])))
        let size = try #require(pixelSize(cropData))
        #expect(size.0 == 768 && size.1 == 768)
    }

    @Test func explainsSetupWhenNoReaderAndUnknownIDs() async throws {
        let runtime = makeRuntime()
        let setup = await runtime.prepare(includeImageReader: true).setup
        let id = ImageReference.id(for: photo)
        let provider = ScriptedProvider(capabilities: Capabilities(vision: false), steps: [
            ScriptedProvider.toolCalls([("t1", "look_at_image", #"{"image_id":"\#(id)","question":"What is it?"}"#),
                                        ("t2", "look_at_image", #"{"image_id":"img_000000000000","question":"?"}"#),
                                        ("t3", "look_at_image", #"{"image_id":"\#(id)","question":"?","region":{"x":2,"y":0,"width":1,"height":1}}"#)]),
            ScriptedProvider.text("ok"),
        ])
        let run = RunRequest(conversationID: "c1", model: "blind", setup: setup, transcript: transcript(), mode: .auto,
                             effort: .low, approvals: AutoApprove())
        let results = await runtime.run(run, provider: provider).collect().toolResults
        #expect(results.map(\.isError) == [true, true, true])
        #expect(results[0].content.first?.text?.contains("Settings → Image reading model") == true)
        #expect(results[1].content.first?.text?.contains(id) == true)
        #expect(results[2].content.first?.text?.contains("region") == true)
    }

    @Test func readerFailureIsReportedNotThrown() async throws {
        let transport = ScriptedTransport(replies: [.json(#"{"error":{"message":"Invalid API key"}}"#, status: 401)])
        let runtime = AgentRuntime(providerTransport: transport)
        let setup = await runtime.prepare(includeImageReader: true).setup
        let provider = ScriptedProvider(capabilities: Capabilities(vision: false), steps: [
            ScriptedProvider.toolCalls([("t1", "look_at_image", #"{"image_id":"\#(ImageReference.id(for: photo))","question":"?"}"#)]),
            ScriptedProvider.text("ok"),
        ])
        let run = RunRequest(conversationID: "c1", model: "blind", setup: setup, transcript: transcript(), mode: .auto,
                             effort: .low, approvals: AutoApprove(), imageReader: .ready(reader()))
        let result = try #require(await runtime.run(run, provider: provider).collect().toolResults.first)
        #expect(result.isError)
        #expect(result.content.first?.text?.contains("pick another image-reading model") == true)
    }

    /// The reader picked in Settings turns out to be text-only (OpenRouter's
    /// 404 for a model none of whose endpoints take images): the chat model
    /// is told plainly what to tell the user, and the app hears of it.
    @Test func aTextOnlyReaderIsExplainedAndReported() async throws {
        let transport = ScriptedTransport(replies: [
            .json(#"{"error":{"message":"No endpoints found that support image input","code":404}}"#, status: 404),
        ])
        let runtime = AgentRuntime(providerTransport: transport)
        let setup = await runtime.prepare(includeImageReader: true).setup
        let provider = ScriptedProvider(capabilities: Capabilities(vision: false), steps: [
            ScriptedProvider.toolCalls([("t1", "look_at_image", #"{"image_id":"\#(ImageReference.id(for: photo))","question":"?"}"#)]),
            ScriptedProvider.text("ok"),
        ])
        let reported = Mutex(0)
        var reader = reader()
        reader.onImagesRejected = { reported.withLock { $0 += 1 } }
        let run = RunRequest(conversationID: "c1", model: "blind", setup: setup, transcript: transcript(), mode: .auto,
                             effort: .low, approvals: AutoApprove(), imageReader: .ready(reader))
        let events = await runtime.run(run, provider: provider).collect()
        #expect(events.outcome == .completed, "the chat goes on; only the tool call failed")
        let result = try #require(events.toolResults.first)
        #expect(result.isError)
        let text = try #require(result.content.first?.text)
        #expect(text.contains("Reader · vision-mini) can't take images itself"))
        #expect(text.contains("Settings → Image reading model"))
        #expect(text.contains("No endpoints found that support image input"))
        #expect(reported.withLock { $0 } == 1)
        #expect(transport.requests.count == 1, "not retried")
    }

    @Test func oldSetupsDontGainTheTool() async throws {
        // A conversation frozen without the tool keeps exactly its specs, even
        // when a reader is configured later.
        let runtime = makeRuntime()
        let setup = await runtime.prepare().setup
        let provider = ScriptedProvider(steps: [ScriptedProvider.text("hi")])
        var run = request(setup)
        run.imageReader = .ready(reader())
        _ = await runtime.run(run, provider: provider).collect()
        #expect(provider.requests[0].tools.map(\.name) == setup.toolSpecs.map(\.name))
    }
}

@Suite struct SkillAuthoringRunTests {
    private let saveArgs = ##"{"name":"tidy-notes","description":"Tidies meeting notes. Use when asked to clean up notes.","instructions":"# Tidy\n\n1. Group by topic."}"##

    @Test func savedSkillLoadsInTheSameConversationAndJoinsNewCatalogs() async throws {
        let skills = SkillFolder(["alpha": "Alpha things."])
        let runtime = makeRuntime(skills: skills.store)
        let setup = await runtime.prepare().setup
        #expect(setup.toolSpecs.map(\.name).contains("save_skill"))

        let provider = ScriptedProvider(steps: [
            ScriptedProvider.toolCalls([("t1", "save_skill", saveArgs)]),
            ScriptedProvider.toolCalls([("t2", "load_skill", #"{"name":"tidy-notes"}"#)]),
            ScriptedProvider.text("done"),
        ])
        let events = await runtime.run(request(setup, mode: .auto), provider: provider).collect()
        let results = events.toolResults
        #expect(results.map(\.isError) == [false, false])
        #expect(results[1].content.first?.text?.contains("1. Group by topic.") == true)
        // The frozen prompt is untouched; the next turn announces the skill.
        #expect(provider.requests.allSatisfy { $0.system == setup.systemPrompt })
        let next = await runtime.userMessage(text: "more", mode: .auto, effort: .high, previous: events.committed, setup: setup)
        #expect(next.parts.contains { if case .note(let n) = $0 { return n.contains("tidy-notes") }; return false })

        let fresh = await runtime.prepare().setup
        #expect(fresh.skillNames == ["alpha", "tidy-notes"])
        #expect(fresh.systemPrompt.contains("- tidy-notes: Tidies meeting notes."))
        #expect(await skills.store.skill(named: "tidy-notes")?.source?.conversationID == "c1")
    }

    @Test(arguments: [AgentMode.ask, .plan])
    func refusedInReadOnlyModes(mode: AgentMode) async throws {
        let skills = SkillFolder()
        let runtime = makeRuntime(skills: skills.store)
        let setup = await runtime.prepare().setup
        let approver = RecordingApprover(.allowOnce)
        let provider = ScriptedProvider(steps: [ScriptedProvider.toolCalls([("t1", "save_skill", saveArgs)]), ScriptedProvider.text("ok")])
        let events = await runtime.run(request(setup, mode: mode, approvals: approver), provider: provider).collect()
        #expect(events.toolResults.first?.isError == true)
        #expect(approver.requests.isEmpty)
        #expect(await skills.store.skill(named: "tidy-notes") == nil)
    }

    @Test func buildModeAsksAndDenialSavesNothing() async throws {
        let skills = SkillFolder()
        let runtime = makeRuntime(skills: skills.store)
        let setup = await runtime.prepare().setup
        let approver = RecordingApprover(.deny)
        let provider = ScriptedProvider(steps: [ScriptedProvider.toolCalls([("t1", "save_skill", saveArgs)]), ScriptedProvider.text("ok")])
        _ = await runtime.run(request(setup, mode: .build, approvals: approver), provider: provider).collect()
        #expect(approver.requests.map(\.toolName) == ["save_skill"])
        #expect(approver.requests.first?.reason == "Saves a new skill on this device")
        #expect(await skills.store.skill(named: "tidy-notes") == nil)
    }
}
