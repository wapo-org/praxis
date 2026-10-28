# Praxis Chat

A native SwiftUI preview of an agentic chat experience. No backend: an
in-app demo engine (`DemoAgentEngine`) drives streaming, tool activity,
commands and answers. Every control on screen works — mode, model, effort,
attachments, tools and connectors all change how the next run behaves.

Doctrine: *calm, monochrome, liquid glass — materials that bend light
instead of casting shadows.*

## Run it

```sh
xcodebuild -project PraxisChat.xcodeproj -scheme PraxisChat \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
xcrun simctl install booted <path-to>/PraxisChat.app
xcrun simctl launch booted com.praxis.chat.preview
```

Or open `PraxisChat.xcodeproj` in Xcode 26 and run the `PraxisChat` scheme.
Tests: `xcodebuild ... test` (`PraxisChatTests` unit tests,
`PraxisChatUITests` UI tests).
UI-test seeds: `-PraxisLongThread YES` opens on a long thread (tall answers,
then short failed turns); `-PraxisDemoModels 500` adds 500 demo models to
the tray's model page; `-PraxisSimulateKeyboardCommit YES` plays a late
keystroke committing after send (guards the composer-clear fix);
`-PraxisMockConnector YES` installs a hermetic connector with scripted
tools (plus `-PraxisMockConnectorNewTool YES` for one unseen tool).
Screenshot probes are env-gated (`TEST_RUNNER_<NAME>=1` forwards `<NAME>`
to the runner): `PRAXIS_SHOTS` (activity), `PRAXIS_SENDPROBE` (send
flight), `PRAXIS_BLURSHOTS` / `PRAXIS_BUTTONSHOTS` / `PRAXIS_TOOLSHOTS`
(scrims, buttons, tool-support hint).

## Architecture

| Area | Files | Notes |
|---|---|---|
| DesignSystem | `DesignSystem/` | Tokens, type, motion, haptics, glass, scrims, Lucide |
| Components | `Components/` | Composer, PlusTray, bubbles, markdown+chips, activity, command card |
| Demo | `Demo/` | Engine, scenarios, mock data, transcript models |
| Screens | `Screens/` | ChatScreen, HistorySheet, Settings (providers), elicitation sheet, previews |
| App | `App/` | `PraxisChatApp`, `ChatStore` (`@Observable @MainActor`) |
| Agent | `Agent/` | `ChatEngine` seam, `LiveChatEngine`, scripted engine, `TurnReducer`, approval/elicitation centers |
| Services | `Services/` | `AgentServices` (one `AgentRuntime`), `ProviderSettings`, `ConnectorLibrary`, `SkillLibrary`, OAuth presenter |

State lives in `ChatStore`. Engines (`Agent/ChatEngine.swift`) emit AgentCore's `AgentEvent`
vocabulary; the store coalesces them, folds each batch into `Turn.blocks`
(activity / markdown) through the pure `TurnReducer`, streams text into
the block's `LiveText`, and runs one conversation independently of the
others. Conversations persist as JSON in Application Support
(`Persistence/`; `-PraxisResetData YES` starts from the seed). Settings
(mode, model, effort, tools) are read at send time and scale the run:
effort ≈3s (Low) → ≈15s (Max) of activity, the model scales streaming
speed, and turning off Web search removes web steps.

### Live mode

The real agent loop is `Packages/PraxisAgent` (`AgentRuntime`), driven by
`LiveChatEngine`. The app runs it once a provider profile exists
(History → ⋯ → Settings, or the tray's model page → Model providers);
before that it runs the demo. `-PraxisEngine demo|scripted|live` pins the
engine (UI tests use the demo: `-PraxisResetData YES` wipes profiles).

- **Providers:** profiles are JSON in Application Support
  (`Providers.json`); API keys are Keychain items (this device only).
  Test connection runs `ProviderProbe`; model lists are cached per profile.
- **Per conversation:** the first live send freezes a `ConversationSetup`
  (system prompt + tool list) into the conversation file (record v2) and
  every later run reuses it. Mode/effort changes ride on the next user
  message as notes. Demo turns are never sent to a real model.
- **Connectors:** installed remote MCP servers (`Connectors.json`, secrets
  in the Keychain), managed in Settings → Connectors (add by URL, pasted
  config or the MCP registry; tool review before install; trust, sign-in,
  headers). Before a chat starts the tray picks which are frozen in;
  afterwards turning one off only refuses its tools in that chat
  (`disabledServerIDs`, saved with the conversation).
  **Skills:** Settings → Skills, imported into Application Support/Skills.
- **AI-data consent:** the first live send to a provider host shows what
  is shared and waits; nothing is sent until the user allows it
  (`Consent.json`, withdrawable in Settings). UI tests can go live
  without a network with `-PraxisTestProviderURL https://x.invalid/v1`.
- **Attachments:** images and PDFs/text go in as message parts; every
  attachment is readable from JS through `fs`. Conversation files keep a
  reference, not the bytes.

### Where the tokens live

- **Colour/type/rhythm:** `DesignSystem/Tokens.swift` (`Praxis.*`, exact
  spec hex, light/dark), `Typography.swift` (`Type.*` — Inter, IBM Plex
  Mono, Source Serif 4 via `Font.custom(..., relativeTo:)`).
- **Motion:** `DesignSystem/Motion.swift` — `tap`, `snap`, `morph`,
  `reflow`, `reveal` springs. No linear/ease curves for UI motion.
- **Glass:** `DesignSystem/Glass.swift` — native `glassEffect` by default;
  the hand-built Praxis frost (5–6% white, 160°/340° sheens, rim/hairline)
  exists only as the Reduce Transparency fallback.
- **Scrims:** `DesignSystem/ProgressiveBlurScrim.swift` — masked
  `UIVisualEffectView` bands + canvas tint, layered under the native
  `scrollEdgeEffectStyle(.soft)`.

### Inline chips (the interesting part)

Markdown is parsed with apple/swift-markdown (`Components/PraxisMarkdown.swift`)
into stable blocks. Chips are real inline runs that wrap mid-paragraph:

- `` `code` `` → CodePill · `[file](praxis-file://…)` → FileRef ·
  `[title](https://…)` → LinkRef · `[app](praxis-app://…)` → integration tile

`Text.Layout` runs only expose attributes attached with
`Text.customAttribute`, so `chipText(_:)` rebuilds each paragraph as
concatenated `Text` segments carrying `PillMarker` / `TileMarker` /
`FadeMarker`. `ChipTextRenderer` draws pill/tile backgrounds from run
bounds and the per-word streaming reveal (fade + 2pt rise + blur) from
fade markers. Taps route through `OpenURLAction` with custom schemes:
files open a mock sheet, links open a glass preview then
`SFSafariViewController`, pills copy with a glass toast.

### Markdown tables

Tables render as a bordered grid (header fill, hairlines, 12pt rounded
corners, alignment preserved; code pills and strikethrough work inside
cells). A table wider than the screen scrolls sideways with an edge fade
instead of squeezing columns (`Components/AgentMessage.swift`).

### Agent activity (three levels)

Runs start folded: one line while streaming (`› Currently working…
· <source> · <step>`, cross-fading between steps) and `› Worked for Ns`
when done. Tapping expands a compact list — one trimmed line per tool
call (~28pt rows) — and each row opens its call details (arguments,
result). Per-step traces are capped at the newest 200 (`TurnReducer`;
older traces are counted, not kept).

### Send animation

The just-sent bubble rises from the composer field with a short spring
(~0.38s, 0.94→1 from the bottom-trailing corner). The transcript pins
to the bottom instantly with no animated scroll, and no other row
moves, slides or fades (`DesignSystem/Motion.swift`,
`Components/UserBubble.swift`).

## Add a scenario

1. Add a `Scenario` in `Demo/Scenarios.swift`: steps (`StepScript` with
   kind, present/past summaries, optional traces and a `CommandScript`),
   an `answer` markdown string, optionally `secondSteps` +
   `answerAfterSecond` for an interleaved activity block.
2. Route it in `Scenarios.pick(prompt:hasAttachments:webSearch:)` by
   keyword, or add it to the round-robin fallback.
3. Use the chip link syntax above in the answer so FileRefs, CodePills,
   LinkRefs and integration tiles render inline.

## Bundled assets

- Fonts (OFL): Inter, IBM Plex Mono, Source Serif 4 static cuts in
  `PraxisChat/Resources/Fonts`, registered in `Info.plist`.
- Lucide (MIT/ISC): SVGs in `PraxisChat/Resources/Lucide`, parsed at
  runtime by `DesignSystem/LucideIcon.swift` into stroked vector paths.
- Only dependency: `apple/swift-markdown` (SwiftPM).

## Known preview limits

- Recording is simulated (waveform + timer); stopping types a mock
  transcription. No audio is captured.
- Screenshots strip uses limited Photos access when granted and falls
  back to bundled sample screenshots when denied.
- Camera is disabled on the Simulator and falls back to the library on
  device without a camera.
