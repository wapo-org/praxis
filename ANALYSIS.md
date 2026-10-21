# Reference iOS app — exhaustive reverse-engineering analysis

Target: `com.anthropic.claude_1.261007.20_und3fined.ipa` (76 MB)
SHA-256: `4c532effc7b35e8f8e31af39c7c8b8f01a327122664f94694b54fd5093fa3b7f`
Method: REA artifact graph (`inspect-artifact`, `inspect-asset-catalog`) plus
macOS bundle tools (`assetutil`, `plutil`, `otool`, `codesign`, `strings`).
No code was executed from the reference binary. Credential material found in
strings (telemetry ingest keys) is deliberately not reproduced here.

REA Evidence: `ev_fd5c81723fa908f1da838fc66c94f0744bf2a8de8310467fcbe3d22ccc5b631c`
(artifact graph: 6,741 nodes / 7,620 occurrences) and the asset-catalog
inspection over the same bundle. Extraction logs retained under
`/tmp/wapo-analysis/` (`extract.log`, `rea-inspect.json`, `rea-assets2.json`).

Legend: **observed** = read from the shipped artifact. **inferred** = design
choice in the reconstruction where the artifact stores compiled constants
that do not survive as strings.

> Note: the workspace was reset between sessions and the original `.ipa`
> file is no longer present in this folder. The unpacked bundle and all
> extraction outputs survive under `/tmp/wapo-analysis/ipa/`; re-adding the
> IPA restores the full pipeline. Every claim below traces to those outputs.

---

## 1. Identity & platform (observed)

| Item | Value |
|---|---|
| Bundle ID | `com.anthropic.claude` |
| Version | `1.261007.20` (build `37720259229`) |
| Executable | `Claude` — Mach-O 64-bit arm64, 98 MB, 138 load commands |
| Min OS / SDK | iOS 18.0 / iPhoneOS 27.0 (Xcode 27.0), `UIDeviceFamily` 1,2 |
| Architecture | Pure SwiftUI — zero storyboards/nibs found in the bundle |
| Swift modules | 1,625 embedded `*.swift` file paths; largest: ClaudeCoreUI (196), ClaudeCodeSessionFeature (143), ClaudeCode (92) |
| Resource bundles | 103 `*.bundle` (feature-modular SwiftPM layout) + 1 framework (Sentry) |
| Localizations | 36 `*.lproj`; 2,953 `.strings` + 972 `.stringsdict` files; 4,499 English keys in feature bundles alone |
| App group | `group.com.anthropic.claude`; keychain `Q6L2SF6YDW.com.anthropic.claude.shared` |

## 2. Atomic design tokens

### 2.1 Color (observed)
Main `Assets.car` contains exactly one named color, `AccentColor`:

| Appearance | sRGB components | Hex |
|---|---|---|
| Light | 0.40, 0.39, 0.34, 1 | `#666357` |
| Dark (`UIAppearanceDark`) | 0.72, 0.71, 0.66, 1 | `#B8B5A8` |

All other semantic colors live in compiled Swift (ClaudeCoreUI holds 67
catalog records: `ClaudeLogo`, `Splash/Anthropic`, `Icons/Calendar`,
`Icons/GoogleDrive`, `Icons/Health`, `Icons/Location`, `Icons/Reminders`…),
not in asset catalogs — exact hex values for surfaces/text are **unknown**
from static strings and are reconstructed as warm neutrals anchored on the
observed accent hue (see `Tokens.swift`, marked inferred).

App icon: 1024×1024 renditions in light, dark (`UIAppearanceDark`), and
tinted (monochrome) appearances.

### 2.2 Typography (observed families)
`ClaudeFonts_ClaudeFonts.bundle` (name-table verified):

| File | Family | Notes |
|---|---|---|
| `AnthropicSansMobileVariable-TextRegular.ttf` | Anthropic Sans Mobile Text | variable, 2000 upm, 684 glyphs (+ italic cut) |
| `AnthropicSerifMobileVariable-TextRegular.ttf` | Anthropic Serif Mobile Text | variable, 2000 upm, 718 glyphs (+ italic cut) |
| `JetBrainsMono-Regular.ttf` | JetBrains Mono | code, 1000 upm, 1743 glyphs |

Remote static cuts are referenced from `assets.claude.ai/Fonts/`
(Regular/Medium/Semibold/Bold, ±italic). The proprietary files are **not**
copied into the reconstruction; `Tokens` names the families and falls back
to system designs of the same class. Type sizes/weights per role are
compiled constants (**unknown**); the reconstruction exposes
title-serif 28 / body 16 / caption 13 / mono 13 as inferred tokens.

### 2.3 Icons (observed names)
`ClaudeDesignSystem_ClaudeIcons.bundle/Assets.car`: 5,693 records
(4,185 Image, 1,395 Vector Glyph, 112 Packed) under 468 unique
`anthropicon.*` names — e.g. `chat`, `chatAdd`, `chats`, `arrowUp`,
`caretDown`, `attachment`, `camera`, `code`, `artifacts`, `copy`, `check`,
with `.fill` / `.slash` / `small.` variants. Glyph artwork is proprietary;
the reconstruction maps each observed name to the nearest SF Symbol
(`DesignSystem/Icons.swift`) preserving name, size, and state semantics.

### 2.4 Spacing, radii, layout (inferred)
No numeric spacing constants survive in strings. The reconstruction uses a
4 pt grid (4/8/12/16/20/24/32) and radii 8/12/20/pill — consistent with
SwiftUI conventions and the composer's pill-shaped input observed in the
module layout (`ClaudeComposer`, `ChatInput/ChatInputMenuModel.swift`).
Treat these as reconstruction choices, not extracted constants.

### 2.5 Motion & gesture (observed symbols, inferred numbers)
Observed: `Animation.spring()`, `Animation.interactiveSpring()`,
`initWithDuration:dampingRatio:initialVelocity:`,
`ClaudeCoreUI/UIKitViewSpringAnimation.swift`,
`ClaudeCoreUI/AnimatingHapticButton.swift`, `LongPressButtonStyle`,
`TranscriptSwipeAction`, `anthropicon.haptics`. Exact response/damping
values are compiled constants (**unknown**). Reconstruction springs:
snappy (0.32, 0.86), gentle (0.45, 0.92), interactive (0.28, 0.82);
haptic press style, list swipe actions, and long-press context menus
reproduce the observed interaction vocabulary.

## 3. API surface (observed strings)

| Base | Evidence |
|---|---|
| `https://claude.ai/api` (+ staging `claude-ai.staging.ant.dev/api`) | URL strings |
| `https://api.anthropic.com` (`/api/directory/servers`, `/v1/claude_code/routines/`) | URL strings |
| `http://localhost:8000`, `http://localhost:4010/mcp_apps?dev=true` | local/dev strings |
| Override key | `Claude-API-Base-Url` (user-defaults key string) |

Paths seen: `/api/organizations/`, `/api/github/organizations/`,
`/api/directory/servers`. Streaming is SSE: `Accept: application/json,
text/event-stream` with events `message_start`, `content_block_start`,
`content_block_delta`, `message_stop`. No `wss://` endpoints were found
(voice uses native audio sessions; `UIBackgroundModes: audio`).
No chat-completion POST path survives as a plain string — the
reconstruction isolates it as one adapter constant (`POST /api/chat`).

Other defaults keys observed: `Claude-Color-Scheme-Preference`,
`Claude-Code-Mono-Font`, `Claude-Code-Prose-Font`,
`Claude-Code-Transcript-Text-Size`, `Claude-Code-Line-Wrap-Enabled`,
`Claude-Launch-Route`, `Claude-Error-Code`.

## 4. Capabilities, extensions, edge-case states

Entitlements (observed): push (production), Sign in with Apple, associated
domains `claude.ai` (+ staging/preview/email), CarPlay voice conversation,
HealthKit, App Attest, time-sensitive notifications, declared age range.
Permission prompts cover camera, mic, photos, location, calendars,
reminders, health, Face ID, AlarmKit. Background: audio,
remote-notification, BGTask `com.anthropic.claude.continued-send`, Live
Activities (frequent updates). URL schemes: `claude`, Google OAuth
redirect. Exported type: `com.claude.artifact.content`.

Extensions: Widgets (`com.anthropic.claude.ClaudeWidgetExtension`),
Share, Notification Service, CCR notification content,
Locked-Camera-Capture. App Intents phrases include “Ask Claude”,
“Start Dictation”, “Start Voice Conversation”, “New Code Session”.

 View-state vocabulary: 412 of 4,499 English keys describe non-happy-path
states — `*_empty`, `*_load_failed`, `*_unavailable`, `*_offline`,
`approaching_limit`, `claude_message_limit_reached`,
`chat_attachment_limit_reached`, `attachment_upload_failed`, … The
reconstruction wires the corresponding states: empty (suggestions),
streaming (stop control), offline banner, error banner, limit banner.

## 5. Reconstruction — `WapoApp/`

Original SwiftUI source (iOS 18, iPhone+iPad split view) implementing the
observed tokens; no proprietary fonts, glyphs, strings, or code copied.

| File | Contents |
|---|---|
| `WapoApp/WapoApp.swift` | `@main` entry |
| `WapoApp/DesignSystem/Tokens.swift` | Observed accent hex, inferred surfaces/spacing/radii/type/springs |
| `WapoApp/DesignSystem/Icons.swift` | `anthropicon.*` → SF Symbol map, haptic button style |
| `WapoApp/API/Models.swift` | `StreamEvent`, messages, tolerant SSE decoder |
| `WapoApp/API/APIClient.swift` | Base-URL resolution (`Claude-API-Base-Url` → `http://localhost:8000`), `/api/organizations/`, SSE chat stream, 429→limit mapping |
| `WapoApp/Features/RootView.swift` | Split view, `AppModel`, network monitor, send/stop streaming |
| `WapoApp/Features/SidebarView.swift` | Search, recents, swipe actions, long-press menus |
| `WapoApp/Features/ChatView.swift` | Empty/streaming/error/offline states, transcript |
| `WapoApp/Features/ComposerView.swift` | Attach menu, dictation, send/stop |
| `WapoApp/Features/SettingsView.swift` | Local-API base URL/token (identifier-tagged), color-scheme preference |
| `WapoApp/WapoAppUITests/WapoAppUITests.swift` | Single-pass end-to-end UI test with frame attachments |

Local API contract expected by the client: `POST {base}/api/chat` with
`{"messages":[{"role","content"}], "stream":true}` returning
`text/event-stream` frames using the observed event names above;
`GET {base}/api/organizations/` returning `[{"uuid","name"}]`.

## 6. What could not be recovered (unknowns)

1. Exact spacing/type/spring constants — compiled, not string-visible;
   would need a decompiler provider (Hopper/Ghidra), unavailable here.
2. Full semantic color palette (only `AccentColor` is catalog-backed).
3. Runtime-only behaviour of the reference (actual gesture thresholds,
   keyboard curves) — static analysis observes no execution.
4. Chat POST path and request schema beyond the SSE event grammar.

## 7. Build

```bash
xcodebuild -project WapoApp/WapoApp.xcodeproj -scheme WapoApp \
  -destination 'generic/platform=iOS Simulator' build CODE_SIGNING_ALLOWED=NO
# => ** BUILD SUCCEEDED **
```

## 8. Runtime verification (executed, this session)

One uninterrupted XCUITest pass on a booted iPad Pro 11-inch (M5)
simulator against a local SSE double on `http://localhost:8000`
(paced `message_start` → 3×`content_block_delta` @0.9 s → `message_stop`;
`limit` prompts get HTTP 429):

| Step | Interaction → expected outcome | Result |
|---|---|---|
| Empty | Launch → “How can I help?” + suggestion chips | Pass (frame 01) |
| Sidebar | Tap “New chat” → fresh empty conversation, recents row appears | Pass (frame 02) |
| Composer | Tap field, type “hi there”, Send enables | Pass |
| Streaming | Send → “Stop generating” appears; text assembles over multiple frames; stop dismisses at `message_stop` | Pass (frames 03→04→05, +0 s / +1.5 s / +4.9 s) |
| Limit | Send “limit check” → 429 → “You've reached the usage limit…” banner | Pass (frame 06) |
| Settings | Dismiss keyboard → Settings → set base URL `http://localhost:9` → Done | Pass (frame 07) |
| Error | Send against dead port → “Couldn't reach the local API at http://localhost:9…” banner | Pass (frame 08) |
| Offline | `NWPathMonitor` banner | **Unverified** — simulator shares the host network; dropping it would disrupt the host. Code path reviewed, not driven. |

`Test Case '-[WapoAppUITests.WapoAppUITests testFullPass]' passed (35.786s)`
— **TEST SUCCEEDED**. Frames exported from
`/tmp/wapo-analysis/TestResults.xcresult` to
`/tmp/wapo-analysis/shots-final/` and visually inspected (empty,
streaming-mid “Hello from local” + spinner, streaming-done, limit banner,
Settings sheet, error banner). Two environment traps found and fixed
along the way: one-time Siri/Dictation consent alerts on fresh
simulators, and the software keyboard covering the sidebar Settings
button (tap landed on the dictation key).
SSE decoder additionally unit-verified standalone (`DECODER OK`,
`STREAM RECEIVED: Hello from local API`).

Run it yourself: start any server honouring the §5 contract on
`http://localhost:8000`, open `WapoApp/WapoApp.xcodeproj`, select an
iPhone/iPad simulator, Run. The fake double used here is
`/tmp/wapo-analysis/fakeapi2.py`.
