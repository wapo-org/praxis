import Foundation
import UIKit
import AgentCore
import AgentProviders
import AgentMCP
import AgentRuntime

/// The real engine: `AgentRuntime` against the selected provider profile.
///
/// Per run:
/// 1. Resolve the provider at send time. None configured → fail fast with
///    an outcome that points to Settings.
/// 2. Freeze the conversation's `ConversationSetup` at its first send
///    (`prepare` with the conversation's connectors) and hand it to the
///    store to persist. Re-preparing happens only while the conversation
///    has no messages yet (first send, or retrying the first turn — e.g.
///    after signing in to a connector that failed).
/// 3. Build the user message with `runtime.userMessage` (mode / effort /
///    new-skill notes ride along on it) and commit it first, exactly as
///    built except that attachment bytes are kept by reference.
/// 4. Run, forwarding the runtime's events. Commits and always-allow keys
///    flow through the store's reducer as for every engine; a compaction
///    record goes to `onCompaction` and a prompt measurement to
///    `onContextMeasured` for the store to persist.
///
/// Images: a model the app knows takes images gets them; one it knows
/// doesn't gets `[Image img_…]` placeholders (and `look_at_image`); one it
/// doesn't know is tried. If the provider turns images down on the very
/// first request of a run ("No endpoints found that support image input"
/// and its kin), the model is remembered as text-only (`onImagesRejected`)
/// and the same run is resent once with placeholders; the user sees a small
/// step saying so, not a failure.
///
/// Each run holds a background task so a turn in flight gets the system's
/// grace period when the app is backgrounded; when that runs out, the run
/// is stopped cleanly (it settles as stopped and is saved).
struct LiveChatEngine: ChatEngine {
    /// `.failed` reason for "no provider": `TurnOutcome` turns it into
    /// `.needsProvider`, whose note links to Settings.
    static let noProviderReason = "No model provider is set up."
    /// `.failed` reason when the provider's host hasn't been allowed to
    /// receive chat data (the store asks first; this is the backstop).
    static func noConsentReason(host: String) -> String {
        "Sharing this chat with \(host) hasn't been allowed. Send again to review what's shared."
    }

    let runtime: AgentRuntime
    /// The provider for a run, resolved from settings when it starts.
    let resolve: @Sendable (_ modelID: String) async -> ProviderSelection?
    /// Endpoint → adapter. Tests swap in a scripted provider.
    var makeProvider: @Sendable (ProviderEndpoint, any HTTPTransport) -> any ModelProvider = { endpoint, transport in
        ProviderFactory.make(endpoint, transport: transport)
    }
    var attachments: AttachmentStore = .shared
    /// Extra system-prompt instructions frozen into new conversations.
    var instructions: String? = nil
    var usesBackgroundTasks = true
    /// Whether chat data may go to this provider base URL (AI-data
    /// consent, App Review 5.1.2(i)). Checked before anything is sent.
    var mayShare: @Sendable (_ baseURL: URL) async -> Bool = { _ in true }
    /// The image-reading model for `look_at_image` (Settings, with its
    /// key and AI-data consent checked), resolved when a run starts.
    var imageReader: @Sendable () async -> ImageReaderAccess = { .notConfigured }
    /// Called with the model id before a run that has images attached:
    /// settles a model's unknown image support from a current model list
    /// (bounded wait), so a text-only model is known before anything is sent.
    var prepareForImages: @Sendable (_ modelID: String) async -> Void = { _ in }
    /// The provider turned image input down for this model: remember it
    /// (persisted in Settings) so later sends use placeholders from the start.
    var onImagesRejected: @Sendable (ProviderSelection) async -> Void = { _ in }
    /// The provider turned tool use down for this model: remember it
    /// (persisted in Settings) so later sends go without tools from the start.
    var onToolsRejected: @Sendable (ProviderSelection) async -> Void = { _ in }

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
        // The consent backstop runs before anything keyed: the image
        // pre-check below lists models with the profile's key (R3-L1).
        guard await mayShare(selection.endpoint.baseURL) else {
            out.yield(.finished(.failed(Self.noConsentReason(host: AIDataConsent.host(of: selection.endpoint.baseURL)))))
            return
        }
        if request.attachments.contains(where: \.isImage) { await prepareForImages(request.modelID) }

        // Freeze (or, while nothing has been said yet, re-freeze) the setup.
        var setup: ConversationSetup
        var preparationFailures: [MCPToolset.Failure] = []
        if let frozen = request.setup, !request.history.isEmpty {
            setup = frozen
        } else {
            // A chat model that isn't known to see images gets
            // `look_at_image` (frozen with the other tools; the reader
            // itself is picked per run). "Not known" includes a model list
            // that predates the image flag: if images then have to go out
            // as placeholders, the tool is already there.
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

        // A run stopped mid-tool left calls without results. The loop only
        // patches them for its own request, so commit the closing results
        // here: later requests (and turns) must see a valid history too.
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
        let isCancelled = request.isCancelled
        while true {
            guard !isCancelled() else { return }
            // Consent can be revoked mid-run: re-check before every
            // request, so a fallback retry never goes out after a
            // revoke (R3-M1). The reader host is re-checked per run by
            // `imageReader` below.
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
                                 elicitationScope: request.elicitationScope)
            let provider = makeProvider(selection.endpoint, runtime.providerTransport)
            let sendsImages = provider.capabilities.vision && ImageReference.containsImages(run.transcript)
            // The request declared tools: the frozen specs (the loop sends
            // them when the model takes tools) or hosted web search.
            let sendsTools = provider.capabilities.tools
                && (!setup.toolSpecs.isEmpty || (run.webSearch && provider.capabilities.serverWebSearch))

            // Whether the provider has answered (or the run has otherwise
            // moved on) tells whether the run can start over unseen.
            var progressed = false
            var imageRejection: AgentEvent?
            var toolRejection: AgentEvent?
            for await event in runtime.run(run, provider: provider) {
                guard !isCancelled() else { break }
                // Persist before the UI hears of it: the next request may come
                // from a later run.
                if case .compaction(_, .finished(let record)) = event { await request.onCompaction(record) }
                if case .contextMeasured(let measurement) = event {
                    await request.onContextMeasured(measurement)
                    progressed = true
                    continue
                }
                if sendsImages, case .finished(.failed(let reason)) = event, ImageReference.isImageInputRejection(reason) {
                    imageRejection = event // decided below
                    continue
                }
                if sendsTools, case .finished(.failed(let reason)) = event, ToolSupport.isToolUseRejection(reason) {
                    toolRejection = event // decided below
                    continue
                }
                if case .iterationStarted = event {} else { progressed = true }
                out.yield(event)
            }
            guard imageRejection != nil || toolRejection != nil else { return }

            // Each kind is retried at most once; a request turned down for
            // images and then for tools retries twice in total, never more.
            if let imageRejection {
                // The provider turned images down. Remember it either way.
                await onImagesRejected(selection)
                guard !fellBackImages, !progressed, !Task.isCancelled else {
                    out.yield(imageRejection)
                    return
                }

                // Nothing was answered or shown yet: start the run over, this
                // time with images as placeholders (the model is now known to
                // be text-only, and the endpoint's vision follows).
                fellBackImages = true
                selection.endpoint.capabilities.vision = false
                selection.imageSupport = .unsupported
                // `look_at_image` is a frozen tool. A conversation whose
                // tools were frozen without it can still gain it while no
                // request of it was ever accepted — the same moment re-freezing
                // is allowed (nothing was said yet, so no prefix is in use).
                // Later in a conversation it can't, and the placeholders say
                // so instead.
                if selection.endpoint.capabilities.tools, request.history.isEmpty, !setup.offersImageReader {
                    setup = await runtime.addingImageReader(to: setup, instructions: instructions)
                    await request.onSetup(setup, preparationFailures)
                }
                noteTextOnly(selection, setup: setup, reader: setup.offersImageReader ? await imageReader() : .notConfigured, out)
            } else if let toolRejection {
                // The provider turned tool use down. Remember it either way.
                await onToolsRejected(selection)
                guard !fellBackTools, !progressed, !Task.isCancelled else {
                    out.yield(toolRejection)
                    return
                }

                // Nothing was answered or shown yet: start the run over,
                // this time without tools (the model is now known to be
                // plain-chat, and the endpoint's tools follow). The frozen
                // setup stays as it is for tool-capable models.
                fellBackTools = true
                selection.endpoint.capabilities.tools = false
                selection.toolSupport = .unsupported
                noteToolsOff(selection, out)
            }
        }
    }

    /// The small step telling the user their image went as text, and what
    /// to do about it where that matters.
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

    /// The small step telling the user the model answered without tools.
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

    /// A connector that couldn't list its tools shows as a failed step, so
    /// the user sees why its tools are missing and what to do.
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

/// `UIApplication.beginBackgroundTask` for one run. Ends exactly once:
/// when the run finishes, or when the grace period expires (after asking
/// the run to stop).
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
