import Foundation
import AgentCore
import AgentMCP

/// Folds runtime events into one turn's blocks. Pure: the clock comes in
/// with each call, and side effects (haptics, persistence, live text) are
/// reported in `Change` for the store to carry out.
///
/// Grouping: a tool or reasoning step arriving when the last block isn't
/// an open activity opens a new activity; any text closes it. That holds
/// for arbitrary interleaving across loop iterations.
///
/// Streaming text never touches the turn: it accumulates here (and in the
/// block's `LiveText`) and is written into the block once it closes, so
/// a token costs neither a turn copy nor a transcript re-render.
struct TurnReducer {
    struct Effects: OptionSet {
        let rawValue: Int
        /// The turn value changed: write it back.
        static let turn = Effects(rawValue: 1 << 0)
        /// A commit point: persist the conversation.
        static let commit = Effects(rawValue: 1 << 1)
        static let finished = Effects(rawValue: 1 << 2)
        static let commandFailed = Effects(rawValue: 1 << 3)
        static let approvalRequested = Effects(rawValue: 1 << 4)
    }

    struct Change {
        var effects: Effects = []
        /// Blocks opened for streaming text.
        var openedText: [UUID] = []
        var appendedText: [(block: UUID, text: String)] = []
        /// Blocks closed, with their final source.
        var closedText: [(block: UUID, source: String)] = []
        var discardedText: [UUID] = []
        var approvalIDs: [String] = []
        var resolvedApprovalIDs: [String] = []
        var alwaysAllowKeys: [String] = []

        mutating func merge(_ other: Change) {
            effects.formUnion(other.effects)
            openedText += other.openedText
            appendedText += other.appendedText
            closedText += other.closedText
            discardedText += other.discardedText
            approvalIDs += other.approvalIDs
            resolvedApprovalIDs += other.resolvedApprovalIDs
            alwaysAllowKeys += other.alwaysAllowKeys
        }
    }

    /// Engine block id → transcript block id (engine ids repeat across runs).
    private var textBlocks: [String: UUID] = [:]
    /// Text of blocks still streaming.
    private var streaming: [UUID: String] = [:]
    /// Reasoning text per engine block id, kept until the step closes.
    private var reasoning: [String: String] = [:]
    /// Step key (tool call id / reasoning key) → location, revalidated on use.
    private var stepLocations: [String: (block: Int, step: Int)] = [:]
    /// Nested approval id → the step key (parent call) whose card shows it.
    private var nestedApprovalParents: [String: String] = [:]
    private var imageTraces: [String: Int] = [:]

    init() {}

    /// Text received so far for a block that is still streaming.
    func streamingText(for block: UUID) -> String? { streaming[block] }

    // MARK: Events

    mutating func reduce(_ event: AgentEvent, into turn: inout Turn, at now: Date) -> Change {
        var change = Change()
        switch event {
        case .iterationStarted, .toolInputDelta, .retrying, .usage, .contextMeasured:
            break

        case .compaction(let id, let update):
            // The transcript is untouched; a divider row marks the spot
            // ("Earlier messages summarized"). It ends the open activity:
            // later steps start a new one below it.
            if case .started = update { closeOpenActivity(in: &turn, at: now) }
            if CompactionActivity.apply(update, key: id, to: &turn, at: now) { change.effects.formUnion([.turn, .commit]) }

        case .textDelta(let blockID, let text):
            let id: UUID
            if let existing = textBlocks[blockID] {
                id = existing
            } else {
                closeOpenActivity(in: &turn, at: now)
                id = UUID()
                textBlocks[blockID] = id
                streaming[id] = ""
                turn.blocks.append(.markdown(id: id, source: "", isStreaming: true))
                change.openedText.append(id)
                change.effects.insert(.turn)
            }
            guard streaming[id] != nil else { break }
            streaming[id, default: ""] += text
            change.appendedText.append((id, text))

        case .textFinished(let blockID):
            guard let id = textBlocks[blockID], let text = streaming.removeValue(forKey: id) else { break }
            let source = text.trimmingCharacters(in: .whitespacesAndNewlines)
            close(textBlock: id, source: source, in: &turn, change: &change)
            change.effects.formUnion([.turn, .commit])

        case .reasoningDelta(let blockID, let text):
            if reasoning[blockID] == nil {
                let key = Self.reasoningKey(blockID)
                appendStep(Step(toolCallID: key, kind: .think, runningSummary: "Thinking…", finalSummary: "Thought",
                                status: .running, startedAt: now), key: key, to: &turn, at: now)
                change.effects.insert(.turn)
            }
            reasoning[blockID, default: ""] += text

        case .reasoningFinished(let blockID):
            let text = reasoning.removeValue(forKey: blockID) ?? ""
            updateStep(Self.reasoningKey(blockID), in: &turn) { step in
                step.status = .succeeded
                step.finalSummary = Self.reasoningSummary(text, elapsed: now.timeIntervalSince(step.startedAt ?? now))
                // Tapping the line shows what was reasoned.
                step.result = StepPresentation.clip(text, limit: StepPresentation.reasoningLimit, singleLine: false)
            }
            change.effects.insert(.turn)

        case .toolCallStarted(let activity), .toolCallReady(let activity):
            if !updateStep(activity.id, in: &turn, { Self.apply(activity, to: &$0) }) {
                var step = Step(toolCallID: activity.id, kind: Self.kind(for: activity),
                                runningSummary: activity.presentation.runningTitle,
                                finalSummary: activity.presentation.finishedTitle,
                                status: .pending, startedAt: now)
                Self.apply(activity, to: &step)
                appendStep(step, key: activity.id, to: &turn, at: now)
            }
            change.effects.insert(.turn)

        case .toolAwaitingApproval(let request):
            let approval = PendingApproval(
                requestID: request.id, title: request.title, reason: request.reason, toolName: request.toolName,
                sourceName: Self.sourceName(request.source), arguments: request.arguments.encodedString(pretty: true),
                parentCallID: request.parentCallID)
            // A call made from inside code shows in its parent's step (the
            // JS run); the id prefix is the fallback for older runtimes.
            let key = request.parentCallID
                ?? (locate(request.id, in: turn) != nil ? request.id : Self.parentKey(request.id))
            let nested = key != request.id
            if locate(key, in: turn) == nil {
                appendStep(Step(toolCallID: key, kind: .tool, runningSummary: request.title, finalSummary: request.title,
                                status: .pending, startedAt: now), key: key, to: &turn, at: now)
            }
            updateStep(key, in: &turn) { step in
                if nested {
                    // Parallel calls from one code run can each wait at once.
                    step.codeApprovals.removeAll { $0.requestID == request.id }
                    step.codeApprovals.append(approval)
                } else {
                    step.approval = approval
                    step.status = .awaitingApproval
                }
            }
            if nested { nestedApprovalParents[request.id] = key }
            // The card needs to be seen: open the activity holding it.
            if let location = locate(key, in: turn) {
                turn.updateActivity(at: location.block) { $0.isExpanded = true }
            }
            change.approvalIDs.append(request.id)
            change.effects.formUnion([.turn, .approvalRequested])

        case .toolApprovalResolved(let id, let decision):
            let parent = nestedApprovalParents.removeValue(forKey: id)
                ?? (locate(id, in: turn) != nil ? nil : Self.parentKey(id))
            updateStep(parent ?? id, in: &turn) { step in
                var note: String
                switch decision {
                case .allowOnce: note = "Allowed once"
                case .allowAlways: note = "Always allowed"
                case .deny: note = "Declined"
                }
                if parent != nil {
                    if let asked = step.codeApprovals.first(where: { $0.requestID == id }) {
                        note += ": " + ([asked.sourceName, asked.toolName].compactMap { $0 }).joined(separator: " · ")
                    }
                    step.codeApprovals.removeAll { $0.requestID == id }
                    if step.approval?.requestID == id { step.approval = nil }
                } else {
                    if step.approval?.requestID == id { step.approval = nil }
                    step.status = decision == .deny ? .denied : .pending
                }
                step.appendTrace(Trace(kind: .note, text: note))
            }
            change.resolvedApprovalIDs.append(id)
            change.effects.insert(.turn)

        case .toolRunning(let id):
            updateStep(id, in: &turn) { step in
                step.status = .running
                if step.kind == .command, step.command == nil {
                    step.command = CommandData(code: "")
                }
                step.command?.isRunning = true
                step.command?.startedAt = now
            }
            change.effects.insert(.turn)

        case .toolProgress(let id, let progress):
            switch progress {
            case .output(let lines):
                updateStep(id, in: &turn) { step in
                    if step.command == nil, step.kind == .command {
                        step.command = CommandData(code: "", isRunning: true)
                    }
                    step.command?.append(lines)
                }
            case .trace(.note, let text) where MCPSignInNotice.parse(text) != nil:
                // A connector refused for missing credentials: the step
                // offers "Sign in to <server>" instead of showing a trace.
                let notice = MCPSignInNotice.parse(text)!
                updateStep(id, in: &turn) { $0.signIn = StepSignIn(serverID: notice.serverID, serverName: notice.serverName) }
            case .trace(let kind, let text):
                let attachment = kind == .image ? imageAttachment(for: text, stepKey: id, in: turn) : nil
                updateStep(id, in: &turn) { $0.appendTrace(Trace(kind: kind, text: text, attachment: attachment)) }
            case .status(let text):
                updateStep(id, in: &turn) { $0.runningSummary = text }
            }
            change.effects.insert(.turn)

        case .toolFinished(let id, let completion):
            var failedCommand = false
            updateStep(id, in: &turn) { step in
                step.status = Self.status(completion.status)
                if !completion.summary.isEmpty {
                    step.finalSummary = StepPresentation.sentenceCase(
                        StepPresentation.stripSource(StepPresentation.plain(completion.summary), source: step.source))
                }
                step.approval = nil
                step.codeApprovals = []
                guard step.command != nil else {
                    // What the tool returned (or why it failed), for the details.
                    if !completion.preview.isEmpty {
                        step.result = StepPresentation.clip(completion.preview, limit: StepPresentation.resultLimit,
                                                            singleLine: false)
                    }
                    return
                }
                let exitCode: Int? = switch completion.status {
                case .succeeded: 0
                case .cancelled: nil
                case .failed, .denied: 1
                }
                step.command?.isRunning = false
                step.command?.exitCode = exitCode
                let started = step.command?.startedAt ?? step.startedAt ?? now
                step.command?.duration = max(now.timeIntervalSince(started), 0)
                if !completion.preview.isEmpty { step.command?.result = completion.preview }
                failedCommand = completion.status == .failed
            }
            change.effects.insert(.turn)
            if failedCommand { change.effects.insert(.commandFailed) }

        case .attemptDiscarded(let blockIDs, let toolCallIDs):
            discard(blockIDs: blockIDs, toolCallIDs: toolCallIDs, in: &turn, change: &change)
            change.effects.insert(.turn)

        case .committed(let messages):
            turn.transcript.append(contentsOf: messages)
            change.effects.formUnion([.turn, .commit])

        case .policyUpdated(let key):
            change.alwaysAllowKeys.append(key)


        case .finished(let outcome):
            change.merge(finish(&turn, outcome: TurnOutcome(outcome), at: now))
        }
        return change
    }

    /// Closes everything still open: streamed text is written into its
    /// block, running activity stops its clock, unfinished steps settle
    /// (cancelled when stopped). Used for `finished` and for a user stop.
    mutating func finish(_ turn: inout Turn, outcome: TurnOutcome, at now: Date) -> Change {
        var change = Change()
        for (id, text) in streaming {
            close(textBlock: id, source: text.trimmingCharacters(in: .whitespacesAndNewlines), in: &turn, change: &change)
        }
        streaming.removeAll()
        let stopped = outcome == .stopped
        let leftover: Step.Status = switch outcome {
        case .stopped: .cancelled
        case .failed: .failed
        default: .succeeded
        }
        for index in turn.blocks.indices {
            turn.updateActivity(at: index) { activity in
                for s in activity.steps.indices where activity.steps[s].isRunning {
                    activity.steps[s].status = leftover
                    activity.steps[s].approval = nil
                    activity.steps[s].codeApprovals = []
                    activity.steps[s].command?.isRunning = false
                }
                guard activity.isRunning else { return }
                activity.isRunning = false
                activity.isStopped = stopped
                activity.elapsed = max(now.timeIntervalSince(activity.startedAt ?? now), activity.elapsed)
            }
        }
        reasoning.removeAll()
        CompactionActivity.dropRunningMarkers(in: &turn)
        turn.isRunning = false
        turn.isFinished = true
        turn.outcome = outcome
        change.effects.formUnion([.turn, .commit, .finished])
        return change
    }

    // MARK: Blocks

    static func endsWithOpenActivity(_ turn: Turn) -> Bool {
        if case .activity(let a)? = turn.blocks.last { return a.isRunning }
        return false
    }

    private mutating func closeOpenActivity(in turn: inout Turn, at now: Date) {
        guard Self.endsWithOpenActivity(turn) else { return }
        turn.updateActivity(at: turn.blocks.count - 1) { activity in
            activity.isRunning = false
            activity.elapsed = max(now.timeIntervalSince(activity.startedAt ?? now), 0)
        }
    }

    private func close(textBlock id: UUID, source: String, in turn: inout Turn, change: inout Change) {
        guard let index = turn.blocks.lastIndex(where: { $0.id == id }) else { return }
        if source.isEmpty {
            turn.blocks.remove(at: index)
            change.discardedText.append(id)
        } else {
            turn.blocks[index] = .markdown(id: id, source: source, isStreaming: false)
            change.closedText.append((id, source))
        }
    }

    private mutating func appendStep(_ step: Step, key: String, to turn: inout Turn, at now: Date) {
        if !Self.endsWithOpenActivity(turn) {
            // Folded from the start: while the run works, the header line
            // carries the live progress; the list is one tap away.
            turn.blocks.append(.activity(ActivityData(isRunning: true, startedAt: now, isExpanded: false)))
        }
        let block = turn.blocks.count - 1
        var stepIndex = 0
        turn.updateActivity(at: block) { activity in
            activity.steps.append(step)
            stepIndex = activity.steps.count - 1
        }
        stepLocations[key] = (block, stepIndex)
    }

    private mutating func discard(blockIDs: [String], toolCallIDs: [String], in turn: inout Turn, change: inout Change) {
        var stepKeys = Set(toolCallIDs)
        var textIDs = Set<UUID>()
        for blockID in blockIDs {
            if let id = textBlocks.removeValue(forKey: blockID) {
                textIDs.insert(id)
                streaming.removeValue(forKey: id)
            }
            reasoning.removeValue(forKey: blockID)
            stepKeys.insert(Self.reasoningKey(blockID))
        }
        turn.blocks.removeAll { textIDs.contains($0.id) }
        change.discardedText += Array(textIDs)
        for index in turn.blocks.indices {
            turn.updateActivity(at: index) { activity in
                activity.steps.removeAll { $0.toolCallID.map(stepKeys.contains) ?? false }
            }
        }
        turn.blocks.removeAll { if case .activity(let a) = $0 { return a.steps.isEmpty }; return false }
        reindex(turn)
    }

    // MARK: Steps

    private func locate(_ key: String, in turn: Turn) -> (block: Int, step: Int)? {
        if let cached = stepLocations[key], turn.blocks.indices.contains(cached.block),
           case .activity(let a) = turn.blocks[cached.block],
           a.steps.indices.contains(cached.step), a.steps[cached.step].toolCallID == key {
            return cached
        }
        for (b, block) in turn.blocks.enumerated().reversed() {
            if case .activity(let a) = block, let s = a.steps.lastIndex(where: { $0.toolCallID == key }) {
                return (b, s)
            }
        }
        return nil
    }

    @discardableResult
    private mutating func updateStep(_ key: String, in turn: inout Turn, _ body: (inout Step) -> Void) -> Bool {
        guard let location = locate(key, in: turn) else { return false }
        stepLocations[key] = location
        turn.updateActivity(at: location.block) { body(&$0.steps[location.step]) }
        return true
    }

    private mutating func reindex(_ turn: Turn) {
        stepLocations.removeAll(keepingCapacity: true)
        for (b, block) in turn.blocks.enumerated() {
            guard case .activity(let a) = block else { continue }
            for (s, step) in a.steps.enumerated() {
                if let key = step.toolCallID { stepLocations[key] = (b, s) }
            }
        }
    }

    private static func apply(_ activity: ToolActivity, to step: inout Step) {
        step.kind = Self.kind(for: activity)
        // The line: who ran it, what it did, what it was about. The raw
        // call (formatted arguments) waits behind a tap.
        let titles = StepPresentation.titles(for: activity)
        step.source = titles.source
        step.title = titles.finished
        step.detail = titles.detail
        step.runningSummary = titles.running
        step.finalSummary = titles.finished
        // Code shows itself in its card; everything else shows its input.
        if step.kind != .command { step.arguments = StepPresentation.formattedArguments(for: activity) }
        guard step.kind == .command, let arguments = activity.arguments else { return }
        let code = code(in: arguments) ?? activity.name
        let language = arguments["language"]?.stringValue ?? language(for: activity)
        if step.command == nil {
            step.command = CommandData(code: code, language: language)
        } else {
            step.command?.code = code
            step.command?.language = language
        }
    }

    /// Image traces show the turn attachment they name (by id or file
    /// name); otherwise the next attachment in order.
    private mutating func imageAttachment(for text: String, stepKey: String, in turn: Turn) -> Attachment? {
        let n = imageTraces[stepKey, default: 0]
        imageTraces[stepKey] = n + 1
        if let byID = turn.attachments.first(where: { text.contains($0.id.uuidString) }) { return byID }
        let named = turn.attachments.filter { !$0.name.isEmpty && text.hasSuffix($0.name) }
        if named.count == 1 { return named[0] }
        return turn.attachments.indices.contains(n) ? turn.attachments[n] : nil
    }

    // MARK: Mapping

    static func kind(for activity: ToolActivity) -> StepKind {
        switch activity.presentation.category {
        case .integration: return .integration
        case .command: return .command
        case .webSearch: return .webSearch
        case .webFetch: return .webFetch
        case .readFile: return .readFile
        case .edit: return .edits
        case .skill: return .skill
        case .other: return .tool
        }
    }

    static func status(_ status: ToolStatus) -> Step.Status {
        switch status {
        case .succeeded: return .succeeded
        case .failed: return .failed
        case .denied: return .denied
        case .cancelled: return .cancelled
        }
    }

    static func code(in arguments: JSONValue) -> String? {
        for key in ["code", "command", "script", "cmd"] {
            if let value = arguments[key]?.stringValue { return value }
        }
        return nil
    }

    static func language(for activity: ToolActivity) -> String {
        if case .javascript = activity.source { return "javascript" }
        return activity.name.lowercased().contains("javascript") ? "javascript" : "bash"
    }

    static func sourceName(_ source: ToolSource) -> String? {
        switch source {
        case .mcp(_, let name): return name
        case .javascript: return "Code"
        case .skill: return "Skill"
        case .builtin, .server: return nil
        }
    }

    /// First line of the reasoning, plain and short; a duration when the
    /// model kept its reasoning to itself.
    static func reasoningSummary(_ text: String, elapsed: TimeInterval) -> String {
        let line = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "#*_ ").union(.whitespaces)) }
            .first { !$0.isEmpty } ?? ""
        if line.isEmpty { return "Thought for \(DurationFormatter.format(max(elapsed, 1)))" }
        return line.count > 96 ? String(line.prefix(95)) + "…" : line
    }

    static func reasoningKey(_ blockID: String) -> String { "reasoning:\(blockID)" }

    /// `parent/xyz` → `parent` (approvals for calls made from inside code).
    static func parentKey(_ id: String) -> String {
        id.split(separator: "/", maxSplits: 1).first.map(String.init) ?? id
    }
}

extension Turn {
    /// Mutates an activity block in place. The block is swapped out first
    /// so the extracted value holds the only reference to its steps and
    /// lines — appending output never copies the whole activity.
    mutating func updateActivity(at index: Int, _ body: (inout ActivityData) -> Void) {
        guard blocks.indices.contains(index), case .activity(var activity) = blocks[index] else { return }
        blocks[index] = .markdown(id: activity.id, source: "", isStreaming: false)
        body(&activity)
        blocks[index] = .activity(activity)
    }
}
