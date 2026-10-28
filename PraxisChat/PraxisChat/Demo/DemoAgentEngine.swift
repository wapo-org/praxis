import Foundation
import AgentCore

/// In-app demo engine — no backend (spec preamble). Plays the scenario
/// scripts as runtime `AgentEvent`s, exactly the vocabulary a live run
/// emits, so everything downstream (coalescer, reducer, views) is the
/// real path. Realistic jittered timing: steps 300–1200ms, output lines
/// 40–120ms, text chunks of 2–6 words every 25–60ms. Effort scales
/// steps/length (~3s Low → ~15s Max); the model scales streaming speed;
/// Web search off removes web steps. `timeScale` multiplies every pause
/// (0 in unit tests: no sleeping at all).
struct DemoAgentEngine: ChatEngine {
    var timeScale: Double = 1
    var kind: EngineKind { .demo }

    func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent> {
        let scenario = Scenarios.pick(prompt: request.prompt, hasAttachments: !request.attachments.isEmpty,
                                      webSearch: request.webSearch)
        let player = Player(request: request, scenario: scenario, timeScale: timeScale)
        return AsyncStream(bufferingPolicy: .unbounded) { continuation in
            let task = Task {
                await player.play(continuation)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

private struct Player: Sendable {
    let request: ChatRunRequest
    let scenario: Scenario
    let timeScale: Double

    private var streamMultiplier: Double {
        MockData.models.first { $0.id == request.modelID }?.streamMultiplier ?? 1
    }

    /// False once the run is cancelled.
    private func sleep(_ base: Double, _ jitter: Double) async -> Bool {
        guard timeScale > 0 else {
            await Task.yield()
            return !Task.isCancelled
        }
        let ms = max(10, (base + Double.random(in: 0...jitter)) * 1000 * timeScale)
        do { try await Task.sleep(for: .milliseconds(Int(ms))) } catch { return false }
        return !Task.isCancelled
    }

    func play(_ out: AsyncStream<AgentEvent>.Continuation) async {
        let effort = request.effort
        // Scale the step list by effort, always keeping ≥2 steps — and
        // any step that asks for approval, which is the point of its script.
        let keep = max(2, Int((Double(scenario.steps.count) * effort.stepScale).rounded()))
        let steps = Array(scenario.steps.prefix(keep)) + scenario.steps.dropFirst(keep).filter { $0.approval != nil }
        let pace = effort.runSeconds / 8.0 // baseline script ≈8s at High
        var iteration = 1
        out.yield(.iterationStarted(iteration))

        // Thinking out loud first, at the efforts that plan.
        if let plan = scenario.plan, effort == .high || effort == .max {
            let blockID = "\(iteration).reasoning"
            if await !stream(plan, block: blockID, reasoning: true, out) { return }
            out.yield(.reasoningFinished(blockID: blockID))
        }

        var declined = false
        for (n, script) in steps.enumerated() {
            guard let outcome = await runStep(script, index: n, iteration: iteration, pace: pace, out) else { return }
            if outcome == .denied { declined = true }
            if await !sleep(0.15 * pace, 0.3 * pace) { return }
        }

        iteration += 1
        out.yield(.iterationStarted(iteration))
        let answer = declined ? (scenario.answerIfDenied ?? scenario.answer) : scenario.answer
        if await !answerBlock(answer, iteration: iteration, out) { return }

        if let second = scenario.secondSteps, let after = scenario.answerAfterSecond, !second.isEmpty {
            iteration += 1
            out.yield(.iterationStarted(iteration))
            for (n, script) in second.enumerated() {
                guard await runStep(script, index: n, iteration: iteration, pace: pace * 0.7, out) != nil else { return }
            }
            iteration += 1
            out.yield(.iterationStarted(iteration))
            if await !answerBlock(after, iteration: iteration, out) { return }
        }

        out.yield(.finished(.completed))
    }

    // MARK: Steps

    /// Plays one tool call. Nil when cancelled.
    private func runStep(_ script: StepScript, index: Int, iteration: Int, pace: Double,
                         _ out: AsyncStream<AgentEvent>.Continuation) async -> ToolStatus? {
        let id = "demo_\(iteration)_\(index)_\(UUID().uuidString.prefix(6))"
        let tool = Self.tool(for: script)
        let presentation = ToolPresentation(category: tool.category, runningTitle: script.running,
                                            finishedTitle: script.final)
        var activity = ToolActivity(id: id, name: tool.name, source: tool.source, presentation: presentation)
        out.yield(.toolCallStarted(activity))
        activity.arguments = tool.arguments
        out.yield(.toolCallReady(activity))

        if let approval = script.approval {
            guard let allowed = await authorize(approval, id: id, out) else { return nil }
            if !allowed {
                out.yield(.toolFinished(id: id, ToolCompletion(status: .denied, summary: approval.deniedFinal)))
                commit(id: id, tool: tool, result: "The user declined this action.", isError: true, out)
                return .denied
            }
        }

        out.yield(.toolRunning(id: id))
        if await !sleep(0.3 * pace, 0.9 * pace) { return nil }

        for trace in script.traces {
            out.yield(.toolProgress(id: id, .trace(trace.kind, trace.text)))
            if await !sleep(0.08, 0.12) { return nil }
        }
        if script.showsAttachments {
            for attachment in request.attachments {
                out.yield(.toolProgress(id: id, .trace(.image, attachment.name)))
                if await !sleep(0.08, 0.12) { return nil }
            }
        }

        var status = ToolStatus.succeeded
        var preview = script.result ?? ""
        if let command = script.command {
            for line in command.lines {
                if await !sleep(0.04, 0.08) { return nil }
                out.yield(.toolProgress(id: id, .output([line])))
            }
            status = command.exitCode == 0 ? .succeeded : .failed
            preview = command.lines.last ?? ""
            // A run never reads as instant.
            if await !sleep(0.4, 0) { return nil }
        }
        out.yield(.toolFinished(id: id, ToolCompletion(status: status, summary: script.final, preview: preview)))
        commit(id: id, tool: tool, result: preview.isEmpty ? script.final : preview, isError: status != .succeeded, out)
        return status
    }

    /// Runs the step through the real policy: true to go ahead, false
    /// when declined or refused by the mode, nil when cancelled.
    private func authorize(_ approval: ApprovalScript, id: String,
                           _ out: AsyncStream<AgentEvent>.Continuation) async -> Bool? {
        let source = ToolSource.mcp(serverID: approval.serverID, serverName: approval.serverName)
        let subject = ToolSubject(name: approval.toolName, source: source, traits: [.destructive],
                                  fingerprint: "demo")
        switch request.policy.decide(subject, mode: request.mode.agentMode) {
        case .allow:
            return true
        case .refuse(let reason):
            out.yield(.toolProgress(id: id, .trace(.note, reason)))
            return false
        case .ask(let reason):
            let ask = ApprovalRequest(id: id, toolName: approval.toolName, source: source,
                                      arguments: approval.arguments, reason: reason, title: approval.title)
            out.yield(.toolAwaitingApproval(ask))
            let decision = await request.approvals.decide(ask)
            if Task.isCancelled { return nil }
            out.yield(.toolApprovalResolved(id: id, decision: decision))
            if decision == .allowAlways {
                out.yield(.policyUpdated(alwaysAllowKey: ToolPolicy.alwaysAllowKey(for: subject)))
            }
            return decision != .deny
        }
    }

    private func commit(id: String, tool: DemoTool, result: String, isError: Bool,
                        _ out: AsyncStream<AgentEvent>.Continuation) {
        out.yield(.committed([
            Message(role: .assistant, parts: [.toolCall(ToolCall(id: id, name: tool.name,
                                                                 arguments: tool.arguments.encodedString()))]),
            Message(role: .user, parts: [.toolResult(ToolResult(callID: id, toolName: tool.name,
                                                                content: [.text(result)], isError: isError))]),
        ]))
    }

    // MARK: Text

    private func answerBlock(_ markdown: String, iteration: Int,
                             _ out: AsyncStream<AgentEvent>.Continuation) async -> Bool {
        let blockID = "\(iteration).text"
        guard await stream(markdown, block: blockID, reasoning: false, out) else { return false }
        out.yield(.textFinished(blockID: blockID))
        out.yield(.committed([Message(role: .assistant, parts: [.text(markdown)])]))
        return true
    }

    /// Streams in 2–6 word chunks (the store coalesces them per frame).
    private func stream(_ text: String, block: String, reasoning: Bool,
                        _ out: AsyncStream<AgentEvent>.Continuation) async -> Bool {
        let words = text.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        var i = 0
        while i < words.count {
            if Task.isCancelled { return false }
            let n = Int.random(in: 2...6)
            let end = min(i + n, words.count)
            let chunk = words[i..<end].joined(separator: " ") + (end < words.count ? " " : "")
            out.yield(reasoning ? .reasoningDelta(blockID: block, text: chunk) : .textDelta(blockID: block, text: chunk))
            i = end
            if await !sleep(0.04 / streamMultiplier, 0.02) { return false }
        }
        return true
    }

    // MARK: Tools

    struct DemoTool {
        var name: String
        var category: ToolCategory
        var source: ToolSource
        var arguments: JSONValue
    }

    /// The tool call a scripted step stands for.
    static func tool(for script: StepScript) -> DemoTool {
        let arguments = script.arguments ?? [:]
        if let approval = script.approval {
            return DemoTool(name: approval.toolName, category: .integration,
                            source: .mcp(serverID: approval.serverID, serverName: approval.serverName),
                            arguments: approval.arguments)
        }
        switch script.kind {
        case .command:
            return DemoTool(name: "run_command", category: .command, source: .builtin,
                            arguments: ["command": .string(script.command?.code ?? "")])
        case .readFile:
            return DemoTool(name: "read_file", category: .readFile, source: .builtin, arguments: arguments)
        case .edits:
            return DemoTool(name: "edit_files", category: .edit, source: .builtin, arguments: arguments)
        case .webSearch:
            return DemoTool(name: "web_search", category: .webSearch, source: .server, arguments: arguments)
        case .webFetch:
            return DemoTool(name: "web_fetch", category: .webFetch, source: .server, arguments: arguments)
        case .integration:
            return DemoTool(name: "github_search", category: .integration,
                            source: .mcp(serverID: "github", serverName: "GitHub"), arguments: arguments)
        case .skill:
            return DemoTool(name: "load_skill", category: .skill, source: .skill, arguments: arguments)
        case .think, .tool:
            return DemoTool(name: "lookup", category: .other, source: .builtin, arguments: arguments)
        }
    }
}
