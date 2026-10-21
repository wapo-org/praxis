import Foundation

/// Demo events (spec §10). The engine emits an `AsyncStream<AgentEvent>`;
/// `ChatStore` folds events into transcript blocks.
enum AgentEvent {
    case activityStarted(id: UUID)
    case stepStarted(id: UUID, step: Step)
    case traceAppended(stepID: UUID, trace: Trace)
    case commandStarted(stepID: UUID, command: CommandData)
    case commandOutput(stepID: UUID, line: String)
    case commandFinished(stepID: UUID, exitCode: Int, duration: TimeInterval)
    case stepFinished(id: UUID, finalSummary: String)
    case activityFinished(id: UUID, elapsed: TimeInterval)
    case textDelta(blockID: UUID, chunk: String)
    case textBlockStarted(id: UUID)
    case messageFinished
}

/// In-app demo engine — no backend (spec preamble). Realistic jittered
/// timing: steps 300–1200ms, output lines 40–120ms, text chunks of
/// 2–6 words every 25–60ms. Effort scales steps/length (~3s Low → ~15s
/// Max); the model scales streaming speed; Web search off removes web steps.
struct DemoAgentEngine: Sendable {
    func run(prompt: String, effort: Effort, model: AIModel, webSearch: Bool, hasAttachments: Bool) -> AsyncStream<AgentEvent> {
        let scenario = Scenarios.pick(prompt: prompt, hasAttachments: hasAttachments, webSearch: webSearch)
        return AsyncStream { continuation in
            let task = Task {
                await emit(scenario: scenario, effort: effort, model: model, continuation: continuation)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func emit(scenario: Scenario, effort: Effort, model: AIModel,
                      continuation: AsyncStream<AgentEvent>.Continuation) async {
        let started = Date()
        func sleep(_ base: Double, _ jitter: Double) async -> Bool {
            let ms = max(10, (base + Double.random(in: 0...jitter)) * 1000)
            do { try await Task.sleep(for: .milliseconds(Int(ms))) } catch { return false }
            return !Task.isCancelled
        }

        // Scale the step list by effort, always keeping ≥2 steps.
        let scaledSteps = Array(scenario.steps.prefix(max(2, Int((Double(scenario.steps.count) * effort.stepScale).rounded()))))
        let pace = (effort.runSeconds / 8.0) // baseline script ≈8s at High

        let activityID = UUID()
        continuation.yield(.activityStarted(id: activityID))

        for script in scaledSteps {
            if Task.isCancelled { return }
            var step = Step(kind: script.kind, runningSummary: script.running, finalSummary: script.final, isRunning: true)
            continuation.yield(.stepStarted(id: activityID, step: step))
            if await sleep(0.3 * pace, 0.9 * pace) == false { return }

            for trace in script.traces {
                continuation.yield(.traceAppended(stepID: step.id, trace: trace))
                if await sleep(0.08, 0.12) == false { return }
            }

            if let cmd = script.command {
                var command = CommandData(code: cmd.code, isRunning: true, isExpanded: true)
                let commandID = command.id
                step.command = command
                continuation.yield(.commandStarted(stepID: step.id, command: command))
                let cmdStart = Date()
                for line in cmd.lines {
                    if await sleep(0.04, 0.08) == false { return }
                    continuation.yield(.commandOutput(stepID: step.id, line: line))
                }
                let duration = Date().timeIntervalSince(cmdStart)
                command.isRunning = false
                continuation.yield(.commandFinished(stepID: step.id, exitCode: cmd.exitCode, duration: max(duration, 0.4)))
                _ = commandID
            }

            step.isRunning = false
            continuation.yield(.stepFinished(id: step.id, finalSummary: script.final))
            if await sleep(0.15 * pace, 0.3 * pace) == false { return }
        }

        let elapsed = Date().timeIntervalSince(started)
        continuation.yield(.activityFinished(id: activityID, elapsed: elapsed))

        // Stream the answer in 2–6 word chunks (coalesced by the store).
        await streamText(scenario.answer, model: model, continuation: continuation, sleep: sleep)
        if Task.isCancelled { return }

        if let second = scenario.secondSteps, let after = scenario.answerAfterSecond {
            let secondID = UUID()
            continuation.yield(.activityStarted(id: secondID))
            for script in second {
                if Task.isCancelled { return }
                let step = Step(kind: script.kind, runningSummary: script.running, finalSummary: script.final, isRunning: true)
                continuation.yield(.stepStarted(id: secondID, step: step))
                if await sleep(0.3 * pace, 0.6 * pace) == false { return }
                for trace in script.traces { continuation.yield(.traceAppended(stepID: step.id, trace: trace)) }
                continuation.yield(.stepFinished(id: step.id, finalSummary: script.final))
            }
            continuation.yield(.activityFinished(id: secondID, elapsed: Date().timeIntervalSince(started) - elapsed))
            await streamText(after, model: model, continuation: continuation, sleep: sleep)
            if Task.isCancelled { return }
        }

        continuation.yield(.messageFinished)
    }

    private func streamText(_ markdown: String, model: AIModel,
                            continuation: AsyncStream<AgentEvent>.Continuation,
                            sleep: (Double, Double) async -> Bool) async {
        let blockID = UUID()
        continuation.yield(.textBlockStarted(id: blockID))
        let words = markdown.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        var i = 0
        while i < words.count {
            if Task.isCancelled { return }
            let n = Int.random(in: 2...6)
            let chunk = words[i..<min(i + n, words.count)].joined(separator: " ") + " "
            continuation.yield(.textDelta(blockID: blockID, chunk: chunk))
            i += n
            let delay = 0.04 / model.streamMultiplier
            if await sleep(delay, 0.02) == false { return }
        }
    }
}
