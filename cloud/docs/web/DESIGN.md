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
4. **Glass is for floating chrome only.** That means the composer pill, the top-bar clusters, menus and popovers.
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
| Radii | `--radius-sm` 8 (small buttons), `md` 12 (cards, code), `lg` 16 (tiles), `xl` 20 (bubbles), `2xl` 28, `full` (row hover and selection). Glass: `--radius-menu` 42, `--radius-panel` 36, `--radius-composer` 44 |
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
| `regular` | composer pill, navbar title and clusters | 1.0 / 3 | paper 44% | `rgba(26,26,24,.42)` |
| `thick` | popovers, tray (the sidebar is opaque since WP-G5) | 1.25 / 9 | paper 66% | `rgba(24,24,22,.66)` |
| `thick` + `--glass-menu-tint` | menus (AA with `--glass-menu-danger` over any backdrop) | 1.25 / 9 | paper 84% | `rgba(24,24,22,.8)` |
| `clear` | small floating chips (jump to latest) | 0.875 / 3 | white 40% | `rgba(40,40,37,.44)` |

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
- Settings takes over the floating nav: the same panel changes from chats to the settings sections as an instant cut (no crossfade or slide), its back row returns to chats, and the content is a routed page (`SettingsPage`) in the remaining space with no redundant page header. There is no second rail and no Done button. Narrow screens follow the same model.
- History is the floating sidebar: docked on desktop, a floating panel on narrow screens.
- The AI data-consent step is a small anchored popover (`ConsentPopover`) above the composer: no scrim, no focus trap, no background inertness; Escape and outside clicks do nothing, and the send path still blocks until answered.
- Account deletion is an inline two-step confirm (`AccountSettings` → `DeleteAccountConfirm`).
- The composer plus menu is a compact popover: 360 × 480 px at most, controls 36 px (44 px max). The only height exception is the two-line model row (56 px, `--row-model`).

## Motion (`packages/glass/src/motion.ts`, the only TS source)
- **Springs with carried velocity for everything spatial.** A retargeted framer spring keeps its velocity, so any animation reverses from where it is. CSS curves (`--duration-*`) are for colour fades and ambient loops only.
- The family (`SPRINGS`): `SPRING` {520, 38} default; `snap` {760, 46} press, switch, segmented thumb, chevrons; `panel` {340, 32} sidebar, panel content, pages; `follow`, `lens`, `shadow`, `shadowAlpha` for the stretch and the held rig. `TRANSITION.*` are near-critically damped versions for fades.
- **Instant screen and sidebar view cuts (WP-G3B):** switching between top-level screens (`ChatScreen` ↔ `SettingsPage`), between settings sub-pages, and between sidebar views (`SidebarChats` ↔ `SidebarSettings`) is an immediate swap with zero slide or crossfade. Only explicit sidebar collapse/expand uses `sidebarSlide`.
- Hover has no motion: rows own an instant pill background (see Corners and rows).
- **iMessage send animation and list FLIP (`chat/chatMotion.ts`, WP-G3B):**
  - Sending a message launches a single transform-driven shared bubble (`sendBubbleShapeAt` / `launchSendFlight`) from the composer input rect to the final user bubble slot while the composer input immediately clears to its placeholder without animating.
  - Trajectory (calibrated to 60 fps iOS reference `design/send-ref/sheet1.png` & `sheet2.png`, 0–820 ms): materialises over the input field by ~40 ms; left edge pulls right rapidly while right edge stays anchored (40–200 ms); rises to final Y (40–320 ms) while inner text is counter-scaled so glyphs stay 1:1 and left-aligned; overshoots ~4–7 CSS px above the final slot (360–480 ms); drifts gently back down into rest by 820 ms with no second bounce.
  - Preceding messages in the column glide up smoothly via transform FLIP on `SPRING` as room is made.
  - Respects `prefers-reduced-motion: reduce` (skips flight and places the message in its slot immediately).
- Disclosure and arrivals: `chat/chatMotion.ts`. A height change happens once in layout and what follows glides there with transforms (FLIP) while preserving scroll anchor. A new assistant message rises in; a loaded history does not.
- Only `transform` and `opacity` animate, plus the lens scale for the held rig.
- `STAGGER` is 30 ms between rows.
- Presets:
  - `popIn`: the consent popover and small chips. Opacity plus scale 0.88. Menus and the tray use the morph below, not this.
  - `sheet`: y 16, scale 0.99, plus fade.
  - `fade`: scrims.
  - `listItem`: opacity plus y 10.
  - `sidebarSlide`: fully off the leading edge and back, never a fade.
  - `press`: `whileTap` scale 0.97.
  - `slideIn` / `slideUnder`: push navigation inside the tray. The next page enters from x 24; the page under it recedes to x -24.
- Hooks:
  - `usePreset(preset)` and `usePress()` are reduced-motion aware. Under `prefers-reduced-motion` every preset becomes an opacity-only fast fade.
  - `useReducedMotion()` reports the setting.
- Colour fades use the `--duration-*` and `--ease-standard` tokens.
  - The global reduced-motion rule collapses all CSS animation.

## Menu morph (`packages/glass/src/morph`, numbers in `MORPH`, `motion.ts`)
Every menu grows out of its button as one piece of glass that changes shape, measured frame by frame from the iOS recording (`design/menu-morph-ref`), then 15 % faster with a small bounce at the owner's request. It is not a finished menu being scaled, and it is not a fade. `<GlassMorph source>` is the only implementation; both classes use the same parameters.

**Two classes, decided at open from the DOM (`morph/source.ts`).** A trigger morphs only if it has its own glass AND contains only an icon.
- **Separate:** the icon-only trigger is the only control in its own glass and fills at least half of it. That glass becomes the menu: it lifts and whitens, hands over by `--glass-fade`, and nothing is left behind while the menu is open. It returns on close, and so does the glyph.
- **Attached:** anything else, including a button with text in its own glass. The parent and the button do not change or move, apart from ordinary press feedback. The menu grows from a small blob at the button with the same timing, path and content.

| Trigger | Class | Why |
|---|---|---|
| Chat row "…" (`SidebarChats`) | attached | inside the sidebar glass, in a row |
| Composer + (`PlusTray`) | attached | inside the composer pill |
| `ScreenMenu`, the provider preset (`ProviderEditor`) | attached | has text, and no glass of its own |
| Cascade `SubTrigger` | attached | a menu row |
| `GlassDropdown.Trigger` with text (Lab: `DropdownPositions`, `AppleNotesReplica`, `VirtualModelPicker`) | attached | has text |
| `GlassDropdown.Trigger` with only an icon (`MorphLab`) | separate | own glass, only an icon |
| Lab `asChild` in a shared capsule (`MorphLab`) | attached | shares glass with a neighbour |

Not menu triggers, so no morph: `ConsentPopover` (opened by the send path, no button; keeps `popIn`), the narrow sidebar panel (a slide), and the header's Settings, New chat and title buttons (they navigate). **In production today every menu trigger is attached;** the separate class is reachable only through an icon-only default `Trigger`, which the Lab uses.

**The motion, from the press:**
| ms | Shape | Content |
|---|---|---|
| 0-94 | Source lifts near-opaque with a wider shadow | Glyph leaves |
| 120-200 | Near-circle, growing away from the button; the edge beside it only ever moves toward its place | Copy arrives blurred and oversized, cut by the rim |
| 200-246 | Squares up, radius still larger than final; far edges overshoot about 3.5 % | Sharp rows take over, at full ink by 246 |
| 246-272 | Far edges return; on the final tint | Rows contract into place |

Close is the same path in reverse and faster. A menu opening up or left mirrors by itself, because the path runs from the source's box to the final box. A rim layer draws one crisp line, a constant 1 px on screen at any scale, through every frame and at rest, so the lens handover never loses the outline.

**Nested menus.** Submenus use the same engine. In-place: the panel glides to its new size in transforms (`MORPH.resize`), rows held at scale 1 and clipped by the glass, and the incoming rows wait `panelFadeDelay` so text never stacks. Cascade: grows from its row, beside the menu; the parent's scroll viewport is opened up so nothing clips it. Framer's shared-layout projection is gone from menus: it read layout mid-frame and scaled the rows.

**Why this technique.** The glass stays its rest size in layout: `transform` on the shell takes it from the source's box to the menu's, `border-radius` is written against that scale, and the content layer is counter-scaled. Layout never runs, and the real lens, sheen and shadow all follow the shape. A clip-revealed fixed panel would have needed a separate rim and shadow, and it would not read as one piece of glass.
- **Refraction:** one prebuilt round map (`transit.ts`, built at idle when the first glass mounts), stretched to each menu by its `feImage` rect. It sits under the real lens, which fades in over it as the glass gains its tint. No map or filter value changes per frame. It has no specular: the map's ring is an ellipse, and would draw a bright line across a squared-up panel.
- **Blur:** a static inert copy of the rows under a fixed filter (bend, blur, ink), crossfaded with the live rows and removed when it is gone. The blur radius never animates. A panel over `bendMaxSide` skips the bend, which would only scribble its rows. Frost tier: a fixed CSS blur, no bend, same motion.
- **Timeline:** starts at the press, not when the menu finished mounting, so a slow mount cannot read as lag.
- **Interruption:** the springs' position and velocity are the whole state (`stepSpring`), so any retarget reverses from where it is. Re-tap, Escape, outside click and fast toggling all use that.
- **Pointer:** until the glass has landed the shell takes no pointer, so the button under it keeps re-taps and a quick release selects nothing. A release outside the rest box still dismisses.
- **Stretch:** nothing stays inline at rest. The morph owns the shell's transform and the stretch owns the root's `scale` and `translate`, so they compose. `morph/registry.ts` gives the stretch the rest box while the glass moves.
- **Reduced motion:** a plain short fade through `--glass-fade`; no scale, no shape change, no copy.
- **Two clocks after the press** (WP-G4): `form` holds the circle and squares it up; `content` lands the rows. The rows are sharp, at full ink and at scale 1 (within 0.5 %) before the shape reaches 95 % of its size: measured 206–218 ms against 227–239 ms. The overshoot rides on `form`. *(WP-I1: no overshoot, and `form` runs on the shape's spring; see the WP-I1 section.)*
- **The corner never swaps at rest.** The morph lands on the rest radius from the first frame of the open: the token where `corner-shape` draws the curve, else the circle with the same apex. On an engine without `corner-shape`, the path comes back the moment the corner has squared, while the glass still moves; a panel resize uses the compensated circle until it lands.
- **Leaving is a tween** (`LEAVE`, `LEAVE_CONTENT`, 120 ms and 72 ms): an exit has nothing to reverse into, and a spring's tail kept the search palette's text on screen and hit-testable for 420 ms. The search palette is inert from the first frame of its close.

## Corners and rows
- **Squircle:** all glass cards and menus use `corner-shape: var(--glass-corner)`, `superellipse(1.46)` (exponent 2.75), measured from `IMG_7868`. Capsules stay round. No cost per frame. An engine without `corner-shape` gets the same curve as a clip path on the glass's layers, rebuilt only on resize, over the circle with the same apex (`squircle.ts`).
- **Radii:** `--radius-menu` 42 (the span of the measured curve, which has the apex of a 32 px circle), `--radius-panel` 36, `--radius-composer` 44. `--glass-radius` defaults to the menu's. Maps use the round equivalent.
- **Rows:** `--menu-row` 40, `--menu-pad` 10, `--menu-row-inset` 16; hover and selection are full pills, in menus and sidebar rows, and instant: nothing glides between rows. Drag-select still scrubs.
- **Width:** `--menu-max-width` 280 for every menu, whatever its `minWidth`. Long labels truncate.
- **Dividers:** `--color-divider` at `--divider-scale` of a pixel, inset by the row inset.
- **Trailing icons** (selection check, pin star, chevrons, in menus and lists): one visual weight. Outline lucide glyphs at 16 px and the 1.75 stroke; state is colour (ink when on, ink-3 or hidden when off), never a fill. A filled star next to a thin check reads as two weights (`owner-check-star.png`). `design-system.test.ts` holds this.
- **Labels:** 11 px text is ink-2, never ink-3 (a test holds this); ink-3 on paper does not meet AA at that size.

## Performance budget (WP-G2, measured 2026-11-07)
`node apps/web/scripts/g2-perf.mjs`: `COLD=n` for fresh-session first opens, `UNCAPPED=1` for headroom, `NO_LAB=1` against a production build. The Lab exists only in dev. Results are in `~/.praxis-agent-state/cloud/design/G2/perf-*.json`. `g2-trace.mjs` prints a morph's numbers per frame, and `g2-compare.mjs` and `g2-capture.mjs` build the boards, strips and videos. The screencast's own timestamps lag by hundreds of ms, so each captured frame carries its true time as a barcode.

## Shell (`apps/web/src/components`)
- **Layout.** The chat layer is full-bleed (`ChatScreen` transparent over `--paper-gradient`), so scrolling messages pass behind the floating sidebar, top bar and composer; the gradient gives the blur something real to sample at any width. The message column stays centred in the full width, max 720 px. The settings page clears the floating sidebar on desktop (`data-sidebar` padding).
- **Breakpoint:** desktop ≥ 1024 px; the narrow layout is designed at 402 px. Breakpoint visibility is CSS only (`.narrow` / `.desktop`).
- **Sidebar** (`shell/Sidebar`, floating in every state):
  - Fixed, 12 px from the left, 18 px from the top, 24 px from the bottom, 232 px wide. An opaque slab ported from the owner's `sidebar-design.html` (WP-G5 below), not glass. Not docked: no layout space is reserved.
  - Desktop: full-height sheet (260 px wide). Narrow (<1024 px): the same content as a floating panel (≤320 px wide, ≤480 px tall), portaled to the document root; Escape or an outside click closes it and returns focus to the History button; choosing a chat, New chat or Account also closes it.
  - Compact top bar with the collapse button on the right (no `Praxis` wordmark in chats; in settings, a compact `Back` control on the left and the collapse button on the right, with no `Settings` title header).
  - "New chat" and "Search" (⌘K opens the floating Spotlight search) as 36 px ghost rows inset 12 px (`--space-3`, `--glide-inset: var(--space-3)`) with 8 px (`--space-2`) internal horizontal padding, 18 px icons, 8 px (`--space-2`) icon-to-label gap, and regular 14/20 weight aligned with the chat rows below.
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
- **Activity** (ported from `t3code` `TurnFoldTimelineRow` / `orchestrationTiming.ts` + iOS `AgentActivity.swift` parity, no badges):
  - One plain disclosure row: 14 px chevron on the left, then muted 12 px medium `tabular-nums` text. No pill, background, border, dot or shadow.
  - Exact elapsed-time formatting (`formatDuration`): sub-second as `ms` (`min 1ms`, never `Worked for 0s`), `<10s` with one decimal (`1.2s`, `3s`), `<60s` as integer seconds (`14s`), and `>=60s` as `Xh Ym Zs`.
  - "Currently working…" (shimmer + live `WorkingTimer`, with the running step as a muted second line), "Waiting for tool approval (N)", "Waiting for your input", "Worked for <duration>", "Stopped after <duration>", "(N failed)".
  - Preserves scroll anchor on toggle (`data-scroll-anchor-ignore`) while FLIP-gliding following siblings; auto-opens fold when a running turn is cancelled/interrupted.
  - Level 2: one line per call (icon, mono name, muted summary). Level 3: input/progress/output in a hairline mono detail. Approvals and questions always show under the header, even folded.
- **Approvals and questions** (`ApprovalCards`, `ElicitationCards`): compact `--radius-lg` cards on `--color-surface` with a hairline border; 36 px action buttons; mono args in `--color-fill-1`.
- **Composer** (`chat/Composer`, `chat/ComposerBar`):
  - A glass `regular` pill (`--radius-composer`, padding 8) floating from the bottom.
  - Controls: `+` / auto-growing textarea (14/20 on desktop, 16 on touch, max 200 px; measured once per change) / trailing 36 px slot (`mic` when empty, swapping in place with scale/opacity to `send` as soon as the user types or attaches a file, or `stop` while a run is active). There is no separate camera button in the bar (photo/camera/files remain in `PlusTray`).
  - Secondary controls (`+`, `mic`) use a semi-transparent ink fill (`color-mix(in srgb, var(--color-ink) 10%, transparent)`); primary action (`send`, `stop`) remains solid `--color-accent`.
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

## D3 completion pass (2026-11-07)
Tool disclosures use human presentation titles (or a readable fallback) and a separately truncated argument summary; rehydrated `local_echo` never repeats its raw name. All tool headers use the 36 px control height, expose expansion state, and keep input/progress/output in scrollable mono details. Approval and question cards use a quiet paper fill, hairline, no elevation, and 36 px primary/secondary actions. Errors read “Couldn't finish: …” in secondary ink.
Markdown inline references use CSS Modules and wrap long paths/URLs; links retain protocol filtering and all text remains React-escaped. Tables preserve escaped pipes and column alignment; ordered lists retain their starting number and headings use semantic elements.
Sign-in is a centred serif Praxis wordmark and credential form in one 360 px column (the phone layout fits 402 × 874 without scrolling), with the server under Advanced. Every button is the Radix Themes classic pill; hierarchy comes from colour only. The primary (Sign in, Create account, Verify and continue) is classic high contrast in our ink: near-black in light, near-white in dark. Google and Apple follow an "or" divider as light-neutral classic pills with the official 16 px logos and the brand labels "Continue with Google" / "Continue with Apple". Forgot password (on the Password label row), Sign in with an email code (under the primary) and the No account? Create one / Already have an account? Sign in footer are links, not buttons. While a request is in flight only the pressed button shows a spinner (rendered by us, so the accessible name is not doubled); the others are disabled at 60 % opacity in their own colours. The local-user action remains both dev-build and local-server gated, and sits compact below a dashed hairline labelled Dev only (test id `local-dev-sign-in`). Authenticated UI, Settings, and history navigation are lazy chunks; Lab remains dev-only and lazy. The entry chunk is below 450 kB raw; total authenticated downloads remain larger (see D3 gate report).
Lab is a real-component gallery: three materials on a patterned backdrop, positioning anchors, nested menu motion, a virtualized 500-model picker and progressive blur. The old Notes replica, political prose and redundant picker summary are removed. `/lab/glass?morph` and the wide-label fixture remain. Browser geometry tests wait for the lazy gallery and fonts before measuring.
The transit map warm-up now runs on the first GlassSurface mount, rather than waiting for GlassMorph to mount on the first menu open. It remains idle-scheduled and idempotent; no menu motion parameters changed.
Timing specs wait for web fonts before pixel geometry sampling. Tray samples start at pointerdown, not before Playwright's actionability wait; sidebar reversal happens in the measured frame, not after a protocol round trip. Width caps, intermediate-frame counts, velocities and pixel tolerances are unchanged.
Profiling the cold open identified synchronous PNG encoding (`toDataURL`) as the remaining stall. Runtime lens and transit maps now use asynchronous `toBlob` encoding, sharing the same pixel math, cache and decode-before-install rule; concurrent requests for a geometry deduplicate, and stale resize completions cannot replace the latest geometry. The sync generator remains available to existing tests. D1's stretch probe now reads computed individual scale, checks non-identity scale, and drags past menu edges, matching the current stretch API rather than the removed translate-string representation.

## G4B: dark sidebar and personal accent (2026-11-07)
`design/G4/B/design-dom.json` records `getComputedStyle` from the owner's bundled `sidebar-design.html`, rendered at 1440×900. Measured geometry is now sidebar-specific tokens: 214 px outer width, 18 px top / 24 px bottom / 12 px left, 29 px corner, 34 px white primary pill and collapse control, 31 px chat rows, 13 px text, 10 px captions, 15/16 px glyphs and the 28 px footer avatar. These are explicit reference exceptions to the general type/control/icon scale; the app keeps its Inter face. Header content starts at x25/y31: 12 px inset, 8 px gap and a 146 px New chat pill. Back uses the same `SidebarHeader` pill in exactly that position. Floating overlay, stretch and narrow-screen close/focus behavior are retained.
Both themes use the reference's near-black sidebar, white content, muted `#b5b4b0`, 12% white selected pill and footer rule, and its two vertical sheen gradients. This is still the real thick GlassSurface, with a 94% dark tint, lens/frost, rim and stretch, rather than an opaque background. Light mode compensates for the paper showing through the tint (`rgba(7,9,12,.94)`); dark mode uses `rgba(22,24,27,.94)`. Sidebar-local ink/fill tokens do not leak into portaled menus. New chat and Back deliberately remain white for every accent, preserving the owner's design.
General → Appearance offers Neutral, Blue, Violet, Rose, Amber and Green, with keyboard radio navigation. `praxis-accent` follows theme's device-local persistence. The synchronous head bootstrap validates and applies `data-accent` before React or first control paint; CSS resolves theme-specific accent/on-colours. On-colours are computed by WCAG luminance against paper/ink, taking the higher contrast; tests verify AA ≥4.5 for every pair and accent links in both themes. Accent feeds existing primary/send/toggle tokens, focus rings, Markdown/authorization links and portaled selection checks. The one global selection-check selector uses lucide's public class and ARIA roles; no menu motion or model trailing-icon implementation was changed.
Pinned rows reserve one trailing slot: pin at rest, actions on hover/focus/menu-open, with no opacity crossfade and matching centres. Empty-object approval arguments are omitted; question fields prefer schema title, then description, then a humanised key.

## G5: the owner's sidebar, sidebar palettes, the composer's second rim (2026-11-08)
**Source of truth:** `design/G4-ref/sidebar-design-source.html`: the `<aside>` and `PAL`, `grad()`, `BP`, `renderVals()`. It replaces the G4B section above for the sidebar surface and the accent.
- **Surface.** `GlassSurface lens={false}`: the stretch, press and float shadow stay, but there is no lens, backdrop, frost or spotlight. One solid layer (`[data-glass-solid]`) paints the gloss twice, exactly as the source's `<aside>` does (its literal gradient, then `sbBg` = `grad(base)`, which carries it again): +20 % white at 0, 12 % at 2 %, 6 % at 5 %, 2 % at 9 %, clear at 14 %, 12 % black at 100 %) over the palette base, a 1 px palette border and `inset 0 1px 2px rgb(255 255 255/30%)`, at 29 px `corner-shape: squircle` (the clip-path squircle where unsupported). Same in light and dark; only the palette changes it.
- **Metrics (the source's):** padding 12/8/0 inside the border; header row inset 4, gap 8; New chat pill 34 high, 13/500, padding 0 14, 15 px glyph at 1.9 stroke; collapse 34 square, radius 10 squircle, `--sb-mute`, hover `--sb-hl`; Search row 8 px padding, 10 gap, 16 px glyph, radius 10, 10 px below the header; captions 10 px `--sb-mute`, padding 16/8/6; chat rows full pills, 8×14, 13 px, active `rgba(255,255,255,.12)`, hover `--sb-hl`; footer `--sb-line` rule, padding 12/6/14, 28 px avatar on `--sb-hl`, 12/10 px name and Settings, gear `--sb-mute`. Width 232 px outer (the source's box is 214: 196 content + 16 padding + 2 border). The app keeps Inter; the source renders Roboto.
- **Settings → General:** Sidebar palette (Graphite, Midnight, Forest, Plum dark; Sand, Paper light) as 28 px ringed swatches, live. (The Button color option was removed in WP-I1; New chat and Back are always the white pill.) `praxis-sidebar-palette` and `praxis-button-color` are applied in the `index.html` head script before first paint as `--sb-*` and `--nb-*` on `<html>`; `lib/sidebarPalette.ts` is the same logic and its test runs the head script against it.
- **Two deliberate deviations, both for AA:** the light-palette mute is `#454440` (under the doubled gloss the lower list and footer sit under ~22 % black, where the source's `#5c5b57` is 3.2:1 on Sand; a "Yesterday" caption can land there), and the button ink is whichever of the source's two inks (`#10242d`, `#fff`) contrasts more, which differs from the source's 0.35 switch only for mid tones such as Gray.
- **No generic accent.** `data-accent`, the six accent palettes and AccentControl are gone; links, check marks, focus and primary buttons are back on `--color-accent` = ink, as before G4B.
- **Lens maps trace the painted corner.** A map's ring is built from the radius *after* CSS clamps it to the box and on the corner's own superellipse (`--glass-corner`, exponent 2^K), not the "circle with the same apex" of the unclamped token. The composer (`--radius-composer` 44 on a 52 px pill) paints a 26 px squircle; its map was a 26 px circle, which left a neutral band at each corner's apex and then the full-strength bezel and specular rim inside it: the second rim at the pill's ends in Chromium. Circles (capsules) are unchanged bit for bit; the cache key includes the exponent.


## H3: the owner's design v2, semantic search (2026-11-08)
**Source of truth:** `design/G6-ref/zip/Chat Screen.dc.html` (template plus `Component`: `PAL`, `ACC`, `grad()`, `ringBg`, `M`, `randomName()`). It replaces G5 where they differ.
- **Sidebar fill.** The solid layer paints the aside's literal gloss over v2's `grad(base)`: the same top sheen (clear at the bottom) over the base, solid to 45 % and `color-mix(base 40%, transparent)` at 100 %, with `backdrop-filter: blur(14px)` (`--glass-solid-backdrop`). The bottom therefore takes on the page: a dark palette fades toward grey in the light app, a light one toward charcoal in the dark app, as in the owner's long-list crop. The list has `padding-bottom: 12px`; rows never shrink.
- **Border reflection.** The border is `1px solid transparent` with the fill clipped to the padding box; over it a 1 px ring (`[data-sidebar-ring]`) paints v2's conic `ringBg` from 45° in the palette's `ACC` (Graphite `#8ea0b3`, Midnight `#4b7fd6`, Forest `#44a877`, Plum `#a866d4`, Sand `#d9c79a`, Paper `#d6d6e0`), masked to the ring. `borderAngle` 45 and `glowStrength` 100 are the source's defaults; they are not settings. The corner is a plain 29 px radius (v2 drops `corner-shape: squircle`).
- **Contrast.** Same polarity (dark palette in the dark app, light in light): AA top to bottom. Opposite polarity: AA down to 60 % of the height; below, the owner's fade takes the footer to about 3:1 for ink and about 1.7:1 for the mute at the very bottom (the HTML's own values; `sidebarPalette.test.ts` pins them). The light mute stays `#454440` (G5's deviation).
- ~~Main area (`M`)~~ **Withdrawn in WP-I1:** the owner's v2 was for the sidebar only; the main area is back on its own palette and components (see WP-I1 below).
- ~~Header, bubble, composer~~ **Withdrawn in WP-I1:** the owner's v2 was for the sidebar only; the main area is back on its own palette and components (see WP-I1 below).
- **New chats** get a random two-word name from the source's `A` and `N` lists (`lib/chatNames.ts`), shown in the header while the chat is a draft and sent when the first message creates it; the name is never one of the user's existing chat titles (`uniqueChatName`: up to 24 random draws, then a number, e.g. "Quiet Harbor 2"; re-checked when chats arrive and at creation); sending keeps it (the server only titles chats named "New chat", which the web no longer sends). Rename still works.
- **Search.** Hybrid: the lexical rule (every query word in the title or one message) fused with cosine similarity over titles and sentence-packed message chunks (`apps/api/src/search.ts`, `search-index.ts`, `embedding.ts`). Items are content-addressed, so only new text is embedded; writes reindex their chat after a debounce, and a search reconciles what is missing for up to 60 ms (the backfill) and continues in the background. Dev: all-MiniLM-L6-v2 (q8, transformers.js, no key) and in-memory vectors; offline without the cached model, a hashing embedder. Production: the Convex `embeddings` table and vector index, off unless `PRAXIS_EMBEDDER` is set. Highlights skip common words and match at word starts.
- **Search recall (H3b).** Besides titles and chunks, each message (user and assistant alike) contributes overlapping four-word phrase windows of its opening (stride 2, at most 48 per chat): MiniLM scores a short query far better against a phrase ("debug code error" meets "script crashes with KeyError" at 0.40, the whole message at 0.26). Title hits count ×0.8, since random names mean nothing. A semantic-only chat needs the embedder's floor (MiniLM 0.27, calibrated on the H3b probe: real matches 0.30–0.76, noise ≤ 0.20) and half the best hit's score, a relative cut-off instead of the old fixed band; at most 8 semantic-only chats are shown, lexical matches are not capped. `semantic-search.test.ts` runs the probe's six queries on the real model when it is cached (skipped otherwise); p95 at 2,000 chats with MiniLM is 75 ms. The results list keeps an 8 px inset below the last option.

## WP-I1: main area reverted, pills, search, modes, question card, morph landing (2026-11-09)
- **Main area.** Page, header title pill, top-right cluster, user bubble, assistant ink, message action icons and the composer with its round buttons are back to their pre-H3 design (2f19672): tokens `--color-paper/ink/bubble/hover`, `--paper-gradient` and the glass palette as before H3; the v2 `M` tokens (`--color-btn/line/pill/icon`, `--bubble-*`) are gone. H3's sidebar, random chat names and search stay; H2's response typography (16/26, 70ch) stays. Pixel compare outside the sidebar against 2f19672 differs only in the assistant text (H2) and the composer placeholder (`i1-compare.py`).
- **Pills.** The sidebar Search row and the Settings nav rows are full pills (999 px), like the chat rows and New chat; the Delete-account buttons are pills like every other Settings button.
- **No button colour.** The option, its setting, the index.html bootstrap and the account-sync field are gone. `praxis-button-color` is never read and is cleared at startup; a synced `button` row is ignored by the client, and the API accepts `button` from older clients without storing it and never serves stored rows (`sync-routes.ts`). `--nb-*` come from tokens.css only (white).
- **Search.** With no input the panel is just the bar (`.results:empty` has no inset). Choosing a chat closes at once and loads the messages behind it (the palette used to wait for `listMessages`, about a second). The panel wears the dropdowns' `--glass-menu-tint` and their rim (`--glass-morph-rim` 1 px and `--glass-morph-rim-light` 2 px, inset).
- **Modes.** Auto, Ask, Execute (`lib/modes.ts`). The protocol enum is unchanged: Execute is sent as `build`; a stored or synced `plan` (chat mode or default) reads as Auto; `build` reads as Execute. The server still accepts `plan` and `build`.
- **Question card** (`ElicitationCards.tsx` + `.module.css`). Flat in the activity column (no box), message at 14/500 ink, "Asked by" in ink-2. Fields: filled pill inputs (`--color-fill-1`, radius full, one line on focus instead of a ring), enum as pill chips (chosen one in ink), boolean as our Switch. Submit is the ink pill, Decline the outlined pill, Cancel a quiet text button (not red). Validation on Submit (required, number/integer, min/max, length, email, uri) with errors under the field. URL mode: "Open host" primary pill, then Done/Decline/Cancel. Once answered the card becomes one line in the activity header type: ✓ Submitted with the values, or Declined/Cancelled.
- **Morph landing.** The tray "shifted diagonally at the end": the glass decelerated near its rest size but still circle-pulled (387×387 for a 360×390 tray), then the slow `form` clock squared it up and the overshoot returned: a second move of up to 26 px, with the rows (centred on the glass) riding it ~11 px. Now the shape and form springs are the same critically damped spring (2900/108), the overshoot target is 0, resize is critical (900/60), and the rows are pinned to their rest layout as they land (`MORPH.open.pinFrom`, `engine.ts` `pinShift`). Spec: `morph.pw.ts` "no move at the end" (every menu kind and the tray with its model list): after the glass reaches 90 % of its size no edge moves back away from rest by more than 0.5 px and the rows never move more than 0.5 px once landed. Probe: `scripts/i1-tray-probe.mjs`.
- **Reduced motion.** `resolvePreset` keeps each preset's own opacity per state; the inverted `slideUnder` had become a 0 → 1 fade, leaving the + tray's main view invisible for reduced-motion users.

