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
4. **Glass is for floating chrome only.** That means the composer pill, the top-bar clusters, menus, popovers and sheets.
   Content (messages, activity rows, cards, chips on the canvas) is never glass.
5. **Motion goes through `@praxis/glass` presets**, and only `transform` and `opacity` animate.
   No ad-hoc durations. `design-system.test.ts` fails the build if you add one.
6. **Icons:** lucide only, imported from `lib/icons.ts`. Each is bound through `<Icon>`, so sizes are 16/18/20 and the stroke is 1.75.

## Tokens (`tokens.css`, light and dark under `[data-theme]`)
| Group | Tokens |
|---|---|
| Space (4 px) | `--space-1..16` = 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 |
| Type | `--text-xs/sm/md/lg/xl/2xl` = 12/13/15/17/20/28 with `--leading-*` 16/18/22/28/28/34 |
| Faces | `--font-sans` Inter (all UI and body), `--font-display` Source Serif 4 (greeting, headings, wordmark), `--font-mono` IBM Plex Mono (code only) |
| Weights | 400 / 500 / 600 only. `--tracking-tight` for titles, `--tracking-display` for serif |
| Controls | `--control-sm` 28 (row actions, chips in dense UI), `--control-md` 36 (default), `--control-lg` 44 (touch, account row) |
| Radii | `--radius-sm` 8 (rows, small buttons), `md` 12 (cards, code), `lg` 16 (menus, tiles), `xl` 20 (bubbles), `2xl` 28 (composer, tray), `full` |
| Icons | `--icon-sm/md/lg` 16/18/20 with `--icon-stroke` 1.75 (`ICON_STROKE` in TS) |
| Layout | `--sidebar-width` 260, `--column-width` 720, `--topbar-height` 56 |
| Colour | `--color-paper` canvas, `--color-sidebar`, `--color-surface` card, `--color-fill-1/2`, `--color-bubble` (user bubble), `--color-ink`, `--color-ink-2` secondary, `--color-ink-3` tertiary, `--color-hairline` (and `-strong`), `--color-hover`, `--color-pressed`, `--color-accent` (black in light, paper in dark) with `--color-on-accent`, `--color-danger`, `--color-success`, `--color-focus`, `--color-scrim` |
| Elevation | `--shadow-1` (chips, inspector), `--shadow-2` (regular glass), `--shadow-3` (menus, sheets). No other shadows |
| Motion | `--duration-fast` 120, `--duration-base` 200, `--duration-slow` 320 ms, `--ease-standard` `cubic-bezier(.2,0,0,1)`; `--duration-ambient` and `--ease-ambient` are only for status loops |

Paper, ink, fill, success and danger hex values equal iOS `Tokens.swift` in both themes; a test enforces this.
Two values deviate on purpose:
- The web hairline is translucent ink (8%/14%), so it reads the same on paper, sidebar and glass.
- The pressed and tile colours are aliased.

Legacy `--paper-*` names alias to `--color-*` so the D2/D3 screens keep rendering. New code must not use them.

## Glass (`packages/glass`)
`<GlassSurface material="regular|thick|clear" shape="card|capsule" radius?>` renders a single `motion.div` styled by `glass.module.css`:
- `backdrop-filter: blur(var) saturate(var)` over a tint
- a 1 px specular rim: a gradient border cut out with `mask-composite`
- an inset top highlight, a 0.5 px edge, and an elevation shadow

| Recipe | Use | Light tint / blur | Dark tint |
|---|---|---|---|
| `regular` | composer pill, top-bar clusters | paper 72% / 20 px | `rgba(28,28,26,.68)` |
| `thick` | menus, popovers, sheets, tray | paper 90% / 32 px (AA for danger text over black) | `rgba(26,26,24,.86)` |
| `clear` | small floating chips (jump to latest) | white 42% / 12 px | `rgba(40,40,37,.44)` |

What the glass layer does not do:
- It never measures, re-captures the DOM, uses canvas/WebGL, or runs `requestAnimationFrame`. The old DOM-repaint WebGL engine, the displacement maps and the engine toggles are deleted.
- The browser composites the blur on the GPU.

Other behaviour:
- `prefers-reduced-transparency` falls back to an opaque `--glass-fallback`.
- To fade glass in, put `opacity` on the `GlassSurface` itself. Put scale on a parent: `transform` is fine there, but `opacity` or `filter` on an ancestor breaks backdrop sampling.
- Never put a CSS `filter` (for example a hover brightness) on an ancestor of glass.
- `ProgressiveBlurScrim edge="top|bottom"`: 4 static, masked backdrop-blur bands (1/3/6/12 px) plus a paper feather. Used under the top bar (72 px) and above the composer (112 px).
- `ScrollBlur` (menus, lists): a mask fade driven by `animation-timeline: scroll()`. It appears only at the scrolled edges and has zero JS.

## Motion (`packages/glass/src/motion.ts`, the only TS source)
- `SPRING` = stiffness 520, damping 38 (damping ratio ≈ 0.83). It is the single spring; `SPRING_VALUE` is the same spring for `useSpring`.
- `TRANSITION.fast/base/slow` = tweens on `EASE_STANDARD`. `STAGGER` is 30 ms between rows.
- Presets:
  - `popIn`: menus and popovers. Opacity plus scale 0.96 from the anchor's `transform-origin`.
  - `sheet`: y 16, scale 0.99, plus fade.
  - `fade`: scrims.
  - `listItem`: opacity plus y 6.
  - `press`: `whileTap` scale 0.97.
- Hooks:
  - `usePreset(preset)` and `usePress()` are reduced-motion aware. Under `prefers-reduced-motion` every preset becomes an opacity-only fast fade.
  - `useReducedMotion()` reports the setting.
- CSS equivalents use the `--duration-*` and `--ease-standard` tokens.
  - Message enter (`UserBubble`) is a CSS keyframe equivalent to `listItem`.
  - The global reduced-motion rule collapses all CSS animation.

## Shell (`apps/web/src/components`)
- **Breakpoint:** desktop ≥ 1024 px; the narrow layout is designed at 402 px. Breakpoint visibility is CSS only (`.narrow` / `.desktop`).
- **Sidebar** (`shell/Sidebar`, desktop only):
  - 260 px on `--color-sidebar` with a hairline right border.
  - Wordmark in serif 20 with a collapse button.
  - "New chat" and an inline "Search" (⌘K focuses it) as 36 px ghost rows.
  - Chats grouped by date (`lib/chatGroups.ts`) as 36 px single-line rows; the hover "…" (28 px) opens a glass menu.
  - The account/settings row sits at the bottom.
- **Top bar** (`chat/ChatHeader`):
  - 56 px, transparent over the progressive scrim.
  - Centered title (15/600) and model (12, ink-3). Tapping it opens Settings.
  - Glass `regular` capsule clusters of 36 px buttons:
    - narrow: History on the left, New chat on the right
    - desktop: sidebar toggle and New chat on the left (only while the sidebar is collapsed), Settings on the right
  - There is no Lab button. Lab lives at `/lab` and in Settings → Developer, both dev-only.
- **Empty state:** serif 28/34 greeting, 15 ink-2 lede, and 36 px hairline suggestion pills, vertically centred.
- **Message column:**
  - max 720 px wide.
  - Assistant text is 17/28 Inter. Headings are serif 28/20/17. Code and tables sit in `--radius-md` hairline cards.
  - User bubble: `--color-bubble`, radius 20, 15/22, max 78% wide.
  - Turn rhythm: 32 px before a user turn, 16 px after it, and 20 px from an activity row to its answer.
  - Actions under the answer: 28 px ghost icon buttons (16 px icons, ink-3).
- **Composer** (`chat/Composer`, `chat/ComposerBar`):
  - A glass `regular` pill (radius 28, padding 8) floating 20 px from the bottom.
  - Controls: + / auto-growing textarea (15/22, max 200 px; measured once per change) / camera / mic / send-or-stop.
  - Every control is a 36 px accent circle, as on iOS.

## Performance budget (measured 2026-11-01)
Setup: Chromium, production build (`vite build` plus `vite preview` proxied to the local API), 1440×900.
Command: `node apps/web/scripts/d1-perf.mjs`. It writes `perf.json` next to the D1 screenshots.

| Budget | Result |
|---|---|
| No long task > 50 ms while scrolling a 200+ message chat | 220-message chat, 0 long tasks; scripted scroll frames p50 16.7 ms, p95 16.8–17.7 ms. The UI renders the latest 100 messages (existing `listMessages` limit) |
| No long task > 50 ms when opening a menu | 5 opens, 0 long tasks |
| No per-frame JS while idle | 0 rAF callbacks, 0 ms script, 0 layouts in 2 s; 0 canvases |
| Lighthouse performance ≥ 90 (built app, authenticated `/`) | 96, 95 and 91 on three runs (FCP 2.0 s, LCP 2.6–3.2 s, TBT 0 ms, CLS 0.002) |

Google Fonts load non-blocking (`preload` + swap) with weights trimmed to the scale. That change took Lighthouse from 77 to 95.
The JS bundle is 713 kB (216 kB gzip); code-splitting the sheets is the next win.

## Visual gate
`node apps/web/scripts/d1-capture.mjs` (API on 8821, web on 5195) writes to `~/.praxis-agent-state/cloud/design/D1/`:
- states: empty, chat (bottom and top), tray, settings sheet, and a sidebar menu
- sizes 1440×900 and 402×874, in light and dark
- `compare-*.png` boards next to the iOS references

## Left for D2 / D3
- **D2:** tray contents, model picker, dropdown internals and settings screens. They currently use legacy classes in `theme.css` and `screens.css`.
- **D3:** activity and tool rows, approvals, elicitation, the history sheet, sign-in and Lab.
- Both: convert to CSS Modules and these tokens, and delete the legacy `--paper-*` aliases when nothing reads them.
