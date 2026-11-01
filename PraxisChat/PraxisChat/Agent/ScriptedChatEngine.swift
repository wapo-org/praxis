import Foundation
import AgentCore

/// Replays a fixed script of runtime events: deterministic runs for tests
/// and `-PraxisEngine scripted`. A script can pause, ask for approval
/// through the request's handler, or hold the run open until it is
/// cancelled (to exercise stop and concurrent runs).
struct ScriptedChatEngine: ChatEngine {
    enum Step: Sendable {
        case event(AgentEvent)
        case wait(Duration)
        /// Emits `toolAwaitingApproval`, asks, emits the resolution, then
        /// continues with `onAllow` or `onDeny`.
        case approval(ApprovalRequest, onAllow: [Step], onDeny: [Step])
        /// Suspends until the run is cancelled.
        case hold
    }

    var script: @Sendable (ChatRunRequest) -> [Step]
    var kind: EngineKind { .scripted }

    init(script: @escaping @Sendable (ChatRunRequest) -> [Step]) {
        self.script = script
    }

    init(_ steps: [Step]) {
        self.script = { _ in steps }
    }

    func run(_ request: ChatRunRequest) -> AsyncStream<AgentEvent> {
        let steps = script(request)
        let approvals = request.approvals
        let isCancelled = request.isCancelled
        return AsyncStream(bufferingPolicy: .unbounded) { continuation in
            let task = Task {
                await Self.play(steps, approvals: approvals, isCancelled: isCancelled, continuation: continuation)
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func play(_ steps: [Step], approvals: any ApprovalHandler, isCancelled: @Sendable () -> Bool,
                             continuation: AsyncStream<AgentEvent>.Continuation) async {
        for step in steps {
            if Task.isCancelled || isCancelled() { return }
            switch step {
            case .event(let event):
                continuation.yield(event)
            case .wait(let duration):
                try? await Task.sleep(for: duration)
            case .approval(let request, let onAllow, let onDeny):
                continuation.yield(.toolAwaitingApproval(request))
                let decision = await approvals.decide(request)
                if Task.isCancelled || isCancelled() { return }
                continuation.yield(.toolApprovalResolved(id: request.id, decision: decision))
                await play(decision == .deny ? onDeny : onAllow, approvals: approvals, isCancelled: isCancelled,
                           continuation: continuation)
            case .hold:
                while !Task.isCancelled, !isCancelled() { try? await Task.sleep(for: .milliseconds(50)) }
            }
        }
    }
}

extension ScriptedChatEngine {
    /// One read step, then an answer echoing the prompt.
    static func echo(pause: Duration = .milliseconds(120)) -> ScriptedChatEngine {
        ScriptedChatEngine { request in
            let prompt = request.prompt
            let call = ToolActivity(
                id: "scripted-\(UUID().uuidString.prefix(8))", name: "read_file", source: .builtin,
                presentation: ToolPresentation(category: .readFile, runningTitle: "Reading the request…",
                                               finishedTitle: "Read the request"),
                arguments: ["path": "request.txt"])
            let answer = "Scripted reply to: \(prompt)"
            return [
                .event(.iterationStarted(1)),
                .event(.toolCallStarted(call)),
                .event(.toolCallReady(call)),
                .event(.toolRunning(id: call.id)),
                .wait(pause),
                .event(.toolProgress(id: call.id, .trace(.note, "scripted engine"))),
                .event(.toolFinished(id: call.id, ToolCompletion(status: .succeeded, summary: "Read the request"))),
                .event(.committed([
                    Message(role: .assistant, parts: [.toolCall(ToolCall(id: call.id, name: call.name, arguments: #"{"path":"request.txt"}"#))]),
                    Message(role: .user, parts: [.toolResult(ToolResult(callID: call.id, toolName: call.name, content: [.text(prompt)]))]),
                ])),
                .event(.iterationStarted(2)),
                .event(.textDelta(blockID: "2.0.0", text: answer)),
                .wait(pause),
                .event(.textFinished(blockID: "2.0.0")),
                .event(.committed([Message(role: .assistant, parts: [.text(answer)])])),
                .event(.finished(.completed)),
            ]
        }
    }
}
