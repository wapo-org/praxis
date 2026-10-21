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
Tests: `xcodebuild ... test` (4 focused tests in `PraxisChatTests`).

## Architecture

| Area | Files | Notes |
|---|---|---|
| DesignSystem | `DesignSystem/` | Tokens, type, motion, haptics, glass, scrims, Lucide |
| Components | `Components/` | Composer, PlusTray, bubbles, markdown+chips, activity, command card |
| Demo | `Demo/` | Engine, scenarios, mock data, transcript models |
| Screens | `Screens/` | ChatScreen, HistorySheet, file/link previews |
| App | `App/` | `PraxisChatApp`, `ChatStore` (`@Observable @MainActor`) |

State lives in `ChatStore`. The engine emits `AsyncStream<AgentEvent>`;
the store folds events into `Turn.blocks` (activity / markdown). Settings
(mode, model, effort, tools) are read at send time and scale the run:
effort ≈3s (Low) → ≈15s (Max) of activity, the model scales streaming
speed, and turning off Web search removes web steps.

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
