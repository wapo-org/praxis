# PraxisChat Web & Desktop UI Specification (`UI_SPEC.md`)

> **Owner**: Lead B (`cloud/apps/web`, `cloud/packages/glass`, `cloud/docs/web`)
> **Milestone**: M0 (Spec-First Contract)
> **Source of Truth**: `PraxisChat/PraxisChat/DesignSystem/*.swift`, `PraxisChat/PraxisChat/Views/**/*.swift`, and iOS Simulator reference captures in `cloud/docs/web/reference/ios/`.

---

## 1. Design Philosophy & Visual Identity

PraxisChat's visual identity is **warm paper & editorial ink** combined with **physical liquid glass** (`@praxis/glass`) and **multi-layer progressive edge blur** (`ProgressiveBlurScrim`).

1. **Warm Paper & Editorial Ink**: Neither pure `#FFFFFF`/`#000000` nor cool Tailwind slate. Light mode rests on warm ivory paper (`#FBFBF9`) with deep charcoal-ink (`#15140F`); dark mode rests on warm obsidian (`#0B0B0A`) with warm parchment ink (`#F1EFE9`).
2. **Physical Liquid Glass**: Floating controls (nav bar pills, composer pill, plus tray, dropdown menus, jump-to-latest pill, inline chips) float above the scrolling transcript using refractive liquid glass (`GlassSurface`) over progressive edge blur scrims (`ProgressiveBlurScrim`).
3. **Spring-Only Motion**: No linear transitions or ease-in-out curves (except under `prefers-reduced-motion: reduce`). Every press, release, sheet presentation, dropdown pop, and message send uses the exact damped harmonic spring tokens from `Motion.swift`.
4. **Identical Cross-Platform DNA**: Mobile web (`402×874`) matches the iOS layout 1:1. Desktop web (`1440×900`) preserves the exact `680px` reading column (`Rhythm.maxReadingWidth`), typography, chips, composer, and glass tokens while adapting navigation and sheets gracefully for pointer + keyboard ergonomics.

---

## 2. Exact Design Tokens (`Tokens.swift`)

### 2.1 Color Palette (`Paper`)

All colors are exposed as CSS custom properties under `:root` (light) and `[data-theme="dark"]` (or `@media (prefers-color-scheme: dark)` when theme is `system`), plus typed TypeScript constants in `@praxis/glass` and `@praxis/web`.

| Token (`Paper.*`) | CSS Variable | Light Hex | Dark Hex | Usage & Contrast Rules |
| :--- | :--- | :--- | :--- | :--- |
| `Paper.canvas` | `--paper-canvas` | `#FBFBF9` | `#0B0B0A` | Primary app background / transcript canvas |
| `Paper.card` | `--paper-card` | `#FFFFFF` | `#151513` | Grouped settings cards, table surfaces, modal sheets |
| `Paper.ink` | `--paper-ink` | `#15140F` | `#F1EFE9` | Primary body prose, headings, active icons |
| `Paper.mutedInk` | `--paper-muted-ink` | `#8A877E` | `#8F8C84` | Decorative captions, placeholders, inactive metadata |
| `Paper.pressedMuted` | `--paper-pressed-muted` | `#B3AFA3` | `#6E6B62` | Pressed state of secondary/muted controls |
| `Paper.secondaryInk` | `--paper-secondary-ink` | `#6E6B62` | `#A8A49A` | Interactive secondary labels (≥ 4.5:1 AA on `canvas` & `fill1`; lightened from `mutedInk` in dark mode) |
| `Paper.hairline` | `--paper-hairline` | `#E9E6DF` | `#2A2926` | 1px borders, table cell dividers, code card strokes |
| `Paper.fill1` | `--paper-fill-1` | `#F4F2EC` | `#151513` | User message bubbles, code blocks, subtle pill fills |
| `Paper.fill2` | `--paper-fill-2` | `#E9E6DF` | `#2A2926` | Active chip fills, pressed row states, meter dots |
| `Paper.tile` | `--paper-tile` | `#2A2926` | `#DDD9CF` | High-contrast inverted badge / send button / integration tile |
| `Paper.tileGlyph` | `--paper-tile-glyph` | `#F4F2EC` | `#151513` | Foreground icon/text inside `Paper.tile` |
| `Paper.success` | `--paper-success` | `#17653F` | `#4CC38A` | Connected status dot, approved tool badge, checkmarks |
| `Paper.destructive` | `--paper-destructive` | `#B3382E` | `#FF7A6E` | Delete actions, error banners, stop/deny buttons, recording pulse |

### 2.2 Spatial Rhythm & Geometry (`Rhythm`)

| Token (`Rhythm.*`) | Value | CSS Variable | Usage |
| :--- | :--- | :--- | :--- |
| `Rhythm.margin` | `20px` | `--rhythm-margin` | Horizontal screen margin for transcript and floating chrome |
| `Rhythm.turnGap` | `32px` | `--rhythm-turn-gap` | Vertical spacing between conversation turns |
| `Rhythm.bubbleToAnswer` | `16px` | `--rhythm-bubble-to-answer` | Spacing from user bubble to agent activity/response |
| `Rhythm.activityToAnswer` | `20px` | `--rhythm-activity-to-answer` | Spacing from `AgentActivityView` to agent markdown prose |
| `Rhythm.composerRadius` | `28px` | `--rhythm-composer-radius` | Corner radius of the floating composer / plus tray |
| `Rhythm.maxReadingWidth` | `680px` | `--rhythm-max-reading-width` | Maximum width of the centered transcript & composer column |
| `UserBubble.maxWidth` | `78%` | `max-width: 78%` | Maximum width of user message bubble (`rounded-[20px] rounded-ee-[8px]`) |
| `Card.radius` | `20px` | `rounded-[20px]` | Grouped settings sections, consent/elicitation cards, dropdown panels |
| `CodeBlock.radius` | `12px` | `rounded-[12px]` | Fenced code blocks, markdown tables, inline approval cards |
| `TrayTile.radius` | `16px` | `rounded-[16px]` | Camera / Photos / Files tiles inside PlusTray |
| `Chip.radius` | `9999px` / `6px` | `rounded-full` / `rounded-[6px]` | Capsule glass chips (`9999px`), inline `CodePill` (`6px`) |

---

## 3. Typography (`Typography.swift`)

Loaded via self-hosted/bundled variable web fonts (`Inter`, `IBM Plex Mono`, `Source Serif 4`) with metric-compatible fallback stacks and `font-feature-settings: "cv02", "cv03", "cv04", "cv11"`.

| Token (`Type.*`) | Family | Size | Weight | Line Height / Tracking | Usage |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `Type.greeting` | `Source Serif 4`, Georgia, serif | `30px` | `600` (Semibold) | `1.18` / `-0.015em` | Empty-state greeting ("Good evening", etc.) |
| `Type.agentHeading` | `Source Serif 4`, Georgia, serif | `20px` (H1 `22px`, H2 `19px`, H3 `17px`) | `600` (Semibold) | `1.3` / `-0.01em` | Headings inside agent markdown responses |
| `Type.navTitle` | `Inter`, system-ui, sans-serif | `15px` | `600` (Semibold) | `20px` / `-0.01em` | Top floating nav bar chat title & sheet titles |
| `Type.body` | `Inter`, system-ui, sans-serif | `17px` | `400` (Regular) | `27px` (`1.588` optical, `5px` line spacing) | Agent response prose (max 65ch / `680px` column) |
| `Type.userBubble` | `Inter`, system-ui, sans-serif | `15px` | `400` (Regular) | `20px` (`3px` line spacing) | User message bubble text & composer textarea (`16px` on mobile to prevent iOS Safari zoom) |
| `Type.activity` | `Inter`, system-ui, sans-serif | `13px` | `500` (Medium) | `18px` | Agent activity summary header, tool step titles, dropdown rows |
| `Type.activitySub` | `Inter`, system-ui, sans-serif | `13px` | `400` (Regular) | `18px` | Tool step arguments preview, model taglines, secondary row text |
| `Type.chip` | `Inter`, system-ui, sans-serif | `13px` | `500` (Medium) | `16px` | Suggestion chips, `FileRef`, `LinkRef`, filter pills |
| `Type.codePill` | `IBM Plex Mono`, monospace | `13.5px` | `500` (Medium) | `18px` | Inline code pills (`CodePill`) |
| `Type.codeBlock` | `IBM Plex Mono`, monospace | `13px` | `400` (Regular) | `20px` (`4px` line spacing) | Fenced code blocks |
| `Type.codeDetail` | `IBM Plex Mono`, monospace | `11px` | `400` (Regular) | `16px` | Expanded tool call JSON input/output, SSE debug trace |
| `Type.monoLabel` | `IBM Plex Mono`, monospace | `10px` | `500` (Medium) | `13px` / `+0.8px` (`0.08em`) uppercase | Section headers, language tags, keyboard shortcuts, badges |
| `Type.footnote` | `Inter`, system-ui, sans-serif | `12px` | `400` (Regular) | `16px` | Timestamps, token counts, helper descriptions |

---

## 4. Motion & Spring Physics (`Motion.swift`)

All interactive animations use spring physics (`response` in seconds, `dampingFraction` in `[0, 1]`), converted to stiffness/damping/mass via:
$$\omega_n = \frac{2\pi}{\text{response}}, \quad k = \omega_n^2, \quad c = 2 \cdot \text{dampingFraction} \cdot \omega_n, \quad m = 1$$

| Token (`Motion.*`) | Response ($s$) | Damping ($\zeta$) | Equivalent $(k, c, m)$ | Usage |
| :--- | :--- | :--- | :--- | :--- |
| `Motion.press` | `0.16s` | `0.86` | `k: 1542, c: 67.5, m: 1` | Button/row press down (`scale: 0.96`, `opacity: 0.82`) |
| `Motion.release` | `0.42s` | `0.58` | `k: 224, c: 17.3, m: 1` | Elastic button release back to `scale: 1.0` |
| `Motion.snap` | `0.30s` | `0.72` | `k: 439, c: 30.2, m: 1` | Toggle switches, filter pills, segmented selection |
| `Motion.morph` | `0.42s` | `0.76` | `k: 224, c: 22.7, m: 1` | Composer <-> PlusTray morph, dropdown submenu morph |
| `Motion.pop` | `0.36s` | `0.62` | `k: 305, c: 21.6, m: 1` | Dropdown menu open, popover appearance, chip mount |
| `Motion.reflow` | `0.36s` | `0.92` | `k: 305, c: 32.1, m: 1` | Overdamped layout reflow (activity expand/collapse, height changes; **never bounces**) |
| `Motion.reveal` | `0.30s` | `1.00` | `k: 439, c: 41.9, m: 1` | Streaming paragraph/block reveal (`opacity: 0→1`, `y: 4px→0`, `blur: 4px→0`) |
| `Motion.send` | `0.38s` | `0.82` | `k: 273, c: 27.1, m: 1` | User bubble launch from composer (`scale: 0.94→1.0`, `origin: bottom right`, `y: 18px→0`) |
| `Motion.exit` | `0.10s` | `1.00` | `duration: 100ms ease-out` | Fast dismissal of menus, tooltips, transient banners |
| `Motion.handoff` | `0.10s` | `1.00` | `duration: 100ms` | Cross-fade between states |
| `Motion.reduced` | `0.15s` | `1.00` | `duration: 150ms ease-out` | Automatic fallback when `prefers-reduced-motion: reduce` is active |

### Ambient Motion (`AmbientMotion.swift`)
- **Breathing dot**: `1.6s` easeInOut infinite pulse (`scale: 0.78 ↔ 1.0`, `opacity: 0.45 ↔ 1.0`) on active agent run indicator.
- **Thinking shimmer**: Continuous horizontal highlight sweep (`1.8s` linear loop) across active tool/reasoning label.

---

## 5. Liquid Glass & Progressive Blur (`@praxis/glass`)

### 5.1 `GlassSurface` (ported from `wapo.dp/src/lib/glass`)
- **3-Tier Engine Negotiation (`engine-detect.ts`)**:
  1. **Chromium (`svg-displacement`)**: Real-time kube.io Snell's-law squircle bezel displacement map (`displacement-map.ts`) + specular rim map (`-60°` directional light) + saturation matrix inside `<GlassFilters />` (`backdrop-filter: url(#glass-fx-...) blur(...)`). Includes the `2px` filter bleed and integer pixel `feImage` sizing.
  2. **Safari / WebKit & Firefox (`progressive-frost`)**: Three stacked `backdrop-filter` layers (sharp core `blur(frostCore)` → mid ring `blur(frostMid)` masked by `FROST_MASK_MID` → rim `blur(frostRim) saturate(...)` masked by `FROST_MASK_RIM`) + specular sheen + dual 1px inset rim lighting (`rgba(255,255,255,0.5)` top, `rgba(255,255,255,0.22)` bottom, `1px` border ring).
  3. **Reduced Transparency / Low-Power (`reduced-transparency`)**: High-contrast opaque `Paper.card` / `Paper.fill1` surface with crisp `1px solid var(--paper-hairline)` when `prefers-reduced-transparency: reduce` is enabled.
- **Material Ramp (`ultrathin` | `thin` | `regular` | `thick`)**:
  - `ultrathin`: bezel `4px`, maxDisplacement `55.65px`, frost `[1, 3, 8]px`
  - `thin`: bezel `21px`, maxDisplacement `78.53px`, frost `[2, 6, 14]px`
  - `regular`: bezel `20px`, maxDisplacement `122.81px`, frost `[3, 9, 20]px`
  - `thick`: bezel `32.5px`, maxDisplacement `133.97px`, frost `[6, 14, 28]px`
- **Interactive Rig**:
  - Pointer-tracked radial spotlight (`132px` radius) above finish and below content.
  - Spring-driven press/hold refraction boost (`0.8 → 1.0`) and shadow elevation (`0 4px 9px` → `4px 16px 24px`).

### 5.2 `ProgressiveBlurScrim` (`ProgressiveBlurScrim.swift` + `scroll-blur.tsx`)
Used at the top and bottom of `ChatScreen`, `HistorySheet`, `SettingsSheet`, `PlusTray` model list, and `GlassDropdown` scroll viewports:
- **6-Band Variable Feather**:
  - Band 1 (outermost `100%` of scrim height): `backdrop-filter: blur(0.5px)`
  - Band 2 (`82%`): `backdrop-filter: blur(1.5px)`
  - Band 3 (`64%`): `backdrop-filter: blur(3.5px)`
  - Band 4 (`46%`): `backdrop-filter: blur(7px)`
  - Band 5 (`28%`): `backdrop-filter: blur(12px)`
  - Band 6 (innermost `14%` at screen edge): `backdrop-filter: blur(20px) saturate(1.4)`
- Combined with a subtle `Paper.canvas` color feather (`0%` at inner edge → `72%` at outer rim) so scrolling text dissolves into the paper background without a hard clip line.
- Always `pointer-events: none` and `aria-hidden="true"`.

---

## 6. Screen-by-Screen Specification & Reference Mapping

### 6.1 `ChatScreen` (`ChatScreen.swift`)
- **Reference Screenshots**:
  - Light: `reference/ios/light-chat-0-bottom.png`, `light-chat-1-top-scrolled.png`, `light-chat-2-top-scrolled-far.png`, `light-chat-fine-0.png`..`5.png`
  - Dark: `reference/ios/dark-chat-0-bottom.png`, `dark-chat-1-top-scrolled.png`
- **Top Floating Navigation Bar**:
  - Left: `History` glass icon button (`36×36px` circle `GlassSurface`, clock/sidebar icon; on desktop toggles persistent sidebar or opens History sheet) + `New chat` glass icon button (`plus.bubble` / square-and-pencil).
  - Center: Current chat title pill (`GlassSurface` capsule, `Type.navTitle`, max width `220px` mobile / `360px` desktop; clicking opens quick rename/chat actions or model summary).
  - Right: `Settings` glass icon button (`36×36px` circle `GlassSurface`, sliders/gear icon).
- **Empty State**:
  - Centered vertically above composer: `Source Serif 4` `30px` greeting (`"Where should we start?"` / time-of-day greeting) + horizontal wrapping row of 3–4 `GlassChip` starter suggestions (`"Compare scrim options in a table"`, `"Summarize architecture"`, etc.).
- **Transcript Column**:
  - Centered `max-width: 680px`, `padding-inline: 20px`.
  - **User Turn (`UserBubble.swift`)**: Right-aligned, `max-width: 78%`, background `Paper.fill1`, `border: 1px solid var(--paper-hairline)`, radius `20px 20px 8px 20px`, padding `10px 14px`. Attachments (images/files) render in a rounded grid above the text; tapping an image opens a full-screen lightbox.
  - **Agent Activity (`AgentActivity.swift`)**:
    - **3 Disclosure States** (`reference/ios/light-activity-running-collapsed.png`, `light-activity-finished-folded.png`, `light-activity-finished-list.png`, `light-activity-tool-detail.png`):
      1. *Folded / Summary*: Single interactive pill/row (`"Ran 3 tools · 1.8s"` or live shimmer `"Searching codebase…"` with breathing dot and chevron).
      2. *Step List*: Vertical timeline of reasoning blocks and tool calls (`icon`, `title`, `subtitle` in `Type.activitySub`, duration/status badge).
      3. *Step Detail*: Tapping any tool step expands its `IBM Plex Mono` `11px` (`Type.codeDetail`) input arguments and output payload box (`Paper.fill1`, radius `10px`, copy button).
    - **Inline Approval Card**: When an event `approval.requested` arrives (or tool requires approval), an inline card (`Paper.card`, `1px solid Paper.hairline`, radius `12px`) appears inside `AgentActivity` showing tool name, server/connector badge, formatted arguments, and **Allow** (`Paper.tile` primary pill) / **Deny** (`Paper.fill2` secondary pill) buttons.
    - **Elicitation Sheet**: When `elicitation.requested` arrives, presents a glass modal/sheet with the requested JSON schema form fields and Submit / Cancel buttons (`POST /v1/elicitations/:id`).
  - **Agent Response (`AgentMessage.swift`)**:
    - Streaming markdown rendered block-by-block with `Motion.reveal`.
    - **Inline Chips**:
      - `CodePill`: Inline backtick code (`Paper.fill1`, `1px solid Paper.hairline`, radius `6px`, `Type.codePill`, tap to copy with checkmark toast).
      - `FileRef`: File paths (`path/to/file.ts:42`) rendered as interactive capsule chips with file icon + basename + line badge.
      - `LinkRef`: External links rendered as capsule glass chips with globe/favicon + domain + title.
      - `IntegrationTile`: Rich block card for connected MCP/skill artifacts.
    - **Fenced Code Blocks**: `Paper.fill1` card, radius `12px`, `1px solid Paper.hairline`, top bar with `Type.monoLabel` language + Copy button (`Copied` state), horizontally scrollable `Type.codeBlock`.
    - **GFM Tables (`reference/ios/light-markdown-table.png`, `light-markdown-table-wide.png`, `light-markdown-table-scrolled.png`)**: `Paper.card` container, radius `12px`, `1px solid Paper.hairline`, horizontal scroll container with right-edge shadow/feather cue when wide, sticky/tinted header row (`Paper.fill1`), `1px` hairline cell borders.
    - **Turn Action Row**: Below completed agent message: Copy, Retry (`POST /v1/chats/:id/runs`), model/latency footnote.
- **Jump-to-Latest Pill**:
  - Appears `12px` above the composer (`GlassSurface` capsule, down arrow + `"Jump to latest"`) whenever scrolled > `160px` above the bottom of the transcript.

### 6.2 `Composer` & `PlusTray` (`Composer.swift`, `PlusTray.swift`)
- **Reference Screenshots**: `reference/ios/light-tray-2-main.png`, `light-tray-0-models-top.png`, `light-tray-1-models-scrolled.png`.
- **Floating Composer Bar**:
  - Wrapped in `GlassSurface` (`radius={28}`, material `regular`).
  - Left button: `+` (`Add photos, files and more`, `32×32px` circle in `Paper.fill2`, rotates `45°` to `×` when tray is open).
  - Center: Auto-growing textarea (`1` to `8` lines, placeholder `"Message…"`, `Enter` to send on desktop, `Shift+Enter` for newline) + attachment thumbnail strip above input when files/photos are queued.
  - Inline Model Search Mode: When the model picker is triggered from the composer/tray, the composer input can act as live inline filter (`"Search models…"`).
  - Right controls:
    - **Model / Effort quick pill** (on desktop & wide mobile): Opens the **Improved GlassDropdown** directly anchored to the composer.
    - **Voice Input Button** (microphone icon): Records audio via `MediaRecorder` (`audio/webm` or `audio/mp4`), shows live waveform + elapsed timer + cancel/confirm, and posts to `POST /v1/transcribe` (inserting transcribed text into the composer). If voice consent hasn't been granted, opens `ConsentSheet` first.
    - **Send / Stop Button**: `32×32px` circle (`Paper.tile` with `Paper.tileGlyph` up-arrow when text is non-empty; `Paper.destructive` stop square while a run is active, calling `POST /v1/chats/:id/runs/:runId/cancel`).
- **PlusTray (`PlusTray.swift`)**:
  - Morphs smoothly above/from the composer (`Motion.morph`, radius `28px`, `GlassSurface`):
  - **Top 3 Action Tiles** (3 equal columns, `Paper.fill1`, radius `16px`, height `72px`):
    1. **Camera** (opens camera capture / file input with `capture="environment"`)
    2. **Photos** (opens image picker `accept="image/*"`)
    3. **Files** (opens document picker)
  - **Configuration Rows** (using the **Improved GlassDropdown**):
    1. **Model Row**: Shows current provider + model name, `DotMeter` (5 dots each for Speed ⚡ and Intelligence ✦), and tagline. Clicking opens the improved `GlassDropdown` model selector with:
       - Live search input (`"Filter 500+ models…"`)
       - Pinned / Favorite models section (`★` pin toggle per model)
       - Grouped by Provider (`OpenAI`, `Anthropic`, `Groq`, `Local`, etc.)
       - Virtualized list (smooth 60fps with 500+ models)
       - Speed & Intelligence `DotMeter` + Vision badge (`👁`) + Context window badge
    2. **Reasoning Effort Row** (shown when selected model `supportsReasoning` is true): `low` / `medium` / `high` segmented pill or dropdown submenu.
    3. **Connectors / Tools Row**: Shows count of active connectors for this chat (`"2 enabled"`), with per-chat off-switch toggles so tools can be disabled for the current conversation (`Chat.disabledConnectorIds`).

### 6.3 `HistorySheet` (`HistorySheet.swift`)
- **Reference Screenshots**: `reference/ios/light-history-0-top.png`, `light-history-1-scrolled.png`, `light-history-2-scrolled-far.png`.
- **Header**: Title `"History"`, search bar (`"Search conversations…"`), filter pills (**All**, **Pinned**), `New chat` button, and `History options` (`•••`) dropdown menu (**Select chats**, **Settings**).
- **Conversation List**:
  - Grouped by relative date (**Pinned**, **Today**, **Yesterday**, **Previous 7 Days**, **Older**).
  - Each row shows chat title (`15px` semibold), 1-line preview of last message (`13px` `Paper.secondaryInk`), relative timestamp (`12px` `Paper.mutedInk`), and pin indicator.
  - Row actions (hover menu on desktop / swipe or long-press context menu on mobile via `GlassDropdown`): **Pin / Unpin**, **Rename**, **Delete** (`DELETE /v1/chats/:id`).
  - **Batch Selection Mode**: Checkbox per row + bottom floating action bar with **Delete selected (N)**.

### 6.4 `SettingsSheet` & Sub-Screens (`SettingsSheet.swift`, `ConnectorsScreen.swift`, `ImageReaderScreen.swift`)
- **Reference Screenshots**:
  - `reference/ios/light-settings-0-root.png`, `light-settings-1-root-scrolled.png`
  - `reference/ios/light-settings-2-connectors.png`, `light-settings-3-add-url.png`, `light-settings-4-paste-config.png`
  - `reference/ios/light-settings-5-skills.png`, `light-settings-6-image-reader.png`
  - `reference/ios/light-settings-7-editor-top.png`, `light-settings-8-editor-scrolled.png`
  - `reference/ios/light-consent-0-sheet.png`
- **Settings Root**:
  1. **Providers Section**: List of configured LLM providers (`OpenAI`, `Anthropic`, `Groq`, custom OpenAI-compatible endpoints) with status badge (`Connected` / `Missing key`) + **Add provider** button.
  2. **Provider Editor**: Preset selector (`OpenAI`, `Anthropic`, `Groq`, `OpenRouter`, `Custom`), Display Name, Base URL, API Key (write-only masked input), Default Model, Custom HTTP Headers (`key: value` pairs), **Verify & Refresh Models** (`POST /v1/providers/:id/models/refresh`), and **Delete Provider**.
  3. **Tools Section**:
     - **Connectors (MCP)** (`ConnectorsScreen.swift`):
       - List of configured MCP servers with status (`Connected · N tools`, `Needs sign-in`, `Error`), `"New tool"` badge when `hasNewTools` is true, expand/detail view with per-tool enable/disable switches (`PATCH /v1/connectors/:id/tools/:toolName`), **Probe/Refresh** (`POST /v1/connectors/:id/probe`), and **Sign in with OAuth** (`POST /v1/connectors/:id/oauth/start` popup flow).
       - **Add by URL**: Name, MCP Server URL (SSE / Streamable HTTP), optional Bearer token / custom headers.
       - **Paste a config**: Accepts Claude Desktop / Cursor `mcpServers` JSON or command snippet, parses and creates connectors.
       - **Browse the MCP registry**: Searchable catalog from `/v1/registries` with 1-click **Install**.
     - **Skills**:
       - List of installed skills (`name`, `description`, `enabled` toggle, `content` markdown viewer/editor, delete) + **Import skill** (by URL or markdown paste) + **Browse skills** (from skill registries in `/v1/registries` with 1-click install).
  4. **Capabilities & Privacy Section**:
     - **Image reading model (`ImageReaderScreen.swift`)**: Configure how images are read when the active chat model lacks native vision (`preferences.vision`: toggle enabled, select Vision Provider & Model with `Verified vision support` vs `Unverified vision support` sections).
     - **Voice input (`VoiceSettingsScreen`)**: Select transcription provider/model (`preferences.voice`, e.g., `whisper-large-v3-turbo`), language hint, API key status, and view local/cloud voice recordings list.
     - **Appearance**: `System` / `Light` / `Dark` theme selector + Liquid Glass Lab link (`/lab/glass`).
     - **Data Consents**: Review and revoke per-host/provider data-sharing consents (`GET /v1/consents`, `POST /v1/consents`).
- **Consent Sheet (`ConsentSheet`)**:
  - Presented automatically before sending data to an unconsented third-party provider, vision proxy, or voice transcription service (`reference/ios/light-consent-0-sheet.png`). Shows exact destination host, what data is sent (messages, attachments, or audio), and **Allow** / **Cancel** buttons.

---

## 7. Intentional Web & Desktop Adaptations

While mobile viewport (`402×874`) is a pixel-faithful match to iOS (`iPhone 17 Pro`), desktop viewport (`1440×900`) applies these intentional ergonomic adaptations:

| Area | iOS / Mobile Web (`< 900px`) | Desktop Web (`≥ 900px`) | Rationale |
| :--- | :--- | :--- | :--- |
| **Reading & Composer Column** | Full width (`402px` minus `20px` margins) | Centered `680px` column (`Rhythm.maxReadingWidth`) inside flexible canvas | Preserves optimal `65ch` editorial line length |
| **History Navigation** | Modal bottom sheet (`HistorySheet`) triggered from top-left button | Collapsible left glass sidebar (`280px` wide, toggleable via top-left button or `⌘S` / `⌘B`) + modal sheet option | Desktop users expect persistent or 1-keystroke thread switching without covering the active transcript |
| **Settings & Connectors** | Full-height push navigation stack inside bottom sheet | Centered floating glass dialog (`640px × 720px`, `radius: 24px`) with internal breadcrumb/back stack | Prevents awkward full-screen stretching of form fields on 27" monitors |
| **Model & Effort Picker** | Inside `PlusTray` or anchored above composer | Anchored **Improved GlassDropdown** (`morph` or `cascade` mode) directly on composer model pill + `⌘K` / `⌘M` shortcut | Immediate 1-click / keyboard access without two-step tray opening |
| **Keyboard Shortcuts** | Virtual keyboard return key | `Enter` to send (`Shift+Enter` newline), `⌘K` command/model menu, `⌘/` toggle history, `Esc` close active dropdown/sheet or cancel stream | Desktop keyboard-first workflow |
| **Screen Corners** | Device hardware squircle (`ScreenCorners.swift`) | Clean viewport edges on full-window web; optional device frame in `/lab/glass` | Browser window already owns outer chrome |
