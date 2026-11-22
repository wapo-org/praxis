import Foundation
import UIKit
import AgentCore
import AgentProviders
import AgentMCP
import AgentRuntime

/// Adapts AgentRuntime to ChatEngine with single-retry capability fallbacks.
struct LiveChatEngine: ChatEngine {
    static let noProviderReason = "No model provider is set up."
    /// Backstop failure if host lacks data-sharing consent.
    static func noConsentReason(host: String) -> String {
        "Sharing this chat with \(host) hasn't been allowed. Send again to review what's shared."
    }

    let runtime: AgentRuntime
    let resolve: @Sendable (_ modelID: String) async -> ProviderSelection?
    var makeProvider: @Sendable (ProviderEndpoint, any HTTPTransport) -> any ModelProvider = { endpoint, transport in
        ProviderFactory.make(endpoint, transport: transport)
    }
    var attachments: AttachmentStore = .shared
    var instructions: String? = nil
    var usesBackgroundTasks = true
    /// App Review 5.1.2(i) gate checked before any data leaves the device.
    var mayShare: @Sendable (_ baseURL: URL) async -> Bool = { _ in true }
    var imageReader: @Sendable () async -> ImageReaderAccess = { .notConfigured }
    /// Resolves unknown model image support before sending images.
    var prepareForImages: @Sendable (_ modelID: String) async -> Void = { _ in }
    /// Persists image rejection so future turns send placeholders upfront.
    var onImagesRejected: @Sendable (ProviderSelection) async -> Void = { _ in }
    /// Persists tool rejection so future turns omit tools upfront.
    var onToolsRejected: @Sendable (ProviderSelection) async -> Void = { _ in }
    /// Persists effort rejection so future turns omit reasoning_effort.
    var onEffortRejected: @Sendable (ProviderSelection) async -> Void = { _ in }
    /// Persists rejected effort value to clamp future turns.
    var onEffortValueRejected: @Sendable (ProviderSelection, String) async -> Void = { _, _ in }

    var kind: EngineKind { .live }
    var buildsUserMessage: Bool { true }

    func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent> {
        AsyncStream(bufferingPolicy: .unbounded) { continuation in
            let task = Task {
                await play(request, continuation)
                continuation.finish()
            }
            let grace = usesBackgroundTasks ? BackgroundGrace(name: "Praxis run") { task.cancel() } : nil
            continuation.onTermination = { _ in
                task.cancel()
                grace?.end()
            }
        }
    }

    private func play(_ request: ChatRunRequest, _ out: AsyncStream<AgentEvent>.Continuation) async {
        guard var selection = await resolve(request.modelID) else {
            out.yield(.finished(.failed(Self.noProviderReason)))
            return
        }
        // Check consent before keyed model listing in prepareForImages.
        guard await mayShare(selection.endpoint.baseURL) else {
            out.yield(.finished(.failed(Self.noConsentReason(host: AIDataConsent.host(of: selection.endpoint.baseURL)))))
            return
        }
        if request.attachments.contains(where: \.isImage) { await prepareForImages(request.modelID) }

        var setup: ConversationSetup
        var preparationFailures: [MCPToolset.Failure] = []
        if let frozen = request.setup, !request.history.isEmpty {
            setup = frozen
        } else {
            // Freeze look_at_image when vision is unconfirmed so fallback runs have it.
            let reading = selection.imageSupport != .supported && selection.endpoint.capabilities.tools
            let preparation = await runtime.prepare(mcpServerIDs: request.connectorIDs, includeImageReader: reading,
                                                    instructions: instructions, disabledTools: request.disabledTools)
            setup = preparation.setup
            preparationFailures = preparation.failures
            await request.onSetup(setup, preparation.failures)
            for failure in preparation.failures { report(failure, out) }
        }
        guard !Task.isCancelled else {
            out.yield(.finished(.cancelled))
            return
        }

        // Commit closing results for orphaned mid-stop tool calls so history stays valid.
        let history = AttachmentMedia.rehydrate(request.history, store: attachments)
        let repair = TranscriptRepair.closingDanglingToolCalls(in: history)
        let previous = history + repair

        let media = AttachmentMedia.build(request.attachments, store: attachments)
        let text = AttachmentMedia.text(request.userText, fileOnly: media.fileOnly, hasJavaScript: setup.includesJavaScript)
        let user = await runtime.userMessage(text: text, images: media.images, documents: media.documents,
                                             mode: request.mode.agentMode, effort: request.effort,
                                             previous: previous, setup: setup)
        out.yield(.committed(repair + [AttachmentMedia.dehydrate(user, sources: media.sources)]))

        let files = AttachmentFiles(current: request.attachments, conversation: request.conversationAttachments,
                                    store: attachments, hidden: request.hiddenFromCode)
        var fellBackImages = false
        var fellBackTools = false
        var fellBackEffort = false
        let isCancelled = request.isCancelled
        while true {
            guard !isCancelled() else { return }
            // Re-check consent before every request in case it was revoked mid-run.
            guard await mayShare(selection.endpoint.baseURL) else {
                out.yield(.finished(.failed(Self.noConsentReason(host: AIDataConsent.host(of: selection.endpoint.baseURL)))))
                return
            }
            let reader = setup.offersImageReader ? await imageReader() : .notConfigured
            let run = RunRequest(conversationID: request.conversationID.uuidString, model: selection.model, setup: setup,
                                 transcript: previous + [user], mode: request.mode.agentMode, effort: request.effort,
                                 webSearch: request.webSearch, policy: request.policy, approvals: request.approvals,
                                 files: files.isEmpty ? nil : files, maxOutputTokens: selection.maxOutputTokens,
                                 disabledServerIDs: request.disabledServerIDs, disabledTools: request.disabledTools,
                                 contextWindow: selection.contextWindow,
                                 compaction: request.compaction, imageReader: reader,
                                 measurement: request.contextMeasurement, isCancelled: request.isCancelled,
                                 elicitationScope: request.elicitationScope,
                                 supportedEffortValues: selection.effortLevels)
            let provider = makeProvider(selection.endpoint, runtime.providerTransport)
            let sendsImages = provider.capabilities.vision && ImageReference.containsImages(run.transcript)
            let sendsTools = provider.capabilities.tools
                && (!setup.toolSpecs.isEmpty || (run.webSearch && provider.capabilities.serverWebSearch))
            let sendsEffort = provider.capabilities.reasoningEffort && selection.effortLevels != []

            // Silent fallback retry is only allowed before the provider responds.
            var progressed = false
            var imageRejection: AgentEvent?
            var toolRejection: AgentEvent?
            var effortRejection: (event: AgentEvent, rejection: EffortLevels.Rejection)?
            for await event in runtime.run(run, provider: provider) {
                guard !isCancelled() else { break }
                // Persist compaction before emitting so subsequent runs see it.
                if case .compaction(_, .finished(let record)) = event { await request.onCompaction(record) }
                if case .contextMeasured(let measurement) = event {
                    await request.onContextMeasured(measurement)
                    progressed = true
                    continue
                }
                if sendsImages, case .finished(.failed(let reason)) = event, ImageReference.isImageInputRejection(reason) {
                    imageRejection = event
                    continue
                }
                if sendsTools, case .finished(.failed(let reason)) = event, ToolSupport.isToolUseRejection(reason) {
                    toolRejection = event
                    continue
                }
                if sendsEffort, case .finished(.failed(let reason)) = event, let rejection = EffortLevels.rejection(in: reason) {
                    effortRejection = (event, rejection)
                    continue
                }
                if case .iterationStarted = event {} else { progressed = true }
                out.yield(event)
            }
            guard imageRejection != nil || toolRejection != nil || effortRejection != nil else { return }

            // Each rejection kind (image, tool, effort) retries at most once.
            if let imageRejection {
                await onImagesRejected(selection)
                guard !fellBackImages, !progressed, !Task.isCancelled else {
                    out.yield(imageRejection)
                    return
                }

                // Retry unseen with image placeholders since nothing streamed yet.
                fellBackImages = true
                selection.endpoint.capabilities.vision = false
                selection.imageSupport = .unsupported
                // Safe to add look_at_image when history is empty and no prefix is used.
                if selection.endpoint.capabilities.tools, request.history.isEmpty, !setup.offersImageReader {
                    setup = await runtime.addingImageReader(to: setup, instructions: instructions)
                    await request.onSetup(setup, preparationFailures)
                }
                noteTextOnly(selection, setup: setup, reader: setup.offersImageReader ? await imageReader() : .notConfigured, out)
            } else if let toolRejection {
                await onToolsRejected(selection)
                guard !fellBackTools, !progressed, !Task.isCancelled else {
                    out.yield(toolRejection)
                    return
                }

                // Retry unseen without tools while keeping frozen setup for tool models.
                fellBackTools = true
                selection.endpoint.capabilities.tools = false
                selection.toolSupport = .unsupported
                noteToolsOff(selection, out)
            } else if let effortRejection {
                let narrowed: [String]
                let dropped: Bool
                switch effortRejection.rejection {
                case .parameterUnsupported:
                    await onEffortRejected(selection)
                    narrowed = []
                    dropped = true
                case .valueUnsupported(let value):
                    let current = selection.effortLevels ?? EffortLevels.unknownBaseline
                    let next = EffortLevels.narrow(current, rejecting: value)
                    if next == current {
                        // Drop reasoning_effort instead of retrying identical levels if narrowing fails.
                        await onEffortRejected(selection)
                        narrowed = []
                        dropped = true
                    } else {
                        await onEffortValueRejected(selection, value)
                        narrowed = next
                        dropped = false
                    }
                }
                guard !fellBackEffort, !progressed, !Task.isCancelled else {
                    out.yield(effortRejection.event)
                    return
                }

                // Retry unseen with clamped effort; dropped effort shows a step note.
                fellBackEffort = true
                selection.effortLevels = narrowed
                if dropped { noteEffortOff(selection, out) }
            }
        }
    }

    private func noteTextOnly(_ selection: ProviderSelection, setup: ConversationSetup, reader: ImageReaderAccess,
                              _ out: AsyncStream<AgentEvent>.Continuation) {
        let name = selection.modelName.isEmpty ? selection.model : selection.modelName
        let summary: String
        if !selection.endpoint.capabilities.tools {
            summary = "This model can't use tools either, so the image wasn't sent. Pick a model with image input to use pictures."
        } else if !setup.offersImageReader {
            summary = "This chat can't hand images to an image-reading model. Set one up in Settings → Image reading model; new chats will use it."
        } else if case .ready(let reader) = reader {
            summary = "\(reader.displayName) looks at the image instead."
        } else if case .unavailable(let message) = reader, message != ImageReaderAccess.notConfiguredMessage {
            summary = "The image-reading model can't be used right now. Check Settings → Image reading model."
        } else {
            summary = "No image-reading model is set up. Pick one in Settings → Image reading model so it can look at images."
        }
        let id = "image-input-text-only"
        out.yield(.toolCallStarted(ToolActivity(
            id: id, name: "image_input", source: .builtin,
            presentation: ToolPresentation(category: .other, runningTitle: "Checking image support…",
                                           finishedTitle: "\(name) can't see images"))))
        out.yield(.toolFinished(id: id, ToolCompletion(status: .succeeded, summary: summary)))
    }

    private func noteEffortOff(_ selection: ProviderSelection,
                               _ out: AsyncStream<AgentEvent>.Continuation) {
        let name = selection.modelName.isEmpty ? selection.model : selection.modelName
        let id = "effort-not-supported"
        out.yield(.toolCallStarted(ToolActivity(
            id: id, name: "effort_support", source: .builtin,
            presentation: ToolPresentation(category: .other, runningTitle: "Checking reasoning support…",
                                           finishedTitle: "\(name) doesn't take a reasoning effort — sending without it"))))
        out.yield(.toolFinished(id: id, ToolCompletion(status: .succeeded, summary: "This model doesn't take a reasoning effort, so the chat continues without it. Switch to a reasoning model to use the effort dial.")))
    }

    private func noteToolsOff(_ selection: ProviderSelection,
                              _ out: AsyncStream<AgentEvent>.Continuation) {
        let name = selection.modelName.isEmpty ? selection.model : selection.modelName
        let id = "tools-not-supported"
        out.yield(.toolCallStarted(ToolActivity(
            id: id, name: "tool_support", source: .builtin,
            presentation: ToolPresentation(category: .other, runningTitle: "Checking tool support…",
                                           finishedTitle: "\(name) can't use tools — answering without them"))))
        out.yield(.toolFinished(id: id, ToolCompletion(status: .succeeded, summary: "This model can't call tools, so the chat continues without them. Switch to a tool-capable model to use connectors and skills.")))
    }

    private func report(_ failure: MCPToolset.Failure, _ out: AsyncStream<AgentEvent>.Continuation) {
        let id = "setup-\(failure.serverID)"
        let activity = ToolActivity(
            id: id, name: "connect", source: .mcp(serverID: failure.serverID, serverName: failure.serverName),
            presentation: ToolPresentation(category: .integration, runningTitle: "Connecting to \(failure.serverName)…",
                                           finishedTitle: "Couldn't connect to \(failure.serverName)"))
        let detail = failure.authRequirement.map(\.message) ?? failure.message
        out.yield(.toolCallStarted(activity))
        out.yield(.toolFinished(id: id, ToolCompletion(
            status: .failed,
            summary: "\(failure.serverName) left out: \(detail) Retry the first message afterwards to include it.")))
    }
}

/// Ends UIApplication background task once on finish or grace expiry.
final class BackgroundGrace: Sendable {
    private let state: MainActorBox

    init(name: String, onExpire: @escaping @Sendable () -> Void) {
        state = MainActorBox()
        let state = state
        Task { @MainActor in state.begin(name, onExpire: onExpire) }
    }

    func end() {
        let state = state
        Task { @MainActor in state.end() }
    }

    @MainActor
    private final class MainActorBox: Sendable {
        private var id: UIBackgroundTaskIdentifier = .invalid
        private var ended = false

        nonisolated init() {}

        func begin(_ name: String, onExpire: @escaping @Sendable () -> Void) {
            guard !ended else { return }
            id = UIApplication.shared.beginBackgroundTask(withName: name) { [self] in
                MainActor.assumeIsolated {
                    onExpire()
                    end()
                }
            }
        }

        func end() {
            ended = true
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
    }
}
