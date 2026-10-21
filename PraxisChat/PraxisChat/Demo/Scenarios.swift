import Foundation

struct CommandScript {
    var code: String
    var lines: [String]
    var exitCode: Int
}

struct StepScript {
    var kind: StepKind
    var running: String
    var final: String
    var traces: [Trace] = []
    var command: CommandScript?
}

struct Scenario {
    var steps: [StepScript]
    var answer: String
    /// Optional second activity block interleaved between paragraphs (§10).
    var secondSteps: [StepScript]?
    var answerAfterSecond: String?
}

/// Scenario scripts (spec §10). Chips ride real markdown:
/// `[file](praxis-file://…)` FileRef, `` `code` `` CodePill,
/// `[title](https://…)` LinkRef, `[app](praxis-app://…)` integration.
enum Scenarios {
    // Demo-only rotation counter; the engine call site is serialized.
    nonisolated(unsafe) private static var roundRobin = 0

    static func pick(prompt: String, hasAttachments: Bool, webSearch: Bool) -> Scenario {
        let p = prompt.lowercased()
        var s: Scenario
        if p.contains("haptic") { s = haptics }
        else if p.contains("fail") || p.contains("build") && p.contains("why") || p.contains("error") { s = failing }
        else if p.contains("research") || p.contains("blur") || p.contains("search") || p.contains("what") || p.contains("why") || p.contains("audit") || p.contains("contrast") { s = research }
        else {
            roundRobin += 1
            s = [haptics, research, failing][roundRobin % 3]
        }
        if !webSearch {
            s.steps.removeAll { $0.kind == .webSearch || $0.kind == .webFetch }
            s.secondSteps?.removeAll { $0.kind == .webSearch || $0.kind == .webFetch }
        }
        if hasAttachments {
            s.steps.insert(StepScript(
                kind: .think, running: "Analyzing attachments…", final: "Analyzed the attached screenshots",
                traces: [Trace(kind: .api, text: "vision.describe × attachments → layout, contrast, hierarchy")]
            ), at: 0)
        }
        return s
    }

    // (a) Haptics: read → edit 4 components → build exit 0 (§10a)
    static let haptics = Scenario(
        steps: [
            StepScript(kind: .readFile, running: "Reading button components…", final: "Read 4 button components",
                       traces: [Trace(kind: .skill, text: "praxis-ui · audit-surface")]),
            StepScript(kind: .edits, running: "Adding haptics to buttons…", final: "Edited 4 components to use sensoryFeedback",
                       traces: [
                           Trace(kind: .api, text: "POST /v1/edits — ComposerView.swift, PlusTray.swift"),
                           Trace(kind: .api, text: "POST /v1/edits — UserBubble.swift, AgentActivityView.swift"),
                       ]),
            StepScript(kind: .command, running: "Running a shell command…", final: "Ran a shell command to build the preview",
                       command: CommandScript(code: "xcodebuild -project PraxisChat.xcodeproj -scheme PraxisChat build",
                                              lines: ["CompileSwift Inter-400.ttf", "Link PraxisChat.app", "Validate PraxisChat.app", "** BUILD SUCCEEDED **"], exitCode: 0)),
            StepScript(kind: .integration, running: "Checking connected tools…", final: "Checked [GitHub](praxis-app://GitHub) for open feedback",
                       traces: [Trace(kind: .api, text: "GET api.github.com/repos/praxis/chat/pulls → 200")]),
        ],
        answer: """
        ## Haptics are in

        Every tappable surface now answers on touch-down. The composer buttons use `sensoryFeedback` with a light impact on send, a selection tick for mode and effort changes, and a soft impact when the tray settles closed.

        - [ComposerView.swift](praxis-file://ComposerView.swift) — send and mic morphs fire `.light` once per gesture
        - [PlusTray.swift](praxis-file://PlusTray.swift) — segment changes fire `.selection`
        - [AgentActivityView.swift](praxis-file://AgentActivityView.swift) — expanding a command fires nothing; scroll never fires

        > Feedback starts in the same frame as the touch. If a haptic waits for an animation, it feels like lag — so every trigger is bound to the press, not the completion.

        The build is green: run `xcodebuild build` any time to verify. No haptics fire on scroll, and none fire twice for one gesture.
        """)

    // (b) Research: web search/fetch traces, LinkRefs + quote (§10b)
    static let research = Scenario(
        steps: [
            StepScript(kind: .webSearch, running: "Searching the web…", final: "Searched the web for progressive blur techniques",
                       traces: [Trace(kind: .api, text: "GET search.praxis.dev?q=progressive+blur+scrim → 200")]),
            StepScript(kind: .webFetch, running: "Fetching sources…", final: "Fetched 3 sources on feathered blur",
                       traces: [
                           Trace(kind: .api, text: "GET developer.apple.com/documentation/swiftui → 200"),
                           Trace(kind: .api, text: "GET wapo-dp.vercel.app/#/materials → 200"),
                       ]),
            StepScript(kind: .think, running: "Synthesizing findings…", final: "Synthesized a recommendation",
                       traces: [Trace(kind: .skill, text: "praxis-research · cite-sources")]),
        ],
        answer: """
        ## Progressive blur, the calm way

        A progressive scrim is a blur field, not a gradient with ambitions. The [Praxis materials ramp](https://wapo-dp.vercel.app/#/materials) feathers blur from full strength at the chrome edge to zero about 24pt past the toolbar, paired with a canvas tint that fades from 65% to nothing.

        > Materials that bend light instead of casting shadows. Depth comes from glass, blur and light — never from a drop shadow.

        Three rules keep it invisible:

        - No line where the scrim starts: the mask needs at least six stops
        - Tint and blur fade together, or text ghosts through
        - The stock `scrollEdgeEffectStyle` goes on top, the custom field underneath

        The reference implementation lives in [ProgressiveBlurScrim.swift](praxis-file://ProgressiveBlurScrim.swift) — it stacks masked blur bands over a `UIVisualEffectView`, so it stays on public APIs. Pair it with `safeAreaBar` so the composer participates in the bottom effect, and read the [agent activity spec](https://wapo-dp.vercel.app/#/components/agent-activity) for how the same feather applies to command output.
        """,
        secondSteps: [
            StepScript(kind: .webFetch, running: "Verifying contrast ratios…", final: "Verified contrast against the glass ramp",
                       traces: [Trace(kind: .api, text: "GET webaim.org/resources/contrastchecker → 200")]),
        ],
        answerAfterSecond: """
        One more check: text over Thin glass only clears 4.5:1 on calm content. Anything carrying body text sits on Regular or Thick — that is the legibility floor, and it is why the plus tray never drops below Thick.
        """)

    // (c) Failing command: exit 1 destructive, retry, exit 0 (§10c)
    static let failing = Scenario(
        steps: [
            StepScript(kind: .command, running: "Running a shell command…", final: "Ran the test suite — 1 failure",
                       command: CommandScript(code: "xcodebuild test -scheme PraxisChat",
                                              lines: ["Test Case 'ComposerTests.testMicMorph' started", "XCTAssertEqual failed: mic did not morph to send", "Executed 1 test, with 1 failure"], exitCode: 1)),
            StepScript(kind: .readFile, running: "Reading the failing test…", final: "Read ComposerTests and the morph condition",
                       traces: [Trace(kind: .skill, text: "praxis-debug · read-before-edit")]),
            StepScript(kind: .edits, running: "Fixing the morph condition…", final: "Edited the composer to morph on attachment as well as text"),
            StepScript(kind: .command, running: "Re-running the tests…", final: "Re-ran the test suite — all passing",
                       command: CommandScript(code: "xcodebuild test -scheme PraxisChat",
                                              lines: ["Test Case 'ComposerTests.testMicMorph' passed (0.42s)", "Executed 12 tests, with 0 failures"], exitCode: 0)),
        ],
        answer: """
        ## Found it, fixed it, proved it

        The mic only morphed into send when the field had text. Attachments alone left it as a mic, so `testMicMorph` failed with exit 1. The fix is one condition in [ComposerView.swift](praxis-file://ComposerView.swift): morph when there is text **or** an attachment.

        The retry passes clean — 12 tests, 0 failures. Worth keeping the failing run in the transcript: the red `EXIT 1` and the green `EXIT 0` tell the whole story without a paragraph of apology.
        """)

    /// Seeded launch conversation (spec §5): collapsed 3m 51s block,
    /// long-read answer with every chip type, then a second turn.
    static func seededConversations() -> [Conversation] {
        var activity = ActivityData(isRunning: false, elapsed: 231)
        activity.steps = [
            Step(kind: .readFile, runningSummary: "", finalSummary: "Read 6 files across the design system"),
            Step(kind: .edits, runningSummary: "", finalSummary: "Edited 4 components to use sensoryFeedback"),
            Step(kind: .command, runningSummary: "", finalSummary: "Ran a shell command to build the preview",
                 command: CommandData(code: "xcodebuild -project PraxisChat.xcodeproj -scheme PraxisChat build",
                                      lines: ["** BUILD SUCCEEDED **"], exitCode: 0, duration: 1.8)),
        ]
        activity.isExpanded = false
        let turn1 = Turn(
            userText: "Add haptics to buttons",
            blocks: [
                .activity(activity),
                .markdown(id: UUID(), source: haptics.answer + "\n\n---\n\nThat covers the composer, the tray and the activity rows. The remaining surfaces — history rows and suggestion capsules — already inherit the press style, so they pick the same feedback up for free.", isStreaming: false),
            ],
            isFinished: true)

        var second = ActivityData(isRunning: false, elapsed: 22)
        second.steps = [Step(kind: .webSearch, runningSummary: "", finalSummary: "Searched the web and fetched 3 sources")]
        second.isExpanded = false
        let turn2 = Turn(
            userText: "Research progressive blur",
            blocks: [
                .markdown(id: UUID(), source: research.answer, isStreaming: false),
                .activity(second),
                .markdown(id: UUID(), source: research.answerAfterSecond ?? "", isStreaming: false),
            ],
            isFinished: true)

        let day: TimeInterval = 86_400
        return [
            Conversation(title: "Add haptics to buttons",
                         updatedAt: Date(timeIntervalSinceNow: -5 * day),
                         turns: [turn1, turn2], isPinned: true),
            Conversation(title: "Audit glass contrast",
                         updatedAt: Date(timeIntervalSinceNow: -12 * day), turns: [
                Turn(userText: "Audit glass contrast", blocks: [
                    .markdown(id: UUID(), source: research.answer, isStreaming: false)], isFinished: true),
            ]),
            Conversation(title: "Progressive blur research",
                         updatedAt: Date(timeIntervalSinceNow: -21 * day), turns: [
                Turn(userText: "Research progressive blur", blocks: [
                    .markdown(id: UUID(), source: "Short answer: stack masked blur bands, fade the tint with them, and never let a scrim edge show. Details in [ProgressiveBlurScrim.swift](praxis-file://ProgressiveBlurScrim.swift).", isStreaming: false)], isFinished: true),
            ]),
            Conversation(title: "Build failure triage",
                         updatedAt: Date(timeIntervalSinceNow: -21 * day), turns: [
                Turn(userText: "Why is my build failing?", blocks: [
                    .markdown(id: UUID(), source: failing.answer, isStreaming: false)], isFinished: true),
            ]),
            Conversation(title: "Welcome to Praxis",
                         updatedAt: Date(timeIntervalSinceNow: -30 * day), turns: []),
        ]
    }
}
