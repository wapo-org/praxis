import SwiftUI

// Component previews: light / dark / each state (spec §2).

#Preview("Composer — idle (light)") {
    ZStack {
        Praxis.canvas.ignoresSafeArea()
        VStack { Spacer(); ComposerPreview() }
    }
}

#Preview("Composer — idle (dark)") {
    ZStack {
        Praxis.canvas.ignoresSafeArea()
        VStack { Spacer(); ComposerPreview() }
    }
    .preferredColorScheme(.dark)
}

private struct ComposerPreview: View {
    @State private var store = ChatStore()
    @State private var tray = false
    @Namespace private var ns
    var body: some View {
        ComposerView(trayOpen: $tray, namespace: ns) {}
            .environment(store)
            .environment(store.haptics)
            .padding(.bottom, 12)
    }
}

#Preview("UserBubble — short + long") {
    VStack(spacing: 16) {
        UserBubble(turn: Turn(userText: "Add haptics to buttons"))
        UserBubble(turn: Turn(userText: "Please audit every glass surface in the composer and tray for contrast, then fix anything under 4.5 to 1."))
    }
    .padding(20)
    .background(Praxis.canvas)
}

#Preview("AgentActivity — collapsed / running / finished") {
    let collapsed = Scenarios.seededConversations().first?.turns.first?.blocks.first
    VStack(alignment: .leading, spacing: 24) {
        if case .activity(let a) = collapsed {
            AgentActivityView(activity: a, turnID: UUID())
        }
        AgentActivityView(activity: ActivityData(
            steps: [Step(kind: .command, runningSummary: "Running a shell command…", finalSummary: "",
                         command: CommandData(code: "xcodebuild build", lines: ["** BUILD SUCCEEDED **"], exitCode: 0, duration: 1.8, isExpanded: true))],
            isRunning: true, isExpanded: true), turnID: UUID())
    }
    .padding(20)
    .background(Praxis.canvas)
}

#Preview("AgentActivity — dark") {
    AgentActivityView(activity: ActivityData(
        steps: [Step(kind: .webSearch, runningSummary: "", finalSummary: "Searched the web for progressive blur")],
        isRunning: false, elapsed: 22, isExpanded: true), turnID: UUID())
        .padding(20)
        .background(Praxis.canvas)
        .preferredColorScheme(.dark)
}

#Preview("AgentMessage — long read with chips") {
    ScrollView {
        AgentMessageView(source: Scenarios.research.answer, isStreaming: false)
            .padding(20)
    }
    .background(Praxis.canvas)
}

#Preview("AgentMessage — streaming") {
    AgentMessageView(source: "Streaming words fade in per run with a small rise, driven by a TextRenderer — never a view per word.", isStreaming: true)
        .padding(20)
        .background(Praxis.canvas)
}

#Preview("CodeBlock") {
    CodeBlockView(language: "bash", code: "xcodebuild -scheme PraxisChat build\n** BUILD SUCCEEDED **")
        .padding(20)
        .background(Praxis.canvas)
}
