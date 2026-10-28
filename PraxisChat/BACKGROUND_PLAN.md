# Background runs + Live Activity — plan (item 11)

Orchestrator: bg. Workers: bg-runtime, bg-live. Target: iOS 26, Swift 6.
App bundle id: `com.praxis.chat.preview`. Widget bundle id:
`com.praxis.chat.preview.LiveActivity`.

Every API name below was verified against the iOS 26.5 SDK in
`/Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS26.5.sdk`
(headers + `.swiftinterface` + `.apinotes`), and every behaviour claim
has a doc URL in §9. Third-party summaries that contradicted the SDK
headers were discarded in favour of the headers (noted where relevant).

## 0. Decisions up front (the whole plan on one page)

1. A run the user started keeps running after they leave the app via
   `BGContinuedProcessingTask` (iOS 26, user-initiated, system progress
   UI). Submitted at send time, while foregrounded, with a per-run
   wildcard id. Progress is reported through the task's `NSProgress`
   (mandatory — stalled tasks are forcibly expired).
2. Fallback is `beginBackgroundTask` (~30 s grace) when the continued
   task can't be submitted. `BGProcessingTask`/`BGAppRefreshTask` are
   NOT used for runs (opportunistic, system-scheduled, wrong tool).
   Background `URLSession` is NOT used (upload/download only, no SSE).
   The `audio` background mode is NEVER used for runs (App Review
   2.5.4); it belongs to voice recording only.
3. On expiry the run is settled exactly like `stop()` (drain, deny
   approvals, keep partial blocks and committed transcript) with a new
   `TurnOutcome.pausedBackground` ("Paused in background"), then saved.
   `setTaskCompleted(success: true)` after a clean checkpoint, so the
   system doesn't show a "Task Failed" card.
4. Continue = a NEW turn ("Continue") whose replayed history includes
   the paused turn's committed transcript — i.e. the run re-sends from
   the last completed step, which the append-only transcript allows.
   No runtime changes, no re-execution of finished tool calls, works
   with every engine. The old turn keeps its partial answer; the
   Continue button only shows on the last turn.
5. Approvals while backgrounded: local notification with Approve/Deny
   actions (`.foreground`, decision made in-app — zero IPC risk) plus
   the Live Activity showing "Needs approval". In-activity
   Approve/Deny buttons via `LiveActivityIntent` were evaluated:
   allowed by the API but need App Group IPC + polling while
   backgrounded for a security-sensitive decision — deferred, the
   notification path covers lock-screen approve/deny.
6. Completion while backgrounded: local notification with the first
   line of the answer. Notification permission is requested the first
   time a run is backgrounded — never at launch.
7. The Live Activity is LOCAL ONLY (no push, zero hosting). One
   activity per active run, keyed by conversation; started at send,
   throttled client-side (phase changes + at most ~1 update/s),
   `staleDate` advanced on every update, ended with a final state and
   `.after(...)` dismissal. Answer text is NEVER streamed into it
   (lock-screen privacy + 4 KB limit + update budget): it shows step
   titles from `StepPresentation`, the same one-line text as the
   activity rows.
8. Tapping the activity deep-links to the chat via a registered
   `praxis-app://chat/<conversationID>` URL (the scheme already exists
   as an in-markdown convention; this registers it for real).
9. The widget extension is a new target `LiveActivityWidget` with a
   synchronized folder; `RunActivityAttributes` is one shared file,
   in the app target via sync and in the widget target via an explicit
   file reference. bg (this commit) pre-seeds the `Info.plist` keys
   and the `RunActivityReporter` protocol so the workers never edit
   the same hot spots.

## 1. What iOS allows

### 1.1 `BGContinuedProcessingTask` (the main path, iOS 26+)

- Class: `BGContinuedProcessingTask : BGTask, NSProgressReporting`,
  `API_AVAILABLE(ios(26.0))`, unavailable on macOS/tvOS/visionOS/
  watchOS/Mac Catalyst. Verified in `BackgroundTasks.framework/
  Headers/BGTask.h`.
- The task vends `progress: NSProgress` (via `NSProgressReporting`,
  `Foundation.framework/Headers/NSProgress.h`) and
  `updateTitle(_:subtitle:)` for the system UI. The header mandates
  progress reporting during runtime: "Tasks that appear stalled may
  be forcibly expired by the scheduler."
- Request: `BGContinuedProcessingTaskRequest(identifier:title:
  subtitle:)`. `earliestBeginDate` is IGNORED (scheduler uses now) —
  the task starts immediately or shortly after submission. Submission
  strategy `.fail`/`.queue` (header enum
  `BGContinuedProcessingTaskRequestSubmissionStrategy{Fail,Queue}`,
  default Queue). Queued requests are cancelled if the user removes
  the app from the switcher.
- Identifiers use wildcard notation: Info.plist holds the prefix
  ending in `.*` (e.g. `com.praxis.chat.preview.run.*`), each
  submission appends a unique suffix. Prefix must contain the app's
  bundle id.
- Registration (`register(forTaskWithIdentifier:using:
  launchHandler:)`, Swift name verified in
  `BackgroundTasks.apinotes`) for continued tasks is EXEMPT from the
  must-register-before-didFinishLaunching rule — register dynamically
  at send time, one id per run.
- `UIBackgroundModes` must contain `processing` (continued processing
  rides on the processing capability; without a declared mode,
  submission fails with `BGTaskScheduler.Error.notPermitted`).
- `BGTaskScheduler.supportedResources` reports `.gpu` only where
  background GPU is available; we need no GPU (default resources =
  background CPU + network), so no entitlement is required.
- Errors are `BGTaskScheduler.Error`: `.unavailable` (includes "the
  app is running on Simulator which doesn't support background
  processing" — i.e. submission fails in the simulator, see §7),
  `.tooManyPendingTaskRequests`, `.notPermitted`,
  `.immediateRunIneligible` (only with `.fail` strategy).
- Docs: [Performing long-running tasks on iOS and
  iPadOS](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados),
  [BGContinuedProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask),
  WWDC25 session 227 "Finish tasks in the background"
  (https://developer.apple.com/videos/play/wwdc2025/227/).

### 1.2 `beginBackgroundTask` (the fallback)

- `UIApplication.beginBackgroundTask(withName:expirationHandler:)`
  / `endBackgroundTask(_:)` / `backgroundTimeRemaining`, verified in
  `UIKit.framework/Headers/UIApplication.h`. About 30 s, not
  guaranteed. Used ONLY when continued-task submission fails, and to
  buy time for the expiry checkpoint. Always balanced with
  `endBackgroundTask`; never left dangling (the system kills apps
  that don't end their tasks).

### 1.3 Deliberately NOT used

- `BGProcessingTask` / `BGAppRefreshTask`: opportunistic,
  system-scheduled (usage patterns, idle device, possibly days of
  delay), for maintenance/fetch — not for continuing a live
  user-initiated run. We schedule neither.
- Background `URLSession`
  (`backgroundSessionConfigurationWithIdentifier:`, verified in
  `NSURLSession.h`): hands upload/download tasks to a system daemon —
  no delegate data callbacks, no streaming response bodies, so SSE
  token streams and interactive tool loops cannot run on it.
- `audio` background mode for runs: App Review Guideline 2.5.4 —
  "Multitasking apps may only use background services for their
  intended purposes"
  (https://developer.apple.com/app-store/review/guidelines/). A chat
  agent is not audio playback; abusing it risks rejection. `audio`
  in `UIBackgroundModes` belongs to voice recording only (agreed
  with the voice orchestrator; resolution at integration = union of
  values, keeping both).

### 1.4 The agent's needs, mapped to the above

A run: an SSE stream lasting seconds to minutes, local JS execution
(QuickJS), local MCP tool calls, and possible pauses for approvals
or elicitations. Under a continued task the process keeps running
with CPU + network, so the existing engine loop works unchanged —
no streaming transport changes. JS/MCP are local compute and need
no entitlement. The pain points are all lifecycle, not compute:
graceful expiry, approvals without a screen, completion notices,
and visible progress. That is what §3–§4 design.

## 2. Strategy per phase (bg-runtime)

All of this lives in NEW files under
`PraxisChat/PraxisChat/Services/Background/` (auto-picked-up by the
synchronized folder; no pbxproj edits). Edits to hot-spot files
(`ChatStore.swift`, `ChatScreen.swift`, `TurnOutcome` in
`Demo/Models.swift`) stay to a few calling lines each, no
refactoring — blur, tray, picker and voice all touch nearby code.

### 2.1 Run start (foreground): submit the continued task

In `ChatStore.startRun`, after the run is registered (so `stop()`
settling still works if submission throws):
1. Build a per-run id: `com.praxis.chat.preview.run.<8 hex>`.
2. `BGTaskScheduler.shared.register(forTaskWithIdentifier:using:
   launchHandler:)` with that id (dynamic registration is allowed
   for continued tasks; one registration per id, never twice).
3. `BGContinuedProcessingTaskRequest(identifier:id, title: chat
   title, subtitle: "Starting…")`, strategy `.queue` (default;
   `.fail` only surfaces `immediateRunIneligible`, which we handle
   identically — by falling back — so the default is fine).
4. `try BGTaskScheduler.shared.submit(request)`. On ANY error,
   record `continuedTaskAvailable = false` for this run; the
   scene-phase fallback (§2.2) covers it.
5. The launch handler receives the `BGContinuedProcessingTask`
   (possibly while still foregrounded): store it on the run,
   attach the expiration handler (§2.3), seed
   `task.progress.totalUnitCount = 1000`, and bind run events to
   `completedUnitCount` + `updateTitle(_:subtitle:)` (§2.4).

Also at run start: `reporter.began(...)` (§6) to start the Live
Activity. Starting is foreground-only and safe to attempt always;
the reporter no-ops when `areActivitiesEnabled` is false.

`RunHandle` gains a small `background: RunBackgroundState?`
(struct in the new file, not in `RunHandle.swift` — extend via the
handle's existing file only if a stored property is unavoidable;
prefer a `[UUID: RunBackgroundState]` table in `BackgroundRuntime`
keyed by conversation id, so `RunHandle.swift` is untouched).

### 2.2 Backgrounding mid-run: scene phase + fallback

`ChatScreen` (or `PraxisChatApp` — runtime's choice, one
`.onChange(of: scenePhase)`) notifies `BackgroundRuntime`:
- `.background` with ≥1 run in flight:
  - First time ever (persisted flag): request notification
    authorization (`.alert, .sound`; NOT at launch, NOT on a
    settings screen the user may never open — the run they just
    backgrounded is the reason, and the prompt follows it).
  - Runs WITH a continued task: nothing to do — the task holds
    the process alive.
  - Runs WITHOUT one (submit failed, e.g. simulator): open ONE
    `beginBackgroundTask(withName: "Praxis run")` per run as a
    ~30 s grace window, then settle as paused on expiry (§2.3).
- `.active`: close any fallback background tasks whose runs already
  ended; reconcile Live Activities with live runs (§4.5).

No work happens on backgrounding when no run is in flight.

### 2.3 Expiry: settle as paused, never lose anything

The expiration handler (continued task AND fallback task) must be
fast and infallible. It does exactly this, on the main actor:
1. `stop(conversationID:)` — the existing, tested settlement:
   drains the inbox, applies every arrived event through the
   reducer, denies pending approvals, keeps partial blocks and the
   committed transcript.
2. Overwrite the settled turn's `outcome` with the new
   `TurnOutcome.pausedBackground` and `save(conv)` (stop already
   saved; save again after the overwrite). Note text: "Paused in
   background".
3. `reporter.ended(..., phase: .paused, ...)`; post NO completion
   notification (the run didn't complete; the approval
   notification, if any, stays).
4. `task.setTaskCompleted(success: true)` — true because the
   checkpoint is clean and no system retry is wanted; `false`
   leaves a "Task Failed" card in the system progress UI.
   End + invalidate the fallback `beginBackgroundTask` if any.

New `TurnOutcome` case (surgical edit in `Demo/Models.swift`):
`case pausedBackground`, `Codable` (persists like the rest), note
"Paused in background". The Continue button renders under a turn
with this outcome ONLY when it is the conversation's last turn
and no run is in flight.

Kill/switcher-remove case: queued continued requests are cancelled
by the system (header). Next launch, `settledAfterRelaunch()`
already settles orphaned running turns — as `.stopped`, which stays
correct (a foreground crash must not claim "background"). The
reporter reconciles orphaned activities on launch (§4.5).

### 2.4 Progress mapping (continued task ↔ run events)

The system forcibly expires stalled tasks, so progress must move
whenever the run moves — including long token streams with no tool
calls. `totalUnitCount = 1000`, monotonically increasing:
- each completed step (tool finished / text block finished): +40,
  cap 950;
- each coalesced text batch while streaming: +1, cap 950;
- run end: jump to 1000 in the same breath as
  `setTaskCompleted(success: true)`.
- `updateTitle(_:subtitle:)` on phase changes only: title = chat
  title (stable), subtitle = the same one-line step text the Live
  Activity shows (thinking / "Running \<tool\>" / "Needs approval"
  / "Writing answer…").

All updates funnel through the existing `drain(_:)` batches, so
this costs no extra main-actor hops.

### 2.5 Approvals needed while backgrounded

When `.approvalRequested` arrives for a backgrounded run
(`scenePhase != .active`):
1. `reporter.update(..., phase: .needsApproval, ...)` — the lock
   screen / island shows "Needs approval: \<tool\>" with a tap
   deep-link to the chat.
2. Local notification, category `praxis.approval`, title "Praxis
   needs your approval", body "\<tool\> in \<chat\>", actions
   Approve / Deny with `.foreground` — tapping one opens the app
   to the approval card and `NotificationDelegate` (new file, set
   from `forLaunch`) routes the decision to
   `store.resolveApproval(_:decision:)`. One notification per
   pending request id (replace by identifier); withdrawn when the
   request resolves or the run ends.
3. If notification permission is denied: skip (1 stays — the Live
   Activity needs no notification permission and is visible on the
   lock screen).

`LiveActivityIntent` buttons were evaluated and DEFERRED: the API
allows `Button(intent:)` in Live Activities and the intent type
exists (`LiveActivityIntent : SystemIntent`, verified in
`AppIntents.swiftmodule/...swiftinterface`), but the intent runs in
the widget extension process while the waiter lives in the app —
bridging a security-sensitive Approve across processes needs an
App Group + polling while backgrounded. The notification actions
cover lock-screen approve/deny with no IPC and no new attack
surface. Revisit only if user testing demands one-tap approve.

Elicitations while backgrounded: same treatment as approvals is
NOT possible (free-form answers need the app). They wait; the
activity shows "Needs approval" for them too (an elicitation is,
from the lock screen's view, the run waiting on the user), and
tapping opens the chat.

### 2.6 Completion / failure while backgrounded

On `.finished` for a backgrounded run:
1. `reporter.ended(..., phase: .done/.failed, lastLine: ...)`
   with a final state (shown on the lock screen until dismissal).
2. Local notification (permission-gated): title = chat title, body
   = first line of the answer, truncated (~160 chars). Tapping
   deep-links to the chat (§4.6). Failed runs: body =
   "Couldn't finish: \<short reason\>".
3. `continuedTask.setTaskCompleted(success: true)` (+ end the
   fallback task if open); cancel the run's task request id
   (`cancel(taskRequestWithIdentifier:)`) to release the slot.

Foreground finishes behave exactly as today, plus ending the
continued task and the activity.

### 2.7 Continue (resume)

`ChatStore.continueRun(conversationID:)` (new method; the ONLY
ChatStore addition besides the hooks):
- Guard: last turn exists, `outcome == .pausedBackground`, no run
  in flight for the conversation.
- `send(text: "Continue")` — a new turn whose replayed history is
  `earlier.flatMap(\.transcript)`, which INCLUDES the paused
  turn's user message + every committed step. That is the
  "re-send from the last completed step": finished tool calls are
  replayed as history, never re-executed; the model continues from
  the last committed message. Partial (uncommitted) stream text is
  intentionally not replayed — it stays visible on the old turn.
- The old turn is no longer last, so its Continue button
  disappears; its note stays "Paused in background".

Why not same-turn resume: it would need runtime support for
history-extended runs with `userMessage == nil` plus reducer
changes to append onto existing blocks — Packages changes with
blunt failure modes (duplicated commits). The new-turn continue
reuses `send`/`makeRequest` untouched, works on every engine, and
matches the established "Continue generating" UX. Documented here
so nobody "simplifies" it into retry-from-scratch (which WOULD
re-execute finished tools).

## 3. Live Activity / Dynamic Island (bg-live)

### 3.1 Data: `RunActivityAttributes` (shared file, both targets)

One file, `PraxisChat/PraxisChat/Services/Background/
RunActivityAttributes.swift` (bg-live creates it; app target picks
it up via sync, widget target via an explicit file reference —
§5.3). Imports ActivityKit only. Must stay tiny (the 4 KB update
limit covers attributes + state):

```swift
import ActivityKit

struct RunActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var phase: RunPhase        // shared enum, same file or §6 file
        var stepCount: Int
        var startedAt: Date
        var lastLine: String       // one line, step text (§3.4)
        var toolName: String?      // set for runningTool/needsApproval
    }
    var conversationID: UUID       // deep link, not displayed
    var chatTitle: String
    var modelName: String
}
```

`RunPhase`: `thinking, runningTool, needsApproval, done, failed,
paused` — `String, Codable, Hashable, Sendable`. It is defined ONCE
in the §6 reporter protocol file (pre-seeded in this commit; the
widget target gets it via the same explicit file reference as the
attributes file — §4.2) and referenced from both sides. It moves
to the attributes file ONLY if both workers agree by thread
message.

### 3.2 Views (widget target only)

Target `LiveActivityWidget`, `ActivityConfiguration(for:
RunActivityAttributes.self)`. All APIs verified in
`WidgetKit.swiftmodule/...swiftinterface`:
`ActivityConfiguration(for:content:dynamicIsland:)`,
`DynamicIsland(expanded:compactLeading:compactTrailing:minimal:)`,
`widgetURL(_:)`, `keylineTint(_:)`.
- Lock Screen: chat title + model, phase line (lastLine),
  `Text(startedAt, style: .timer)` elapsed, step count. Tapping
  anywhere opens the chat (`widgetURL`).
- Compact leading: monochrome pulse dot / app glyph; compact
  trailing: short phase text ("Lvl 3" style: e.g. "Step 3" or the
  tool's short name). Minimal: glyph only.
- Expanded: top region = title + timer; bottom = lastLine +
  step count. No buttons in v1 (§2.5).
- Style: monochrome, calm, liquid-glass doctrine (README). No
  custom animations (the system ignores animation modifiers in
  Live Activities and animates content changes itself).
- Accessibility labels on every presentation (VoiceOver).
- `isStale` (via `ActivityViewContext`) renders a dimmed
  "Updating…" treatment when the state goes stale.

### 3.3 Updates: local only, throttled

- `Activity.request(attributes:content:pushType:style:)` with
  `pushType: nil` (local only — no server, no push token, zero
  hosting). `update(_:alertConfiguration:)` for content;
  `end(_:dismissalPolicy:)` with a FINAL state always. Verified in
  `ActivityKit.swiftmodule/...swiftinterface`. Do NOT set
  `NSSupportsLiveActivitiesFrequentUpdates` (it raises the *push*
  budget; we send zero push updates).
- Client-side throttle in the reporter: forward phase changes
  immediately; otherwise at most one update per 5 s per activity,
  coalescing lastLine/stepCount. Never exceed ~4 KB per update
  (truncate lastLine to ~140 chars).
- `staleDate`: `now + 60 s`, advanced on every update. A run that
  stops reporting (expired without ending — should be impossible,
  but defence in depth) visibly goes stale instead of lying.
- Dismissal: `.after(endDate + 5 minutes)` for done/failed
  (glanceable on the lock screen, then gone), `.default` for
  paused (stays until the user returns or 4 h), always with final
  content. One activity per run; `relevanceScore` = selected chat
  100, others 50, so the Dynamic Island shows the chat the user
  is looking at.

### 3.4 The one-line text (same as the activity rows)

bg-runtime derives `(phase, lastLine, toolName)` from each
`drain(_:)` batch — the SAME `StepPresentation` titles the
in-app activity rows render:
- run start / between tools → `.thinking`, "Thinking…"
- tool running → `.runningTool`, `StepPresentation` running title
  ("Reading request.txt…"), `toolName` = short tool name
- tool finished → `.thinking`, finished title ("Read request.txt")
  until the next event
- text streaming → `.thinking`, "Writing answer…" (NEVER token
  text: lock-screen privacy, 4 KB cap, update storm)
- approval/elicitation requested → `.needsApproval`, "Needs
  approval: \<tool\>"
- finished → `.done`, "Done · N steps · Xs" / `.failed`,
  "Couldn't finish" / paused → `.paused`, "Paused in background"

### 3.5 Lifecycle / reconciliation

- `began`: `guard ActivityAuthorizationInfo().areActivitiesEnabled`
  (verified API), else no-op. `try Activity.request(...)`, catch
  `ActivityAuthorizationError` (`.denied`, limits, …) and no-op —
  the run never depends on the activity. Observe
  `activityEnablementUpdates` to start reporting mid-run if the
  user enables activities in Settings.
- `reconcile(activeConversationIDs:)`: called on launch and on
  `.active`. For each `Activity<RunActivityAttributes>.activities`
  whose conversation has no live run: `end` with a final
  `.paused`/`.done` state as appropriate. For live runs with no
  activity (enabled mid-run): `began`.
- Crash safety: an activity orphaned by a crash is ended at next
  launch with last-known state — never left running.

### 3.6 Deep link

- Register the URL type in the app Info.plist (pre-seeded §5.1):
  scheme `praxis-app`, links `praxis-app://chat/<conversationID>`.
  All widget presentations set
  `.widgetURL(URL(string: "praxis-app://chat/\(id)"))`.
- Handle in ONE place: `.onOpenURL` at the `ChatScreen` root (or
  App level — bg-live's choice, surgical): parse `/chat/<uuid>`,
  `store.select(id)`. Ignore all other `praxis-app://` URLs —
  markdown integration tiles (`praxis-app://GitHub`) are handled
  in-app by the existing `OpenURLAction` override and must keep
  working.
- Notification taps route through the same URL: the delegate
  opens `praxis-app://chat/<id>`.

## 4. Xcode project changes (bg-live)

### 4.1 Info.plist (app) — PRE-SEEDED in this commit

Neither worker edits Info.plist; the orchestrator commits the
final keys now (union with voice's `audio` + mic description
happens at integration per WAVE2 §4):

```xml
<key>UIBackgroundModes</key>
<array>
    <string>processing</string>
</array>
<key>BGTaskSchedulerPermittedIdentifiers</key>
<array>
    <string>com.praxis.chat.preview.run.*</string>
</array>
<key>NSSupportsLiveActivities</key>
<true/>
<key>CFBundleURLTypes</key>
<array>
    <dict>
        <key>CFBundleURLName</key>
        <string>chat</string>
        <key>CFBundleURLSchemes</key>
        <array>
            <string>praxis-app</string>
        </array>
    </dict>
</array>
```

### 4.2 New target `LiveActivityWidget`

- Product type `com.apple.product-type.app-extension`, extension
  point `com.apple.widgetkit-extension`, bundle id
  `com.praxis.chat.preview.LiveActivity`, deployment target 26.0,
  Swift 6, same team/signing as the app.
- Sources: new synchronized folder `PraxisChat/LiveActivityWidget/`
  (next to the project, NOT inside the app's synced `PraxisChat/`
  folder): `LiveActivityWidgetBundle.swift` (`@main …: WidgetBundle`
  containing the activity `Widget`), `RunActivityWidget.swift`
  (the `ActivityConfiguration` + all presentations), `Info.plist`
  with the `NSExtension` dict
  (`NSExtensionPointIdentifier =
  com.apple.widgetkit-extension`), no principal class (SwiftUI).
- Shared file: `PraxisChat/PraxisChat/Services/Background/
  RunActivityAttributes.swift` joins the widget target via ONE
  explicit `PBXBuildFile` + `PBXFileReference` (classic
  membership — avoids nested-sync-root questions; mixing sync and
  explicit membership in one target is allowed). Nothing else from
  the app target may leak into the extension (no ChatStore, no
  package deps; imports limited to Foundation, SwiftUI, WidgetKit,
  ActivityKit).
- App target gains: `PBXTargetDependency` on the widget,
  `PBXContainerItemProxy`, and an "Embed Foundation Extensions"
  `PBXCopyFilesBuildPhase` (`dstSubfolderSpec = 13`, PlugIns).
- Method: prefer `gem install --user-install xcodeproj` (dev tool
  only, never shipped) to script the target; hand-editing the
  pbxproj is the fallback (new 24-hex ids, collision-checked with
  grep). bg is the ONLY agent allowed pbxproj edits (conflict map).
- Validate: `xcodebuild -list` shows the new target; full
  `xcodebuild build` of scheme `PraxisChat` embeds the `.appex`;
  `xcodebuild test -only-testing:PraxisChatTests` still passes.

## 5. Worker split

- bg-runtime: `Services/Background/BackgroundRuntime.swift`
  (continued-task submit/expire, fallback task, scene-phase entry
  points, progress driver), `Services/Background/
  BackgroundNotifications.swift` (permission gate, approval +
  completion notifications, `NotificationDelegate`), ChatStore
  hooks (`startRun` submit, `drain` report, `stop`-based pause,
  `continueRun`, `TurnOutcome.pausedBackground` + note, Continue
  button wiring), scene-phase observer, unit tests (pause/continue
  semantics, progress monotonicity, notification mapping with a
  fake center) + UI test (scripted long run → home → paused note
  → Continue).
- bg-live: the widget target end to end (§4.2), the shared
  `RunActivityAttributes.swift`, `Services/Background/
  LiveRunActivityReporter.swift` (the `RunActivityReporter`
  implementation: throttle, staleDate, dismissal, reconcile),
  the deep link (§3.6), unit tests (throttle, mapping, reconcile
  with a fake Activity store seam) + UI tests (activity starts on
  send; needs-approval state), screenshots of every presentation
  in light AND dark.
- Interface between them = §6, pre-seeded on `wave2/bg` before
  either worker starts, so both compile against the identical
  contract. Changes to the contract need a thread message + both
  workers merging `wave2/bg`.

## 6. Interface contract (pre-seeded; DO NOT reshape unilaterally)

File `PraxisChat/PraxisChat/Services/Background/
RunActivityReporter.swift` (committed with this plan):

```swift
import Foundation

/// User-visible phase of one run. Defined here so the app-side
/// reporter protocol and the widget-side attributes share it.
enum RunPhase: String, Sendable, Codable, Hashable {
    case thinking
    case runningTool
    case needsApproval
    case done
    case failed
    case paused
}

/// Fire-and-forget reporting from bg-runtime to bg-live's
/// ActivityKit updater. All calls no-op when activities are
/// disabled or an activity can't start — a run NEVER depends on
/// its activity.
@MainActor
protocol RunActivityReporter: Sendable {
    func began(conversationID: UUID, title: String,
               modelName: String) async
    func update(conversationID: UUID, phase: RunPhase,
                stepCount: Int, startedAt: Date, lastLine: String,
                toolName: String?) async
    func ended(conversationID: UUID, phase: RunPhase,
               lastLine: String) async
    func reconcile(activeConversationIDs: Set<UUID>) async
}

/// Compiles the app before the ActivityKit implementation lands;
/// bg-runtime develops against this, bg-live replaces its use.
@MainActor
struct NoOpRunActivityReporter: RunActivityReporter {
    func began(conversationID: UUID, title: String,
               modelName: String) async {}
    func update(conversationID: UUID, phase: RunPhase,
                stepCount: Int, startedAt: Date, lastLine: String,
                toolName: String?) async {}
    func ended(conversationID: UUID, phase: RunPhase,
               lastLine: String) async {}
    func reconcile(activeConversationIDs: Set<UUID>) async {}
}
```

bg-runtime calls the protocol (wired to `NoOpRunActivityReporter`
until integration, then to bg-live's `LiveRunActivityReporter` —
the swap is a one-line `BackgroundRuntime` init change, done by bg
at integration). bg-live implements `LiveRunActivityReporter` in
a NEW file and never touches the protocol file. `RunPhase` moves
to the shared attributes file ONLY if both workers agree by
thread message; duplication risk is worse than the current shape
(one definition, app target + explicit widget membership — same
treatment as the attributes file).

## 7. Testing

### 7.1 Simulator (must all pass before integration)

- `-PraxisEngine scripted` long run (bg-runtime adds a launch-arg
  seeded multi-minute script: many `.wait` + tool events +
  approvals — e.g. `-PraxisLongRun YES`): send, press Home
  (`XCUIDevice.shared.press(.home)`), assert via springboard +
  lock-screen screenshots that the activity shows thinking →
  running-tool → needs-approval phases; return, assert run
  continued or paused-then-continued with zero lost content.
- Live Activity presentations on an iPhone 17 Pro sim (Dynamic
  Island + lock screen): screenshot compact, minimal, expanded
  and lock screen in light AND dark; actually look at them.
- Expiry path WITHOUT the system: call the expiration closure /
  a `DEBUG` seam directly in unit tests (pause settle, outcome,
  save, no lost partial text, Continue replays history).
- Notification mapping unit tests with a fake center; approval
  action → `resolveApproval` routing test.
- `BGTaskScheduler.submit` FAILS in the simulator (`.unavailable`:
  "running on Simulator which doesn't support background
  processing", per the header) — so the simulator exercises the
  `beginBackgroundTask` fallback path, NOT the continued task.
  That is expected and must be asserted, not worked around.

### 7.2 Needs a real device (state in every report)

- `BGContinuedProcessingTask` end to end: submit → background →
  minutes of runtime → system progress UI → expiry. Including:
  real time limits, stall-expiry sensitivity, `.queue` vs `.fail`
  behaviour under load, and `supportedResources` on the test
  device.
- True backgrounded SSE streaming for minutes (thermal/ radio
  behaviour), background GPU absence (we don't need it, but
  confirm no `notPermitted` on resource grounds).
- Live Activity on a physical Dynamic Island + Always-On display
  (reduced-luminance rendering), alert configurations as banners
  on non-island devices, activity limits with other apps' live
  activities present.
- Notification permission prompt timing/wording in situ, approval
  actions from the lock screen, deep link from a killed app.
- The `processing` background mode + wildcard id passing App
  Review alongside voice's `audio` mode.

## 8. Coordination

- voice: `audio` is theirs; everything else in `UIBackgroundModes`/
  BG ids / Live Activity keys is bg's. Integration = union.
  (Exchanged 28 Oct; voice plan at `hub wave2/voice cac8718`.)
- blur/tray (ChatScreen photo state, scroll edges), picker
  (Composer/PlusTray — untouched by bg), mcptools/effort
  (ChatStore request tools — bg's ChatStore hooks are additive
  only). bg-runtime messages each before touching the shared file.
- pbxproj: bg-live is the sole editor wave-wide; anyone else's
  pbxproj conflict resolves by keeping bg-live's target hunks.

## 9. Sources

Apple docs (behaviour claims):
- https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados
- https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask
- https://developer.apple.com/videos/play/wwdc2025/227/ (WWDC25,
  "Finish tasks in the background")
- https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities
- https://developer.apple.com/documentation/activitykit (Activity,
  ActivityContent, ActivityAuthorizationInfo)
- https://developer.apple.com/documentation/bundleresources/information-property-list/bgtaskschedulerpermittedidentifiers
- https://developer.apple.com/documentation/bundleresources/information-property-list/uibackgroundmodes
- https://developer.apple.com/documentation/bundleresources/information-property-list/nssupportsliveactivities
- https://developer.apple.com/app-store/review/guidelines/ (§2.5.4)

SDK verification (API names), all under the iOS 26.5 SDK:
- `BackgroundTasks.framework/Headers/BGTask.h` (BGTask,
  BGContinuedProcessingTask + NSProgressReporting, updateTitle)
- `BackgroundTasks.framework/Headers/BGTaskRequest.h` (request,
  wildcard ids, SubmissionStrategy, Resources, GPU entitlement)
- `BackgroundTasks.framework/Headers/BGTaskScheduler.h`
  (register/submit/cancel, Error codes incl. simulator note)
- `BackgroundTasks.framework/Headers/BackgroundTasks.apinotes`
  (Swift names: `submit(_:)`, `register(forTaskWithIdentifier:
  using:launchHandler:)`, `setTaskCompleted(success:)`,
  `BGTaskScheduler.Error`)
- `ActivityKit.framework/Modules/ActivityKit.swiftmodule/
  arm64e-apple-ios.swiftinterface` (request/update/end,
  ActivityContent, ActivityUIDismissalPolicy, ActivityStyle,
  ActivityAuthorizationInfo/Error)
- `WidgetKit.framework/Modules/WidgetKit.swiftmodule/
  arm64e-apple-ios.swiftinterface` (ActivityConfiguration,
  DynamicIsland, widgetURL, keylineTint)
- `AppIntents.framework/Modules/AppIntents.swiftmodule/
  arm64e-apple-ios.swiftinterface` (`LiveActivityIntent`)
- `UIKit.framework/Headers/UIApplication.h`
  (begin/endBackgroundTask, backgroundTimeRemaining)
- `Foundation.framework/Headers/NSURLSession.h` (background
  session = upload/download only) and `NSProgress.h`
  (NSProgressReporting)
- `UserNotifications.framework/Headers/UNUserNotificationCenter.h`,
  `UNNotificationAction.h`, `UNNotificationCategory.h`
  (authorization, categories, Approve/Deny actions)

NOT verifiable by grep: `Widget`/`WidgetBundle` (SwiftUI ships as
binary `.swiftmodule`, no public swiftinterface) — taken from the
ActivityKit/WidgetKit docs above, which show the exact
`ActivityConfiguration` usage; the widget target build is the
verifier. Third-party note: two community summaries of WWDC25-227
misstated details (strategy case `.enqueue` vs SDK `.queue`;
request init without title/subtitle) — the SDK headers win, and
bg-runtime re-verifies case names at compile time.
