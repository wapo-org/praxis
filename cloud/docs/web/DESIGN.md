# Praxis web design system (WP-D1)

Binding for D2 and D3. It supersedes the glass, engine and motion parts of `UI_SPEC.md`.
Source of truth is the iOS app (`docs/web/reference/ios/*.png`, `PraxisChat/PraxisChat/DesignSystem/Tokens.swift`).
The target is a calm desktop chat app with the iOS identity: warm paper neutrals, a serif display face and black primary controls.

## Rules
1. **Tokens only.** Every size, colour, radius, shadow and timing comes from `apps/web/src/styles/tokens.css`.
   Never write a raw px or hex value in a component, except a 1–3 px hairline or optical nudge.
2. **CSS Modules** (`Component.module.css` next to the component).
   Inline `style` is only for truly dynamic values, such as a measured height.
   When you touch a legacy file, convert it.
3. **One scale per axis.** Never put a 44 px control next to a 28 px one in the same row.
   Pick one control height per cluster.
4. **Glass is for floating chrome only.** That means the sidebar, the composer pill, the top-bar clusters, menus and popovers.
   Content (messages, activity rows, cards, chips on the canvas) is never glass.
5. **Motion goes through `@praxis/glass` presets**, and only `transform` and `opacity` animate.
   No ad-hoc durations. `design-system.test.ts` fails the build if you add one.
6. **Icons:** lucide only, imported from `lib/icons.ts`. Each is bound through `<Icon>`, so sizes are 16/18/20 and the stroke is 1.75.

## Tokens (`tokens.css`, light and dark under `[data-theme]`)
| Group | Tokens |
|---|---|
| Space (4 px) | `--space-1..16` = 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 |
| Type | `--text-xs/sm/md/lg/xl/2xl` = 11/12/14/16/19/26 with `--leading-*` 15/17/20/26/26/32. `--text-input-touch` 16 applies to every field on touch screens only (`theme.css`), because iOS zooms a focused field below that; on desktop the composer uses body size |
| Faces | `--font-sans` Inter (all UI and body), `--font-display` Source Serif 4 (greeting, headings, wordmark), `--font-mono` IBM Plex Mono (code only) |
| Weights | 400 / 500 / 600 only. `--tracking-tight` for titles, `--tracking-display` for serif |
| Controls | `--control-sm` 28 (row actions, chips in dense UI), `--control-md` 36 (default), `--control-lg` 44 (touch, account row) |
| Radii | `--radius-sm` 8 (rows, small buttons), `md` 12 (cards, code), `lg` 16 (menus, tiles), `xl` 20 (bubbles), `2xl` 28 (composer, tray), `full` |
| Icons | `--icon-sm/md/lg` 16/18/20 with `--icon-stroke` 1.75 (`ICON_STROKE` in TS) |
| Layout | `--sidebar-width` 260, `--column-width` 720, `--topbar-height` 56, `--float-margin` 12, `--popover-width` 360, `--popover-max-height` 480 |
| Colour | `--color-paper` canvas, `--color-sidebar`, `--color-surface` card, `--color-fill-1/2`, `--color-bubble` (user bubble), `--color-ink`, `--color-ink-2` secondary, `--color-ink-3` tertiary, `--color-hairline` (and `-strong`), `--color-hover`, `--color-pressed`, `--color-accent` (black in light, paper in dark) with `--color-on-accent`, `--color-danger`, `--color-success`, `--color-focus`, `--color-scrim` |
| Elevation | `--shadow-1` (chips, inspector), `--shadow-2`, `--shadow-3` for non-glass surfaces. Glass: `--glass-contact` plus a per-material `--glass-*-lift`, geometry and alpha separate. All wide, soft and low: no visible edge or ring around a shape. No other shadows |
| Motion | `--duration-fast` 120, `--duration-base` 200, `--duration-slow` 320 ms, `--ease-standard` `cubic-bezier(.2,0,0,1)`; `--duration-ambient` and `--ease-ambient` are only for status loops |

Paper, ink, fill, success and danger hex values equal iOS `Tokens.swift` in both themes; a test enforces this.
Two values deviate on purpose:
- The web hairline is translucent ink (8%/14%), so it reads the same on paper, sidebar and glass.
- The pressed and tile colours are aliased.

Legacy `--paper-*` names alias to `--color-*` so the D3 screens (chat activity, approvals, History, Lab) keep rendering. New code must not use them.

## Glass (`packages/glass`)
`<GlassSurface material="regular|thick|clear" shape="card|capsule" radius? stretch? spotlight?>` is the material. Motion props go straight on it.

**Chromium: a real lens.** `backdrop-filter: url(#id)` with the kube.io construction ported from `wapo.dp` (`displacement-map.ts`, `LensFilter.tsx`): base-chroma correction, core frost, a rim frost through a mask, `feDisplacementMap` with the baked bezel curves, and a specular rim. Backdrop bends only in the bezel; the map is neutral elsewhere. **Other engines: progressive frost.** Three stacked, masked backdrop-blur bands. Negotiated by `glassTier()`, never by `CSS.supports` (it tests parsing, not rendering). The source's WebGL tier and DOM capture are deliberately not ported.

**Every tier:** the same paint on a child layer (dual sheen, rim, hairline ring, inner shading), the outer shadow on the root (contact plus lift, both scaled by `--glass-fade`), and a pointer-tracked spotlight that only moves a transform (off for touch and reduced motion).

**The glass wakes when held** (`rig.ts`): refraction 0.8 → 1.0 on spring {250, 14}, shadow {340, 30} and {220, 24}. The contact shadow spreads from `--glass-contact` by `HELD_SHADOW`; it never hardens. Imperative, no re-render; nothing stays inline at rest.

| Recipe | Use | Optics (`material.ts`): refraction / core blur | Light tint | Dark tint |
|---|---|---|---|---|
| `regular` | composer pill, navbar title and clusters | 1.0 / 3 | paper 50% | `rgba(26,26,24,.48)` |
| `thick` | sidebar, popovers, tray | 1.25 / 9 | paper 72% | `rgba(24,24,22,.72)` |
| `thick` + `--glass-menu-tint` | menus (AA for danger text over black) | 1.25 / 9 | paper 90% | `rgba(24,24,22,.86)` |
| `clear` | small floating chips (jump to latest) | 0.875 / 3 | white 46% | `rgba(40,40,37,.5)` |

**Cost.** Chromium re-uploads `feImage` textures whenever the lens redraws, so map size is the cost, not the filter nodes. `PIXEL_BUDGET` (60k map pixels per surface) is what holds 120 Hz; the source's 1.1M dropped scrolling to 60 Hz. Maps build at rest size, off the frame, after decoding (an undecoded `feImage` displaces the whole backdrop), debounced on real resize, in a bounded cache (48). Never rebuilt in a gesture: transforms do not resize. Idle: no JS at all.

Other behaviour:
- `prefers-reduced-transparency` falls back to an opaque `--glass-fallback`.
- **Never put `opacity` on the glass root or an ancestor while you want the lens:** it makes a backdrop root and the lens samples nothing. `GlassSurface` routes an `opacity` motion prop to `--glass-fade`, which the layers and content read. A wrapper can animate `--glass-fade` itself (`ChatScreen`'s jump chip). Scale and translate are fine anywhere.
- Never put a CSS `filter` (for example a hover brightness) on an ancestor of glass.
- `ProgressiveBlurScrim edge="top|bottom"`: 4 static, masked backdrop-blur bands (1/3/6/12 px) plus a paper feather. Used under the top bar (48 px) and the composer (64 px), short enough that content reaches the glass, which is what the lens bends.
- `ScrollBlur` (menus, lists): a mask fade driven by `animation-timeline: scroll()`. It appears only at the scrolled edges and has zero JS.
- Menus never clip: `GlassDropdown` content portals to `document.body` (positioned against the viewport), and `ScreenMenu` uses `portal` with no `boundary`. Glass inside another glass (for example a `ScreenMenu` inside a settings popover) is always portaled outside the parent backdrop root.
- Viewport edges: menus flip and clamp inside the viewport (dropdown `positioning.ts`); popovers clamp their own fixed position to the viewport.

## Stretch (`packages/glass/src/stretch.ts`, math verbatim from `wapo.dp`)
Hold any glass and pull: it grows toward the pointer in any direction, and the far side stays put. Written to the root's `scale` and `translate` properties, which compose with framer-motion's own `transform`. There is no wrapper.
- **Math:** tanh `saturatePull` against the elliptical `directionalBudget` (~1 cm or 22% of the axis, per material), axis-aligned, never sheared. Follow spring {340, 30} with velocity handoff. Release uses per-material `bounce` and `settle`, so it crosses zero and wobbles. Engages at 3 px with no jump.
- **Starts anywhere, over anything:** buttons, links, chat rows, switches, icons. The nearest surface owns the pull. Only a text field holding text, an active selection, a range input, a scrollbar and `[data-glass-no-stretch]` refuse.
- **Click:** no pointer capture and no `preventDefault` on press, so focus and clicks work. Past 8 px of travel the trusted click is swallowed; synthetic `row.click()` passes.
- **Menus** (`stretch="edge"`): press-drag-release still scrubs inside; past the edge the menu stretches toward the pointer, and releasing there selects nothing. A press on a `[data-press-opens]` trigger belongs to the menu.
- **Scrollers inside glass:** touch pans vertically until the limit; at the limit or sideways it stretches. A mouse drag always stretches; the wheel scrolls.
- `prefers-reduced-motion` turns it off. `glass.test.ts` enumerates every `GlassSurface` use and forbids `stretch={false}`.

## No modals
No centered dialogs and no dimmed backdrops, on any screen size. `SettingsModal`, `SheetDialog`, `SheetsRoot`, `SettingsSheet`, `HistorySheet`, `ConsentSheet` and `DeleteAccountSheet` are deleted.
- Settings takes over the floating nav: the same panel changes from chats to the settings sections with a push, its back row returns to chats, and the content is a routed page (`SettingsPage`) in the remaining space. There is no second rail and no Done button. Narrow screens follow the same model.
- History is the floating sidebar: docked on desktop, a floating panel on narrow screens.
- The AI data-consent step is a small anchored popover (`ConsentPopover`) above the composer: no scrim, no focus trap, no background inertness; Escape and outside clicks do nothing, and the send path still blocks until answered.
- Account deletion is an inline two-step confirm (`AccountSettings` → `DeleteAccountConfirm`).
- The composer plus menu is a compact popover: 360 × 480 px at most, controls 36 px (44 px max). The only height exception is the two-line model row (56 px, `--row-model`).

## Motion (`packages/glass/src/motion.ts`, the only TS source)
- **Springs with carried velocity for everything spatial.** A retargeted framer spring keeps its velocity, so any animation reverses from where it is. CSS curves (`--duration-*`) are for colour fades and ambient loops only.
- The family (`SPRINGS`): `SPRING` {520, 38} default; `snap` {760, 46} press, switch, segmented thumb, chevrons; `glide` {460, 36} the highlight between rows; `panel` {340, 32} sidebar, panel content, pages; `follow`, `lens`, `shadow`, `shadowAlpha` for the stretch and the held rig. `TRANSITION.*` are near-critically damped versions for fades.
- `GlideHighlight`: one pill per list that glides between hovered rows; another tracks the current row. Layout is read once per row change.
- Disclosure and arrivals: `chat/chatMotion.ts`. A height change happens once in layout and what follows glides there with transforms (FLIP). A new message rises in; a loaded history does not.
- Only `transform` and `opacity` animate, plus the lens scale for the held rig.
- `STAGGER` is 30 ms between rows.
- Presets:
  - `popIn`: the consent popover and small chips. Opacity plus scale 0.88. Menus and the tray use the morph below, not this.
  - `sheet`: y 16, scale 0.99, plus fade.
  - `fade`: scrims.
  - `listItem`: opacity plus y 10.
  - `sidebarSlide`: fully off the leading edge and back, never a fade. `pageChange`: a small settle between pages.
  - `press`: `whileTap` scale 0.97.
  - `slideIn` / `slideUnder`: push navigation inside the tray. The next page enters from x 24; the page under it recedes to x -24.
- Hooks:
  - `usePreset(preset)` and `usePress()` are reduced-motion aware. Under `prefers-reduced-motion` every preset becomes an opacity-only fast fade.
  - `useReducedMotion()` reports the setting.
- Colour fades use the `--duration-*` and `--ease-standard` tokens.
  - The global reduced-motion rule collapses all CSS animation.

## Menu morph (`packages/glass/src/morph`, numbers in `MORPH`, `motion.ts`)
Every menu grows out of its button as one piece of glass that changes shape, measured frame by frame from the iOS recording (`design/menu-morph-ref`). It is not a finished menu being scaled, and it is not a fade. `<GlassMorph source radius>` is the only implementation; both button classes use the same parameters.

**Two classes, decided at open from the DOM (`morph/source.ts`):**
- **Separate:** the trigger is the only control in its own glass and fills at least half of it. That glass becomes the menu: it lifts and whitens, hands over by `--glass-fade`, and nothing is left behind while the menu is open. It returns on close, and so does the glyph.
- **Attached:** anything else. The parent and the button do not change or move, apart from ordinary press feedback. The menu grows from a small blob on the button with the same timing, path and content.

| Trigger | Class | Why |
|---|---|---|
| Chat row "…" (`SidebarChats`) | attached | inside the sidebar glass, in a row |
| Composer + (`PlusTray`) | attached | inside the composer pill |
| `ScreenMenu plain`, the provider preset (`ProviderEditor`) | attached | a row control on a page, no glass of its own |
| `ScreenMenu` not plain (no caller today) | separate | the default `Trigger` has its own capsule |
| Cascade `SubTrigger` | attached | a menu row |
| `GlassDropdown.Trigger` default (Lab: `DropdownPositions`, `AppleNotesReplica`, `VirtualModelPicker`) | separate | its own capsule |
| Lab `asChild` in a shared capsule (`MorphLab`) | attached | shares glass with a neighbour |

Not menu triggers, so no morph: the in-place `morph` submenu (the same glass changes content), `ConsentPopover` (opened by the send path, no button; keeps `popIn`), the narrow sidebar panel (a slide), and the header's Settings, New chat and title buttons (they navigate). **In production today every menu trigger is attached;** the separate class is reachable only through the default `Trigger`, which the Lab uses.

**The motion, from the press:**
| ms | Shape | Content |
|---|---|---|
| 0-110 | Source lifts near-opaque with a wider shadow | Glyph leaves |
| 140-230 | Near-circle, growing away from the button; the far edge stays near it | Copy arrives blurred and oversized, cut and bent by the rim |
| 230-320 | Full width, carried about 11 % of its height past its place, squaring up | Sharp rows take over; tint arrives |
| 320-640 | Bleeds off the last 2.5 %, no bounce | Rows contract into place |

Close is the same path in reverse and faster. A menu opening up or left mirrors by itself, because the path runs from the source's box to the final box.

**Why this technique.** The glass stays its rest size in layout: `transform` on the shell takes it from the source's box to the menu's, `border-radius` is written against that scale, and the content layer is counter-scaled. Layout never runs, and the real lens, rim, sheen and shadow all follow the shape. A clip-revealed fixed panel would have needed a separate rim and shadow, and it would not read as one piece of glass.
- **Refraction:** one prebuilt round map (`transit.ts`, built at idle when the first glass mounts), stretched to each menu by its `feImage` rect. The rest lens's map would only bend four arcs of a circle. It hands over to the real lens by opacity as it lands, which is also how the glass gains its tint. No map or filter value changes per frame.
- **Blur:** a static inert copy of the rows under a fixed filter (bend, blur, ink), crossfaded with the live rows and removed when it is gone. The blur radius never animates. Frost tier: a fixed CSS blur, no bend, same motion.
- **Interruption:** the springs' position and velocity are the whole state (`stepSpring`), so any retarget reverses from where it is. Re-tap, Escape, outside click and fast toggling all use that.
- **Pointer:** until the glass has landed the shell takes no pointer, so the button under it keeps re-taps and a quick release selects nothing. A release outside the rest box still dismisses.
- **Stretch:** nothing stays inline at rest. The morph owns the shell's transform and the stretch owns the root's `scale` and `translate`, so they compose, including during the settle. `morph/registry.ts` gives the stretch the rest box while the glass moves.
- **Reduced motion:** a plain short fade through `--glass-fade`; no scale, no shape change, no copy.

## Performance budget (WP-G2, measured 2026-11-07)
`node apps/web/scripts/g2-perf.mjs`: `COLD=n` for fresh-session first opens, `UNCAPPED=1` for headroom, `NO_LAB=1` against a production build. The Lab exists only in dev. Results are in `~/.praxis-agent-state/cloud/design/G2/perf-*.json`. `g2-trace.mjs` prints a morph's numbers per frame, and `g2-compare.mjs` and `g2-capture.mjs` build the boards, strips and videos. The screencast's own timestamps lag by hundreds of ms, so each captured frame carries its true time as a barcode.

## Shell (`apps/web/src/components`)
- **Layout.** The chat layer is full-bleed (`ChatScreen` transparent over `--paper-gradient`), so scrolling messages pass behind the floating sidebar, top bar and composer; the gradient gives the blur something real to sample at any width. The message column stays centred in the full width, max 720 px. The settings page clears the floating sidebar on desktop (`data-sidebar` padding).
- **Breakpoint:** desktop ≥ 1024 px; the narrow layout is designed at 402 px. Breakpoint visibility is CSS only (`.narrow` / `.desktop`).
- **Sidebar** (`shell/Sidebar`, floating in every state):
  - Fixed, inset `--float-margin` from the left/top/bottom edges; radius 20; glass `thick`. Not docked: no layout space is reserved, so content passes behind its glass.
  - Desktop: full-height sheet (260 px wide). Narrow (<1024 px): the same content as a floating panel (≤320 px wide, ≤480 px tall), portaled to the document root; Escape or an outside click closes it and returns focus to the History button; choosing a chat, New chat or Account also closes it.
  - Wordmark in serif 19 with a collapse button.
  - "New chat" and an inline "Search" (⌘K focuses it) as 36 px ghost rows.
  - Chats grouped by date (`lib/chatGroups.ts`) as 36 px single-line rows; the hover "…" (28 px) opens a glass menu (right-click works too).
  - The account/settings row sits at the bottom.
- **Top bar** (`chat/ChatHeader`):
  - 56 px, transparent over the progressive scrim.
  - A glass `regular` capsule navbar pill: centered title (12/600) and model (11, ink-2). Tapping it opens Settings.
  - Glass `regular` capsule clusters of 36 px buttons:
    - narrow: History on the left, New chat on the right
    - desktop: sidebar toggle and New chat on the left (only while the sidebar is collapsed), Settings on the right
  - There is no Lab button. Lab lives at `/lab` and in Settings → Developer, both dev-only.
- **Empty state:** serif 26/32 greeting, 14 ink-2 lede, and 36 px hairline suggestion pills, vertically centred.
- **Message column:**
  - max 720 px wide.
  - Assistant text is 16/26 Inter. Headings are serif 26/19/16. Code and tables sit in `--radius-md` hairline cards.
  - User bubble: `--color-bubble`, radius 20, 14/20, max 78% wide.
  - Turn rhythm: 32 px before a user turn, 16 px after it, and 20 px from an activity row to its answer.
  - Actions under the answer: 28 px ghost icon buttons (16 px icons, ink-3).
- **Activity** (iOS `AgentActivity.swift` parity, no badges):
  - One plain disclosure row: 16 px chevron on the left, then muted 12 px medium text. No pill, background, border, dot or shadow.
  - "Currently working…" (shimmer, with the running step as a muted second line), "Waiting for tool approval (N)", "Waiting for your input", "Worked for Ns", "Stopped after Ns", "(N failed)".
  - Level 2: one line per call (icon, mono name, muted summary). Level 3: input/progress/output in a hairline mono detail. Approvals and questions always show under the header, even folded.
- **Approvals and questions** (`ApprovalCards`, `ElicitationCards`): compact `--radius-lg` cards on `--color-surface` with a hairline border; 36 px action buttons; mono args in `--color-fill-1`.
- **Composer** (`chat/Composer`, `chat/ComposerBar`):
  - A glass `regular` pill (radius 28, padding 8) floating from the bottom.
  - Controls: + / auto-growing textarea (14/20 on desktop, 16 on touch, max 200 px; measured once per change) / camera / mic / send-or-stop.
  - Every control is a 36 px accent circle, as on iOS.
  - The plus menu is a compact popover (360 × 480 px at most), anchored to the pill.

## Performance budget (WP-G1, measured 2026-11-05)
`node apps/web/scripts/g1-perf.mjs` (production build; `HEADED=1` for a real GPU). Numbers and the budget live in `~/.praxis-agent-state/cloud/design/G1/perf-*.json`; earlier `d1-perf.mjs` results follow.

## Performance budget (measured 2026-11-01)
Setup: Chromium, production build (`vite build` plus `vite preview` proxied to the local API), 1440×900.
Command: `node apps/web/scripts/d1-perf.mjs`. It writes `perf.json` next to the D1 screenshots.

| Budget | Result |
|---|---|
| No long task > 50 ms while scrolling a 200+ message chat | 220-message chat, 0 long tasks; scripted scroll frames p50 16.7 ms, p95 16.8–17.7 ms. The UI renders the latest 100 messages (existing `listMessages` limit) |
| No long task > 50 ms when opening a menu | 5 opens, 0 long tasks |
| No long task > 50 ms when opening the tray or a 500-model list (WP-D2, 2026-11-05) | 5 tray opens and 4 list opens plus a scroll through all 500, paged like the API: 0 long tasks, 14 options mounted |
| No per-frame JS while idle | 0 rAF callbacks, 0 ms script, 0 layouts in 2 s; 0 canvases |
| Lighthouse performance ≥ 90 (built app, authenticated `/`) | 96, 95 and 91 on three runs (FCP 2.0 s, LCP 2.6–3.2 s, TBT 0 ms, CLS 0.002) |

Google Fonts load non-blocking (`preload` + swap) with weights trimmed to the scale. That change took Lighthouse from 77 to 95.
The JS bundle is 713 kB (216 kB gzip); code-splitting the sheets is the next win.

## Visual gate
`node apps/web/scripts/d1-capture.mjs` (API on 8821, web on 5195) writes to `~/.praxis-agent-state/cloud/design/D1/`:
- states: empty, chat (bottom and top), tray, settings sheet, and a sidebar menu
- sizes 1440×900 and 402×874, in light and dark
- `compare-*.png` boards next to the iOS references

## Visual gate (D2)
`node apps/web/scripts/d2-capture.mjs` (API on 8822, web on 5196; `ONLY=` filters states) writes to `~/.praxis-agent-state/cloud/design/D2/`: tray main, model list and search, tray over a chat, every Settings page, consent, delete account, menus at a viewport edge and inside a sheet, plus `compare-*.png` boards next to iOS.

## Left for D3
- Activity and tool rows, approvals, elicitation, the history sheet, sign-in and Lab.
- `screens/screens.css` now holds only what `HistorySheet` reads. Convert it, then delete the file, the `.account-screen` rules and `.screen-history-*` hover rules in `theme.css`, and the `--paper-*` aliases once nothing reads them.

## Spotlight search (WP-G3C)
Search is an upper-centre floating thick `GlassSurface` (640 px maximum, viewport minus 24 px on narrow screens), opened explicitly from Search or Cmd/Ctrl+K. History does not focus an input. No scrim or modal focus trap. Escape/outside closes; arrows/Enter select; Escape or Backspace on an empty option query returns to actions.
The reference sheets (`search-ref/sheet1.png`, `sheet2.png`) show an anchored, slightly oversized blurred arrival and a quick fade/blur close, without travel. `searchArrival` in the shared motion module supplies the restrained spring. A fixed blurred text copy crossfades; the lens is never filtered. Unlike ordinary disclosure motion, search explicitly animates the measured panel height using the shared spring: the growing edge reveals already-present rows without scaling, fading or staggering them. This is the owner's requested exception to the transform/opacity rule. Selection changes immediately. Reduced motion skips size/scale motion.
`actions/registry.ts` owns action metadata, model/mode/reasoning options and their application for search and composer menus, plus attachment definitions and chat row actions. Models retain only names, stars and selection in production rows; tagline, capability badges and inline speed meters are removed. There was no production sort/filter by intelligence/speed/capabilities to remove; model search still matches name/ID.
Search reads `/v1/search` because bootstrap/replica only contain visited messages. The authenticated route uses the shared memory/Convex Store contract, excludes deleted records and orphan messages, matches Unicode words across title/text, and returns bounded matched context. Requests debounce, ignore stale responses, and keep quiet while loading. At most 50 chat hits are returned per query (route supports pagination).
