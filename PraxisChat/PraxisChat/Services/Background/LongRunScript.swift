import Foundation
import AgentCore

extension ScriptedChatEngine {
    /// UI test long run (-PraxisEngine scripted -PraxisLongRun YES); observes normal cancellation.
    static func longRun(pause: Duration = .seconds(20)) -> ScriptedChatEngine {
        ScriptedChatEngine { request in
            let tag = String(request.conversationID.uuidString.prefix(4))
            var steps: [Step] = [.event(.iterationStarted(1))]
            let tools: [(id: String, name: String, category: ToolCategory, running: String, finished: String)] = [
                ("lr-read", "read_file", .readFile, "Reading the project…", "Read the project"),
                ("lr-search", "web_search", .webSearch, "Searching the web…", "Searched the web"),
                ("lr-plan", "write_file", .edit, "Writing the plan…", "Wrote the plan"),
            ]
            for (index, tool) in tools.enumerated() {
                let call = ToolActivity(
                    id: "\(tool.id)-\(tag)", name: tool.name, source: .builtin,
                    presentation: ToolPresentation(category: tool.category, runningTitle: tool.running,
                                                   finishedTitle: tool.finished),
                    arguments: ["path": "project.txt"])
                steps += [
                    .event(.toolCallStarted(call)),
                    .event(.toolCallReady(call)),
                    .event(.toolRunning(id: call.id)),
                    .wait(pause),
                    .event(.toolProgress(id: call.id, .trace(.note, "still working on \(tool.name)"))),
                    .wait(pause),
                    .event(.toolFinished(id: call.id, ToolCompletion(status: .succeeded, summary: tool.finished))),
                    .event(.committed([
                        Message(role: .assistant, parts: [.toolCall(ToolCall(id: call.id, name: tool.name,
                            arguments: #"{"path":"project.txt"}"#))]),
                        Message(role: .user, parts: [.toolResult(ToolResult(callID: call.id, toolName: tool.name,
                            content: [.text("\(tool.finished): ok")]))]),
                    ])),
                ]
                // Emit text after first tool so pause tests hit mixed partial state (open step + text).
                if index == 0 {
                    steps += [
                        .event(.textDelta(blockID: "lr-draft", text: "First findings: ")),
                        .wait(pause),
                        .event(.textDelta(blockID: "lr-draft", text: "the project reads well.")),
                        .event(.textFinished(blockID: "lr-draft")),
                        .event(.committed([Message(role: .assistant,
                            parts: [.text("First findings: the project reads well.")])])),
                    ]
                }
            }
            let approval = ApprovalRequest(id: "lr-approval-\(tag)", toolName: "run_command", source: .builtin,
                                           arguments: ["command": "make ship"],
                                           reason: "The plan wants to run make ship.",
                                           title: "Running make ship…")
            let closing: [Step] = [
                .event(.iterationStarted(2)),
                .event(.textDelta(blockID: "lr-answer", text: "The long run finished.")),
                .event(.textFinished(blockID: "lr-answer")),
                .event(.committed([Message(role: .assistant, parts: [.text("The long run finished.")])])),
                .event(.finished(.completed)),
            ]
            steps.append(.approval(approval, onAllow: closing, onDeny: closing))
            return steps
        }
    }
}
