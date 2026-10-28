import Foundation
import Synchronization

public struct AgentRunConfiguration: Sendable {
    public var conversationID: String
    public var model: String
    public var system: String
    public var mode: AgentMode
    public var effort: Effort
    public var maxTokens: Int
    /// The model's max output tokens, when known. Caps the maxTokens
    /// retry: without it the doubled budget can exceed the model max and
    /// the retry itself fails. Nil means unbounded (old behavior).
    public var modelMaxTokens: Int?
    public var maxIterations: Int
    public var serverWebSearch: Bool
    public var toolTimeout: Duration
    public var maxConcurrentTools: Int
    public var maxRetries: Int
    /// Cap on `pause_turn` continuations per run.
    public var maxPauseContinuations: Int
    /// Window budget for compaction.
    public var context: ContextPolicy
    /// The conversation's last compaction; ignored unless it still
    /// `applies(to:)` the transcript.
    public var compaction: ContextCompaction?
    /// The conversation's last measured prompt size (an earlier run's
    /// `AgentEvent.contextMeasured`); budgets the first request when it
    /// still applies to the transcript.
    public var measurement: ContextMeasurement?
    /// True once the run was stopped. The loop checks it next to every
    /// `Task.checkCancellation()`: a task suspended in `for await` over a
    /// non-throwing stream never notices task cancellation, so the flag
    /// is the cooperative channel that reaches a detached run.
    public var isCancelled: @Sendable () -> Bool
    /// The run's elicitation scope, fresh per run. Set ambiently around
    /// each tool execution so the client's elicitations carry it; the
    /// store cancels the scope on stop. Nil leaves elicitations unscoped.
    public var elicitationScope: UUID?

    public init(conversationID: String, model: String, system: String, mode: AgentMode = .auto, effort: Effort = .high,
                maxTokens: Int? = nil, modelMaxTokens: Int? = nil, maxIterations: Int? = nil, serverWebSearch: Bool = false,
                toolTimeout: Duration = .seconds(120), maxConcurrentTools: Int = 4, maxRetries: Int = 4,
                maxPauseContinuations: Int = 5, context: ContextPolicy = ContextPolicy(),
                compaction: ContextCompaction? = nil, measurement: ContextMeasurement? = nil,
                isCancelled: @escaping @Sendable () -> Bool = { false },
                elicitationScope: UUID? = nil) {
        self.measurement = measurement
        self.conversationID = conversationID
        self.model = model
        self.system = system
        self.mode = mode
        self.effort = effort
        self.maxTokens = maxTokens ?? effort.defaultMaxTokens
        self.modelMaxTokens = modelMaxTokens
        self.maxIterations = maxIterations ?? effort.defaultMaxIterations
        self.isCancelled = isCancelled
        self.elicitationScope = elicitationScope
        self.serverWebSearch = serverWebSearch
        self.toolTimeout = toolTimeout
        self.maxConcurrentTools = maxConcurrentTools
        self.maxRetries = maxRetries
        self.maxPauseContinuations = maxPauseContinuations
        self.context = context
        self.compaction = compaction
    }
}

/// The agent loop: stream a model response, run the tools it asks for,
/// send the results back, repeat until the model is done.
///
/// Stateless and Sendable — every `run` gets its own state. Events arrive
/// uncoalesced; wrap with `AgentEventCoalescer` before feeding UI.
public struct AgentLoop: Sendable {
    public let provider: any ModelProvider
    public let tools: ToolRegistry
    public let policy: ToolPolicy
    public let approvals: any ApprovalHandler
    public let files: (any VirtualFileSystem)?
    public let limiter: ResultLimiter
    public let spill: OutputSpill?
    let sleep: @Sendable (Duration) async throws -> Void

    public init(provider: any ModelProvider, tools: ToolRegistry, policy: ToolPolicy = ToolPolicy(),
                approvals: any ApprovalHandler = AutoApprove(), files: (any VirtualFileSystem)? = nil,
                limiter: ResultLimiter = ResultLimiter(), spill: OutputSpill? = nil,
                sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.provider = provider
        self.tools = tools
        self.policy = policy
        self.approvals = approvals
        self.files = files
        self.limiter = limiter
        self.spill = spill
        self.sleep = sleep
    }

    /// Runs one user turn. `transcript` must end with the new user message.
    /// Cancelling the consuming task (or dropping the stream) stops the run;
    /// any tool calls left without results are closed at the start of the
    /// next run.
    public func run(transcript: [Message], configuration: AgentRunConfiguration) -> AsyncStream<AgentEvent> {
        AsyncStream(bufferingPolicy: .unbounded) { continuation in
            let task = Task {
                let run = LoopRun(loop: self, config: configuration, emit: { continuation.yield($0) })
                let outcome = await run.execute(transcript)
                continuation.yield(.finished(outcome))
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// Mutable policy shared by the run and nested (code-mode) tool calls.
actor PolicyState {
    var policy: ToolPolicy
    init(_ policy: ToolPolicy) { self.policy = policy }
    func decide(_ subject: ToolSubject, mode: AgentMode) -> ToolDecision { policy.decide(subject, mode: mode) }
    func allowAlways(_ key: String) { policy.alwaysAllow.insert(key) }
}

private struct LoopRun: Sendable {
    let loop: AgentLoop
    let config: AgentRunConfiguration
    let emit: @Sendable (AgentEvent) -> Void
    let policy: PolicyState

    init(loop: AgentLoop, config: AgentRunConfiguration, emit: @escaping @Sendable (AgentEvent) -> Void) {
        self.loop = loop
        self.config = config
        self.emit = emit
        self.policy = PolicyState(loop.policy)
    }

    /// Stops end the run two ways: task cancellation (a dropped
    /// consumer) and the run flag (Stop). Both throw the same error.
    private func checkCancellation() throws {
        if config.isCancelled() { throw CancellationError() }
        try Task.checkCancellation()
    }

    func execute(_ transcript: [Message]) async -> RunOutcome {
        var messages = transcript
        let repair = TranscriptRepair.closingDanglingToolCalls(in: Array(messages.dropLast()))
        if !repair.isEmpty, let last = messages.last {
            // A previous run stopped mid-tool: close its calls before the new user message.
            messages = Array(messages.dropLast()) + repair + [last]
        }

        var usage = Usage()
        var pauses = 0
        var iteration = 0
        let context = ContextState(policy: config.context,
                                   compaction: config.compaction.flatMap { $0.applies(to: messages) ? $0 : nil },
                                   fixedTokens: TokenEstimator.tokens(system: config.system, tools: requestTools),
                                   measurement: config.measurement, transcript: messages, model: config.model)

        do {
            while true {
                try checkCancellation()
                iteration += 1
                if iteration > config.maxIterations { return .maxIterations }
                emit(.iterationStarted(iteration))

                var maxTokens = config.maxTokens
                var streamed = try await respond(messages, iteration: iteration, maxTokens: maxTokens, context: context)
                var response = streamed.response
                usage = usage + response.usage + context.takeSummaryUsage()
                emit(.usage(usage))

                // A tool call cut off by the output budget can't be run: retry once with more room,
                // capped at the model max (past it the retry itself would 400 and the partial
                // answer would be lost — fall through to the strip-and-truncate path instead).
                if response.stopReason == .maxTokens, !response.message.toolCalls.isEmpty,
                   maxTokens < (config.modelMaxTokens ?? .max) {
                    maxTokens = min(maxTokens * 2, config.modelMaxTokens ?? .max)
                    emit(.attemptDiscarded(blockIDs: streamed.blockIDs, toolCallIDs: response.message.toolCalls.map(\.id)))
                    streamed = try await respond(messages, iteration: iteration, maxTokens: maxTokens, attemptBase: 100, context: context)
                    response = streamed.response
                    usage = usage + response.usage + context.takeSummaryUsage()
                    emit(.usage(usage))
                }

                var message = response.message
                switch response.stopReason {
                case .refusal(let category):
                    // Refused output is never kept in history and its tools never run.
                    return .refused(category)

                case .maxTokens:
                    if !message.toolCalls.isEmpty {
                        message.parts.removeAll { if case .toolCall = $0 { return true }; return false }
                        message.raw = nil
                    }
                    commit(message, into: &messages)
                    return .truncated

                case .contextWindowExceeded:
                    commit(message, into: &messages)
                    return .failed("This conversation is too long for the model's context window. Start a new chat or switch to a model with a larger window.")

                case .pauseTurn:
                    commit(message, into: &messages)
                    pauses += 1
                    if pauses > config.maxPauseContinuations { return .completed }
                    continue

                case .toolUse, .endTurn, .other:
                    // Some compatible servers report `stop` alongside tool calls:
                    // the presence of calls is what counts.
                    if message.toolCalls.isEmpty {
                        commit(message, into: &messages)
                        return .completed
                    }
                    commit(message, into: &messages)
                    let results = try await runTools(message.toolCalls)
                    commit(Message(role: .user, parts: results.map(Part.toolResult)), into: &messages)
                }
            }
        } catch is CancellationError {
            return .cancelled
        } catch let error as ProviderError {
            return Task.isCancelled ? .cancelled : .failed(error.description)
        } catch {
            return Task.isCancelled ? .cancelled : .failed(error.localizedDescription)
        }
    }

    private func commit(_ message: Message, into messages: inout [Message]) {
        guard !message.parts.isEmpty else { return }
        messages.append(message)
        emit(.committed([message]))
    }

    // MARK: Context

    private var requestTools: [ToolSpec] { loop.provider.capabilities.tools ? loop.tools.specs : [] }

    /// One model response for `messages` (the full transcript so far),
    /// sent through the current compaction. Compacts first when the
    /// request would cross the threshold; when the provider still reports
    /// the context as too long, compacts harder and retries once per run.
    private func respond(_ messages: [Message], iteration: Int, maxTokens: Int, attemptBase: Int = 0,
                         context: ContextState) async throws -> Streamed {
        if context.policy.isEnabled,
           context.estimate(messages) > context.policy.threshold(window: context.window, maxTokens: maxTokens) {
            _ = try await compact(messages, reason: .threshold, maxTokens: maxTokens, context: context)
        }
        var base = attemptBase
        while true {
            let result: Result<Streamed, ProviderError>
            do {
                result = .success(try await streamWithRetry(messages: context.requestMessages(messages), iteration: iteration,
                                                            maxTokens: maxTokens, attemptBase: base))
            } catch let error as ProviderError {
                result = .failure(error)
            }
            switch result {
            case .success(let streamed):
                if streamed.response.stopReason == .contextWindowExceeded, context.canRetryOverflow {
                    context.overflowRetried = true
                    context.learnWindow(limit: nil, failedEstimate: max(context.estimate(messages), streamed.response.usage.contextTokens))
                    if try await compact(messages, reason: .overflow, maxTokens: maxTokens, context: context) {
                        emit(.attemptDiscarded(blockIDs: streamed.blockIDs, toolCallIDs: streamed.toolCallIDs))
                        base += 50
                        continue
                    }
                }
                context.calibrate(messages: messages, usage: streamed.response.usage)
                if streamed.response.usage.contextTokens > 0 {
                    emit(.contextMeasured(ContextMeasurement(model: config.model, messages: messages,
                                                             compactedMessages: context.compaction?.coveredMessages ?? 0,
                                                             usage: streamed.response.usage)))
                }
                return streamed
            case .failure(let error):
                guard error.isContextOverflow, context.canRetryOverflow else { throw error }
                context.overflowRetried = true
                context.learnWindow(limit: error.reportedContextLimit, failedEstimate: context.estimate(messages))
                guard try await compact(messages, reason: .overflow, maxTokens: maxTokens, context: context) else { throw error }
                base += 50
            }
        }
    }

    /// Summarizes everything before a new split point into a compaction
    /// record (folding in the previous summary). False when there's
    /// nothing to summarize or the summary request failed; the run then
    /// goes on with what it had.
    private func compact(_ messages: [Message], reason: CompactionReason, maxTokens: Int,
                         context: ContextState) async throws -> Bool {
        let window = context.window
        let threshold = context.policy.threshold(window: window, maxTokens: maxTokens)
        let share = reason == .overflow ? context.policy.keepRecent / 2 : context.policy.keepRecent
        let start = context.compaction?.coveredMessages ?? 0
        guard let split = ContextCompaction.splitPoint(in: messages, after: start,
                                                       keepTokens: Int(Double(threshold) * share)) else { return false }
        context.sequence += 1
        let id = "compaction.\(context.sequence).\(split)"
        emit(.compaction(id: id, .started(reason)))
        let before = context.estimate(messages)
        // The summary request holds instructions, a chunk of rendered
        // history and the summary's output budget.
        let summaryTokens = min(context.policy.summaryMaxTokens, config.maxTokens, max(512, window / 8))
        let summarizer = ContextSummarizer(
            provider: loop.provider, model: config.model, maxTokens: summaryTokens,
            chunkTokens: Int(Double(window) * 0.7) - summaryTokens - 600,
            maxRetries: config.maxRetries, sleep: loop.sleep)
        do {
            let (summary, cost) = try await summarizer.summarize(previous: context.compaction?.summary,
                                                                 messages: messages[start..<split])
            context.summaryUsage = context.summaryUsage + cost
            var record = ContextCompaction(summary: summary, coveredMessages: split,
                                           fingerprint: ContextCompaction.fingerprint(messages[..<split]),
                                           model: config.model, tokensBefore: before)
            context.compaction = record
            context.calibration = nil
            record.tokensAfter = context.estimate(messages)
            context.compaction = record
            emit(.compaction(id: id, .finished(record)))
            return true
        } catch {
            if error is CancellationError || Task.isCancelled {
                emit(.compaction(id: id, .failed("Cancelled")))
                throw CancellationError()
            }
            let reason = (error as? ProviderError)?.description ?? String(describing: error)
            emit(.compaction(id: id, .failed("Couldn't summarize earlier messages: \(reason)")))
            return false
        }
    }

    // MARK: Streaming

    private struct Streamed {
        var response: ProviderResponse
        var blockIDs: [String]
        var toolCallIDs: [String]
    }

    private func streamWithRetry(messages: [Message], iteration: Int, maxTokens: Int, attemptBase: Int = 0) async throws -> Streamed {
        let request = ProviderRequest(
            model: config.model, system: config.system, messages: messages,
            tools: requestTools,
            maxTokens: maxTokens, effort: config.effort,
            serverWebSearch: config.serverWebSearch && loop.provider.capabilities.serverWebSearch)
        var attempt = 0
        while true {
            var emittedBlocks: [String] = []
            var emittedTools: [String] = []
            do {
                let response = try await streamOnce(request, iteration: iteration, attempt: attemptBase + attempt,
                                                    emittedBlocks: &emittedBlocks, emittedTools: &emittedTools)
                return Streamed(response: response, blockIDs: emittedBlocks, toolCallIDs: emittedTools)
            } catch let error as ProviderError where error.isRetryable && attempt < config.maxRetries {
                attempt += 1
                if !emittedBlocks.isEmpty || !emittedTools.isEmpty {
                    emit(.attemptDiscarded(blockIDs: emittedBlocks, toolCallIDs: emittedTools))
                }
                let backoff = Duration.milliseconds(Int(1000 * pow(2.0, Double(attempt - 1)) * Double.random(in: 0.8...1.2)))
                let delay = min(error.retryAfter ?? backoff, .seconds(60))
                emit(.retrying(attempt: attempt, delay: delay, reason: error.description))
                try await loop.sleep(delay)
            }
        }
    }

    /// One attempt's events. The consumer races a stop poller: a
    /// `for await` over a quiet stream suspends with no code running, so
    /// neither task cancellation nor the run flag could end it — the
    /// poller fails the race within ~50ms instead.
    private func streamOnce(_ request: ProviderRequest, iteration: Int, attempt: Int,
                            emittedBlocks: inout [String], emittedTools: inout [String]) async throws -> ProviderResponse {
        // Hoisted: keep the race tasks' captures small (see withTimeout).
        let provider = loop.provider
        let tools = loop.tools
        let emit = self.emit
        let stopOnCancel = config.isCancelled
        let stop = RaceStop()
        let partials = StreamPartials()
        let response: ProviderResponse
        do {
            response = try await withTaskCancellationHandler(operation: {
                try await withCheckedThrowingContinuation { continuation in
                    let once = FirstWins(continuation)
                    let worker = Task {
                        defer { stop.markFinished() }
                        do {
                            once.finish(.success(try await Self.consume(
                                provider: provider, request: request, tools: tools, emit: emit,
                                iteration: iteration, attempt: attempt, partials: partials,
                                isCancelled: stopOnCancel)))
                        } catch {
                            once.finish(.failure(error))
                        }
                    }
                    Task {
                        while !stop.isFinished {
                            try? await Task.sleep(for: .milliseconds(50))
                            if stop.isFinished { return }
                            if stop.cancelRequested || stopOnCancel() {
                                once.finish(.failure(CancellationError()))
                                worker.cancel()
                                return
                            }
                        }
                    }
                }
            }, onCancel: {
                stop.requestCancel()
            })
        } catch {
            let snap = partials.snapshot
            emittedBlocks = snap.blocks
            emittedTools = snap.tools
            throw error
        }
        let snap = partials.snapshot
        emittedBlocks = snap.blocks
        emittedTools = snap.tools
        return response
    }

    private static func consume(provider: any ModelProvider, request: ProviderRequest, tools: ToolRegistry,
                               emit: @escaping @Sendable (AgentEvent) -> Void,
                               iteration: Int, attempt: Int, partials: StreamPartials,
                               isCancelled: @escaping @Sendable () -> Bool) async throws -> ProviderResponse {
        func checkStop() throws {
            if isCancelled() { throw CancellationError() }
            try Task.checkCancellation()
        }
        var kinds: [Int: BlockKind] = [:]
        var toolIDs: [Int: String] = [:]
        var final: ProviderResponse?
        func blockID(_ index: Int) -> String { "\(iteration).\(attempt).\(index)" }

        for try await event in provider.stream(request) {
            try checkStop()
            switch event {
            case .textDelta(let i, let text):
                if kinds[i] == nil { kinds[i] = .text; partials.addBlock(blockID(i)) }
                emit(.textDelta(blockID: blockID(i), text: text))
            case .reasoningDelta(let i, let text):
                if kinds[i] == nil { kinds[i] = .reasoning; partials.addBlock(blockID(i)) }
                emit(.reasoningDelta(blockID: blockID(i), text: text))
            case .toolCallStarted(let i, let id, let name):
                kinds[i] = .tool
                toolIDs[i] = id
                partials.addTool(id)
                let tool = tools.tool(named: name)
                emit(.toolCallStarted(ToolActivity(
                    id: id, name: name, source: tool?.source ?? .builtin,
                    presentation: tool?.presentation(for: [:]) ?? ToolPresentation(category: .other, runningTitle: "Calling \(name)…", finishedTitle: "Called \(name)"))))
            case .toolCallDelta(let i, let json):
                if let id = toolIDs[i] { emit(.toolInputDelta(id: id, json: json)) }
            case .serverToolStarted(let i, let id, let name, let input):
                kinds[i] = .server
                partials.addTool(id)
                emit(.toolCallStarted(ToolActivity(id: id, name: name, source: .server,
                                                   presentation: Self.serverPresentation(name: name, input: input), arguments: input)))
                emit(.toolRunning(id: id))
            case .serverToolFinished(_, let id, let summary, let isError):
                emit(.toolFinished(id: id, ToolCompletion(status: isError ? .failed : .succeeded, summary: summary)))
            case .blockFinished(let i):
                switch kinds[i] {
                case .text: emit(.textFinished(blockID: blockID(i)))
                case .reasoning: emit(.reasoningFinished(blockID: blockID(i)))
                default: break
                }
            case .usage:
                break // the final response carries totals
            case .completed(let response):
                final = response
            }
        }
        try checkStop()
        guard let final else { throw ProviderError.network("The response ended before it was complete.") }
        return final
    }

    private enum BlockKind { case text, reasoning, tool, server }

    static func serverPresentation(name: String, input: JSONValue?) -> ToolPresentation {
        if name.contains("fetch") {
            let url = input?["url"]?.stringValue ?? "a page"
            return ToolPresentation(category: .webFetch, runningTitle: "Reading \(url)…", finishedTitle: "Read \(url)")
        }
        let query = input?["query"]?.stringValue.map { "“\($0)”" } ?? "the web"
        return ToolPresentation(category: .webSearch, runningTitle: "Searching \(query)…", finishedTitle: "Searched \(query)")
    }

    // MARK: Tools

    private struct PreparedCall: Sendable {
        var call: ToolCall
        var tool: (any AgentTool)?
        var arguments: JSONValue
        /// Set when the call is resolved without running.
        var result: ToolResult?
    }

    private func runTools(_ calls: [ToolCall]) async throws -> [ToolResult] {
        // 1. Parse, look up and authorize — sequentially, so approval cards
        //    appear one at a time in the order the model asked.
        var prepared: [PreparedCall] = []
        for call in calls {
            try checkCancellation()
            prepared.append(await prepare(call))
        }

        // 2. Run everything allowed, in parallel, results kept in call order.
        var results = prepared.map(\.result)
        try await withThrowingTaskGroup(of: (Int, ToolResult).self) { group in
            var next = 0
            var running = 0
            func addNext() {
                while next < prepared.count, running < max(1, config.maxConcurrentTools) {
                    let i = next
                    next += 1
                    guard prepared[i].result == nil, let tool = prepared[i].tool else { continue }
                    running += 1
                    let p = prepared[i]
                    group.addTask { (i, try await self.execute(tool, call: p.call, arguments: p.arguments)) }
                }
            }
            addNext()
            while let (i, result) = try await group.next() {
                results[i] = result
                running -= 1
                addNext()
            }
        }
        return results.enumerated().map { i, r in
            r ?? ToolResult(callID: calls[i].id, toolName: calls[i].name, content: [.text("Tool did not run.")], isError: true)
        }
    }

    private func prepare(_ call: ToolCall) async -> PreparedCall {
        func resolved(_ text: String, status: ToolStatus, args: JSONValue = [:], tool: (any AgentTool)? = nil) -> PreparedCall {
            emit(.toolFinished(id: call.id, ToolCompletion(status: status, summary: text)))
            return PreparedCall(call: call, tool: tool, arguments: args,
                                result: ToolResult(callID: call.id, toolName: call.name, content: [.text(text)], isError: true))
        }
        guard let tool = loop.tools.tool(named: call.name) else {
            return resolved("Unknown tool \(call.name).", status: .failed)
        }
        let args: JSONValue
        do {
            args = try JSONValue(parsing: call.arguments)
        } catch {
            return resolved("Invalid JSON arguments: \(call.arguments.prefix(200))", status: .failed, tool: tool)
        }
        guard case .object = args else {
            return resolved("Arguments must be a JSON object.", status: .failed, tool: tool)
        }
        let activity = ToolActivity(id: call.id, name: call.name, source: tool.source,
                                    presentation: tool.presentation(for: args), arguments: args)
        emit(.toolCallReady(activity))

        guard let subject = tool.subject(for: args) else {
            return resolved(tool.unavailableReason(for: args), status: .failed, args: args, tool: tool)
        }
        switch await policy.decide(subject, mode: config.mode) {
        case .allow:
            return PreparedCall(call: call, tool: tool, arguments: args)
        case .refuse(let reason):
            return resolved(reason, status: .denied, args: args, tool: tool)
        case .ask(let reason):
            let request = ApprovalRequest(id: call.id, toolName: subject.name, source: subject.source, arguments: args,
                                          reason: reason, title: activity.presentation.runningTitle)
            emit(.toolAwaitingApproval(request))
            let decision = await loop.approvals.decide(request)
            emit(.toolApprovalResolved(id: call.id, decision: decision))
            switch decision {
            case .allowOnce:
                return PreparedCall(call: call, tool: tool, arguments: args)
            case .allowAlways:
                let key = ToolPolicy.alwaysAllowKey(for: subject)
                await policy.allowAlways(key)
                emit(.policyUpdated(alwaysAllowKey: key))
                return PreparedCall(call: call, tool: tool, arguments: args)
            case .deny:
                return resolved("The user declined this tool call.", status: .denied, args: args, tool: tool)
            }
        }
    }

    private func execute(_ tool: any AgentTool, call: ToolCall, arguments: JSONValue) async throws -> ToolResult {
        // No new tool starts after a stop, even an already-approved one.
        try checkCancellation()
        emit(.toolRunning(id: call.id))
        let emit = self.emit
        let callID = call.id
        let context = ToolContext(
            conversationID: config.conversationID, mode: config.mode,
            emit: { emit(.toolProgress(id: callID, $0)) },
            files: loop.files,
            callTool: { name, args in try await self.nestedCall(name: name, arguments: args, parentID: callID) })

        let output: ToolOutput
        do {
            // The run's scope rides ambiently: the client's elicitations
            // (including nested code-mode calls, which run inside here)
            // carry it without a parameter the tools don't have.
            output = try await ElicitationScope.$current.withValue(config.elicitationScope) {
                try await withTimeout(config.toolTimeout) {
                    try await tool.execute(ToolInvocation(id: call.id, name: call.name, arguments: arguments), context: context)
                }
            }
        } catch is CancellationError {
            emit(.toolFinished(id: call.id, ToolCompletion(status: .cancelled, summary: "Cancelled")))
            throw CancellationError()
        } catch is ToolTimeout {
            let text = "Tool timed out after \(config.toolTimeout)."
            emit(.toolFinished(id: call.id, ToolCompletion(status: .failed, summary: text)))
            return ToolResult(callID: call.id, toolName: call.name, content: [.text(text)], isError: true)
        } catch {
            let text = "Tool failed: \(error.localizedDescription)"
            emit(.toolFinished(id: call.id, ToolCompletion(status: .failed, summary: text)))
            return ToolResult(callID: call.id, toolName: call.name, content: [.text(text)], isError: true)
        }

        let limited = await loop.limiter.limit(output, callID: call.id, spill: loop.spill)
        let presentation = tool.presentation(for: arguments)
        emit(.toolFinished(id: call.id, ToolCompletion(
            status: output.isError ? .failed : .succeeded,
            summary: output.summary ?? presentation.finishedTitle,
            preview: String(output.text.prefix(4000)))))
        return ToolResult(callID: call.id, toolName: call.name, content: limited.content, isError: output.isError)
    }

    /// A tool called from inside another tool (JS code mode). Same policy
    /// and approval path as a model-issued call; reported as traces on the
    /// parent step.
    private func nestedCall(name: String, arguments: JSONValue, parentID: String) async throws -> ToolOutput {
        try checkCancellation()
        guard let tool = loop.tools.nestedTool(named: name) else { return .error("Unknown tool \(name)") }
        if case .javascript = tool.source { return .error("Code can't start another code run.") }
        emit(.toolProgress(id: parentID, .trace(.api, "\(name)(\(arguments.encodedString().prefix(160)))")))
        guard let subject = tool.subject(for: arguments) else { return .error(tool.unavailableReason(for: arguments)) }
        switch await policy.decide(subject, mode: config.mode) {
        case .allow:
            break
        case .refuse(let reason):
            return .error(reason)
        case .ask(let reason):
            let id = "\(parentID)/\(UUID().uuidString.prefix(8))"
            let request = ApprovalRequest(id: id, toolName: subject.name, source: subject.source, arguments: arguments,
                                          reason: reason, title: tool.presentation(for: arguments).runningTitle,
                                          parentCallID: parentID)
            emit(.toolAwaitingApproval(request))
            let decision = await loop.approvals.decide(request)
            emit(.toolApprovalResolved(id: id, decision: decision))
            switch decision {
            case .deny: return .error("The user declined this tool call.")
            case .allowAlways:
                let key = ToolPolicy.alwaysAllowKey(for: subject)
                await policy.allowAlways(key)
                emit(.policyUpdated(alwaysAllowKey: key))
            case .allowOnce: break
            }
        }
        let context = ToolContext(conversationID: config.conversationID, mode: config.mode,
                                  emit: { [emit] in emit(.toolProgress(id: parentID, $0)) }, files: loop.files)
        return try await withTimeout(config.toolTimeout) {
            try await tool.execute(ToolInvocation(id: "\(parentID)/\(name)", name: name, arguments: arguments), context: context)
        }
    }

    private struct ToolTimeout: Error {}

    /// Tool timeouts use the real clock, not the injectable `sleep` (that
    /// one paces retries — a test's no-op sleep would time every tool out
    /// instantly). Calling the stored closure from this child task also
    /// crashed Swift 6.2/6.3 debug builds once `AgentRunConfiguration`
    /// grew ("freed pointer was not the last allocation"): an upstream
    /// task-allocator bug, fixed in Swift 6.3.1 (swiftlang/swift#88389;
    /// see /tmp/praxis-reports/D-swift-crash.md). Keep the direct
    /// `Task.sleep` until the minimum toolchain has the fix.
    ///
    /// First result wins; the loser is cancelled and abandoned, never
    /// awaited — leaving the scope of a throwing group would wait for a
    /// hung child and the timeout would never fire. The timer also
    /// watches task cancellation and the run flag, so a stop ends a
    /// long tool instead of waiting it out.
    private func withTimeout<T: Sendable>(_ limit: Duration, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        // Hoisted: keep the race tasks' captures small (see above).
        let stopOnCancel = config.isCancelled
        let stop = RaceStop()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                let once = FirstWins(continuation)
                let worker = Task {
                    defer { stop.markFinished() }
                    do { once.finish(.success(try await work())) } catch { once.finish(.failure(error)) }
                }
                Task {
                    var waited = Duration.zero
                    while !stop.isFinished {
                        if stop.cancelRequested || stopOnCancel() {
                            once.finish(.failure(CancellationError()))
                            worker.cancel()
                            return
                        }
                        if waited >= limit {
                            once.finish(.failure(ToolTimeout()))
                            worker.cancel()
                            return
                        }
                        let slice = min(limit - waited, .milliseconds(50))
                        try? await Task.sleep(for: slice)
                        waited += slice
                    }
                }
            }
        }, onCancel: {
            stop.requestCancel()
        })
    }
}

/// First-wins guard: a worker and a timer/poller race to resume one
/// continuation; the loser's result is dropped, so it resumes exactly once.
private final class FirstWins<T: Sendable>: Sendable {
    private let continuation: CheckedContinuation<T, any Error>
    private let finished = Mutex(false)

    init(_ continuation: CheckedContinuation<T, any Error>) {
        self.continuation = continuation
    }

    func finish(_ result: Result<T, any Error>) {
        let first = finished.withLock { done in
            if done { return false }
            done = true
            return true
        }
        if first { continuation.resume(with: result) }
    }
}

/// Shared stop state for a worker/poller race: the worker sets
/// `finished` (the poller then exits); task cancellation sets
/// `cancelRequested` (the poller then fails the race promptly).
private final class RaceStop: Sendable {
    private let state = Mutex<(finished: Bool, cancelRequested: Bool)>((false, false))

    var isFinished: Bool { state.withLock { $0.finished } }
    var cancelRequested: Bool { state.withLock { $0.cancelRequested } }
    func markFinished() { state.withLock { $0.finished = true } }
    func requestCancel() { state.withLock { $0.cancelRequested = true } }
}

/// Block ids the stream worker emitted so far; read when the race ends
/// (also on failure) so a retried attempt can name its partial output.
private final class StreamPartials: Sendable {
    private let state = Mutex<(blocks: [String], tools: [String])>(([], []))

    func addBlock(_ id: String) { state.withLock { $0.blocks.append(id) } }
    func addTool(_ id: String) { state.withLock { $0.tools.append(id) } }
    var snapshot: (blocks: [String], tools: [String]) { state.withLock { $0 } }
}
