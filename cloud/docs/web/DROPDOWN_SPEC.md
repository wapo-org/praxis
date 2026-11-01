# Improved Liquid Glass Dropdown Specification (`DROPDOWN_SPEC.md`)

> **Owner**: Lead B (`cloud/packages/glass`, `cloud/apps/web`, `cloud/docs/web`)
> **Milestone**: M0 (Spec-First Contract)
> **Sources**:
> 1. All 35 frame-by-frame reference screenshots in `/Users/artemchmylenko/Downloads/dwfef/IMG_7744.PNG` through `IMG_7778.PNG` (24.02-second high-frame-rate capture of native iOS 18 / 26 Liquid Glass pull-down `UIMenu` in Apple Notes, 1290×2796).
> 2. Legacy implementation in `/Users/artemchmylenko/development/wapo.dp/src/components/ds/GlassDropdown/GlassDropdown.tsx` and `/Users/artemchmylenko/development/wapo.dp/src/components/ui/dropdown-menu.tsx`.

---

## 1. Frame-by-Frame Analysis of All 35 Screenshots (`~/Downloads/dwfef/IMG_7744.PNG` – `IMG_7778.PNG`)

All 35 images (`1290×2796`) are consecutive frames from a 24.02s recording showing a native iOS Liquid Glass pull-down menu anchored to the top-right `•••` (More) button of an Apple Notes document. The menu contains:
- **Top Quick-Action Tile Row** (3 horizontal icon-above-label tiles): `Scan`, `Pin Note`, `Lock`.
- **Primary Action List**:
  - `Find in Note` (magnifying glass icon)
  - `Move Note` (folder icon)
  - `Recent Notes` (`clock`/`note.text` icon + trailing chevron `›` — **expandable inline submenu**)
  - `Math Results` (one two-line row: `Suggest Results` subtitle + trailing `›` submenu; no separate Suggest Results checkbox row)
  - `Lines & Grids` (grid icon)
  - `Attachment View` (`rectangle.grid.2x2` icon + trailing `›` submenu)
- **Destructive Footer Section**:
  - `Delete` (trash icon, system red)

### 1.1 Complete 35-Frame Timeline & Measurements

| Frame | Video Time | Card Pixel Bounds (`x`, `y`, `w×h` in 1290×2796) | Visual State & Physical Motion Observed |
| :--- | :--- | :--- | :--- |
| **`IMG_7744.PNG`** | `00:00.60` | None (`0×0`) | **Baseline (Closed)**: Note transcript visible (`"protests through history is primarily brutal and..."`). Top-right toolbar shows Share and `•••` circle trigger button (`x: 75%, y: 19%`). No menu present. |
| **`IMG_7745.PNG`** | `00:01.29` | `x: 520..1030 (w: 510)`, `y: 538..1324 (h: 786)` | **Trigger Press & Initial Budding (`~15%` open)**: The `•••` trigger button morphs/scales into the top-right corner of a budding glass droplet. Strong radial lens refraction bends the underlying note text (`"equences"`, `"group for law"`). Menu labels are still at ~0–10% opacity inside the expanding glass blob. |
| **`IMG_7746.PNG`** | `00:01.32` | `x: 520..1030 (w: 510)`, `y: 616..1306 (h: 690)` | **Rapid Unfurl (`+30ms`)**: The glass lens stretches diagonally downward-left from `transform-origin: top right`. Underlying text (`"equences"`, `"e's no"`, `"group for law"`) is visibly magnified and displaced outward along the squircle bezel rim. |
| **`IMG_7747.PNG`** | `00:01.34` | `x: 520..1030 (w: 510)`, `y: 580..1390 (h: 810)` | **Mid-Expansion (`+50ms`)**: Card height reaches `810px` (`~85%` of rest height). Progressive blur deepens inside the core while the outer `20px` bezel refracts the right-hand words of the note (`"er"`). Content rows begin fading in with upward velocity. |
| **`IMG_7748.PNG`** | `00:01.39` | `x: 520..1030 (w: 510)`, `y: 526..1438 (h: 912)` | **Content Reveal (`+100ms`)**: Card reaches `912px` height (`~96%`). List labels (`Find in Note`, `Move Note`, `Recent Notes`, `Math Results`, `Lines & Grids`, `Attachment View`) become legible at ~75% opacity; top tile row (`Scan`, `Pin Note`, `Lock`) is still expanding near the top anchor. |
| **`IMG_7749.PNG`** | `00:01.44` | `x: 520..1030 (w: 510)`, `y: 496..1450 (h: 954)` | **Spring Overshoot Peak 1 (`+150ms`)**: Card height overshoots rest height (`948px`) to `954px` (`y: 496..1450`, `~1.015x` vertical scale). All 3 top tiles (`Scan`, `Pin Note`, `Lock`) and all action rows including `Delete` are crisp. |
| **`IMG_7750.PNG`** | `00:01.46` | `x: 520..1030 (w: 510)`, `y: 490..1444 (h: 954)` | **Apex of Underdamped Pop (`+170ms`)**: Top edge settles at `y: 490`, bottom at `1444` (`h: 954`). Specular top-left & bottom-right bezel highlights reach full intensity (`1px` lit rim + `20px` Snell refraction). |
| **`IMG_7751.PNG`** | `00:01.56` | `x: 520..1030 (w: 510)`, `y: 490..1438 (h: 948)` | **Spring Rebound (`+270ms`)**: Card rebounds from `954px` back toward rest height (`948px`). Icons, labels, and trailing submenu chevrons (`›`) are locked to pixel grid. |
| **`IMG_7752.PNG`** | `00:01.87` | `x: 520..1030 (w: 510)`, `y: 490..1438 (h: 948)` | **Fully Settled Rest State**: The raw-image bounds are shown at left; the approximately 235 pt native width maps to a 240 CSS-px card after reference scaling. Unfilled top tiles have no vertical dividers; one inset horizontal hairline sits below the grid. There is no section channel above Delete. Math Results has Suggest Results as its subtitle. |
| **`IMG_7753.PNG`** | `00:06.86` | `x: 520..1030 (w: 510)`, `y: 496..1390 (h: 894)` | **Pre-Touch Idle**: Menu steady over note background; specular rim and progressive frost keep background text completely diffused behind labels while preserving warm luminance variations. |
| **`IMG_7754.PNG`** | `00:06.90` | `x: 520..1030 (w: 510)`, `y: 496..1390 (h: 894)` | **Touch Contact Initiation (`t=6.90s`)**: User's finger makes contact near `Find in Note` / `Move Note`. Menu container begins subtle press-hold response. |
| **`IMG_7755.PNG`** | `00:06.95` | `x: 520..1030 (w: 510)`, `y: 496..1390 (h: 894)` | **Scrub Highlight Acquisition (`+50ms`)**: Full-bleed translucent highlight band (`rgba(255,255,255,0.12)` in dark mode) fades in across the active row without any margin gap. |
| **`IMG_7756.PNG`** | `00:07.12` | `x: 520..1030 (w: 510)`, `y: 490..1378 (h: 888)` | **Scrubbing Across `Move Note`**: Finger drags onto `Move Note` (`y: 29%`). The highlight slab glides continuously with the finger; the card compresses slightly (`h: 888`) under upward touch pressure. |
| **`IMG_7757.PNG`** | `00:07.21` | `x: 520..1030 (w: 510)`, `y: 490..1378 (h: 888)` | **Scrub Transition `Move Note` → `Recent Notes`**: Finger crosses the row boundary between `Move Note` and `Recent Notes`. Both rows show partial pressure transition as the fluid highlight pill tracks the pointer. |
| **`IMG_7758.PNG`** | `00:07.43` | `x: 520..1030 (w: 510)`, `y: 490..1426 (h: 936)` | **Scrubbing Downward Across `Recent Notes` & `Suggest Results`**: Finger drags downward; highlight tracks smoothly across `Recent Notes` (`y: 32%`) toward `Math Results` (`y: 35%`). |
| **`IMG_7759.PNG`** | `00:07.53` | `x: 520..1030 (w: 510)`, `y: 490..1486 (h: 996)` | **Elastic Downward Pull Stretch (`+48px`, `+5.1%` height)**: User drags past the lower items while holding; the entire Liquid Glass menu stretches elastically downward (`yMax: 1438 → 1486`, `h: 996px`) following an asymptotic rubber-band curve! |
| **`IMG_7760.PNG`** | `00:07.60` | `x: 520..1030 (w: 510)`, `y: 490..1486 (h: 996)` | **Sustained Elastic Pull**: Card holds at `h: 996px` while finger remains pulled downward; item spacing expands proportionally (`Math Results` (with `Suggest Results` subtitle), `Lines & Grids`, `Attachment View`, `Delete` shift down `1%–2%`). |
| **`IMG_7761.PNG`** | `00:07.98` | `x: 520..1030 (w: 510)`, `y: 490..1438 (h: 948)` | **Elastic Snap-Back to Neutral**: Finger releases downward pull tension; menu springs back to `y: 490..1438` (`h: 948px`) without closing. |
| **`IMG_7762.PNG`** | `00:09.45` | `x: 520..1030 (w: 510)`, `y: 490..1408 (h: 918)` | **Second Elastic Pull Sequence Begins**: User presses and drags downward again (`Scan` shifts `y: 21% → 22%`, `Attachment View` `y: 43% → 44%`). |
| **`IMG_7763.PNG`** | `00:10.12` | `x: 520..1030 (w: 510)`, `y: 526..1462 (h: 936)` | **Whole-Card Directional Translation (`Δy = +36px`)**: Dragging downward translates the top edge from `y: 490` to `y: 526` (`Scan` at `y: 23%`, `Delete` at `y: 49%`) while the glass bezel stretches toward the drag vector. |
| **`IMG_7764.PNG`** | `00:10.33` | `x: 520..1030 (w: 510)`, `y: 496..1450 (h: 954)` | **Oscillation / Upward Scrub**: Finger moves back up (`Scan` returns to `y: 22%`, `Delete` to `y: 48%`); menu tracks finger position with zero lag. |
| **`IMG_7765.PNG`** | `00:10.91` | `x: 520..1030 (w: 510)`, `y: 526..1444 (h: 918)` | **Deep Downward Pull (`Delete` at `y: 50%`)**: User pulls menu further down (`Scan` at `y: 23%`, `Move Note` at `y: 31%`, `Delete` at `y: 50%`); bottom edge reaches `y: 1569` in full outer shadow/rim diff. |
| **`IMG_7766.PNG`** | `00:11.24` | `x: 520..1030 (w: 510)`, `y: 502..1438 (h: 936)` | **Mid-Pull Return**: Finger lifts slightly (`Scan` at `y: 22%`, `Delete` at `y: 47%`). |
| **`IMG_7767.PNG`** | `00:12.06` | `x: 520..1030 (w: 510)`, `y: 526..1444 (h: 918)` | **Maximum Elastic Pull Displacement**: Menu is pulled to its lowest offset (`Scan` `x: 49%, y: 23%`; `Delete` `x: 54%, y: 50%`, outer rim `y: 1583`), demonstrating both vertical and slight horizontal (`+2%` X) rubber-banding toward the thumb. |
| **`IMG_7768.PNG`** | `00:14.53` | `x: 520..1030 (w: 510)`, `y: 490..1390 (h: 900)` | **Settled & Tapping `Recent Notes` Submenu**: Menu is back at rest (`y: 490`); user taps the `Recent Notes` submenu row (`y: 32%`). |
| **`IMG_7769.PNG`** | `00:14.62` | `x: 520..1030 (w: 510)`, `y: 490..1372 (h: 882)` | **In-Place Submenu Morph Frame 1 (`+90ms`)**: `Recent Notes` row begins rising toward the top to become the submenu section header! Cross-fading text (`"Math Results"` + incoming note preview) is visible at `y: 35%` as the parent items dissolve. |
| **`IMG_7770.PNG`** | `00:14.65` | `x: 520..1030 (w: 510)`, `y: 490..1390 (h: 900)` | **In-Place Submenu Morph Frame 2 (`+120ms`)**: `Recent Notes` header is halfway up (`y: 28%`, chevron rotating from `›` toward `⌄`); first child item (`"am i missing something? the protestors are over..."`) materializes at `y: 34%–37%` while bottom parent rows (`Lines & Grids`, `Attachment View`, `Delete`) are pushed/faded out. |
| **`IMG_7771.PNG`** | `00:14.67` | `x: 520..1030 (w: 510)`, `y: 496..1420 (h: 924)` | **In-Place Submenu Morph Frame 3 (`+140ms`)**: `Recent Notes` header reaches `y: 26%`; child #1 (`"am i missing..."`) at `y: 31%–34%`, child #2 (`"Using this repository, and plus find some for searc..."`) at `y: 37%–40%`, child #3 (`"figure of around..."`) entering at `y: 43%` as `Delete` (`y: 46%`) exits at the bottom. |
| **`IMG_7772.PNG`** | `00:14.70` | `x: 520..1030 (w: 510)`, `y: 496..1360 (h: 864)` | **In-Place Submenu Morph Frame 4 (`+170ms`)**: `Recent Notes` reaches `y: 25%`; top tiles (`Scan`, `Pin Note`, `Lock`) compress and fade upward as the submenu claims the full sheet height; child #3 (`"figure of around 40% refers to ethnic kazakhs..."`) is fully visible at `y: 42%–45%`. |
| **`IMG_7773.PNG`** | `00:14.84` | `x: 520..1030 (w: 510)`, `y: 490..1636 (h: 1146)` | **Submenu Expanded & Spring Overshoot (`+310ms`, `h: 1146px`)**: The single glass container **morphs its height** from `948px` to `1146px` (`y: 490..1636`)! Header row at `y: 20%` reads **`Recent Notes`** with a downward/expanded chevron **`⌄`** (`x: 76%, y: 21%`). Five multi-line note items are listed with `1px` hairline dividers: (1) `"am i missing something?..."`, (2) `"Using this repository..."`, (3) `"figure of around 40%..."`, (4) `"Hi, I got disconnected again. My name is Artem..."`, (5) `"Hi Fiero, / okay so to summarise..."`. |
| **`IMG_7774.PNG`** | `00:15.34` | `x: 520..1030 (w: 510)`, `y: 490..1612 (h: 1122)` | **Submenu Settled Rest State (`h: 1122px`)**: The expanded submenu settles from its `1146px` spring overshoot to `1122px` (`y: 490..1612`), showing the 5 multi-line recent note rows down to `"the total code"` (`y: 57%`). |
| **`IMG_7775.PNG`** | `00:22.38` | `x: 520..1030 (w: 510)`, `y: 490..1390 (h: 900)` | **Reverse Submenu Collapse (Back to Root Menu)**: After tapping the `Recent Notes ⌄` header, the sheet morphs smoothly back to the root menu (`Scan`, `Pin Note`, `Lock`, `Find in Note`, `Move Note`, `Recent Notes ›`, `Math Results` (with `Suggest Results` subtitle), `Lines & Grids`, `Attachment View ›`, `Delete`). |
| **`IMG_7776.PNG`** | `00:22.67` | `x: 520..1030 (w: 510)`, `y: 490..1420 (h: 930)` | **Reverse Morph Rebound (`+290ms`)**: Root menu settles with slight spring rebound (`h: 930px`, `x: 45%–77%`). |
| **`IMG_7777.PNG`** | `00:23.18` | `x: 520..1030 (w: 510)`, `y: 496..1366 (h: 870)` | **Secondary Settle Oscillation**: Subtle damping settle (`x: 44%–77%`) as user prepares to release. |
| **`IMG_7778.PNG`** | `00:24.02` | `x: 520..1030 (w: 510)`, `y: 490..1390 (h: 900)` | **Final Rest State**: Root menu completely stationary in its crisp rest geometry (`x: 45%–79%, y: 19%–47%`), identical to `IMG_7752.PNG`. |

---

## 2. Flaws in `wapo.dp`'s Existing `GlassDropdown` That We Are Fixing

From our audit of `/Users/artemchmylenko/development/wapo.dp/src/components/ds/GlassDropdown/GlassDropdown.tsx` (1,780 lines) and `src/components/ui/dropdown-menu.tsx` against the 35 reference frames above:

1. **No Top Quick-Action Tile Grid (`ActionGrid` / `TileItem`)**:
   - In `IMG_7749`–`IMG_7768`, the top of the menu features a 3-column horizontal quick-action tile row (`Scan`, `Pin Note`, `Lock` — icon stacked above label, no fills or vertical dividers, one inset rule below). `wapo.dp`'s `GlassDropdown` only supports vertical full-width rows.
2. **Broken In-Place Submenu Morph Animation (`IMG_7769`–`IMG_7774`)**:
   - In `wapo.dp`, `resolveMorphTrail` swaps the entire panel contents via a horizontal slide (`x: ±24px`) and renders a generic `‹ Back` button + `"ROOT"` mono pill.
   - In the real iOS reference (`IMG_7769`–`IMG_7774`), clicking `Recent Notes ›` **elevates the clicked row vertically to the top of the sheet** (`y: 32% → 28% → 25% → 20%`), rotates its trailing chevron from `›` to `⌄` (`IMG_7773`), collapses the top tile bar upward, and **springs the container height** (`948px → 1146px overshoot → 1122px rest`) while unfolding child items downward! Tapping the top `Recent Notes ⌄` header row collapses the submenu back into the root list (`IMG_7775`).
3. **Lack of Continuous Touch/Pointer Scrubbing + Elastic Rubber-Band Pull (`IMG_7754`–`IMG_7767`)**:
   - In `IMG_7754`–`IMG_7767`, dragging a finger across the open menu both:
     1. Scrubs the active highlight across rows continuously (`elementFromPoint` / pointer capture), and
     2. Applies **2D elastic rubber-band displacement & stretch** (`Δy` up to `+48px`, height stretching `+5.1%`) when pulling past items or toward the edges, snapping back with a spring (`IMG_7761`) upon release.
   - `wapo.dp`'s `GlassDropdown` only sets `scrubbingRef.current = true` on `Trigger` `pointerdown` and relies on `onPointerEnter` (which **does not fire during touch drag** on iOS/mobile browsers because touch events capture to the initial target!) and disables elastic pull on the menu container.
4. **Hard-Clipped `overflow-visible` vs. Refractive `GlassSurface` + Viewport Collision**:
   - `wapo.dp`'s `GlassDropdown.Content` uses `position: absolute` inside a `relative inline-flex` wrapper without viewport collision clamping (`flip` / `shift` when near screen edges) or portal support, causing menus inside `PlusTray` or near the bottom composer to clip off-screen.
   - In `wapo.dp`, `Content` puts a separate `<div className="bg-panel/45 backdrop-blur-[8px]" />` behind `GlassSurface`, double-blurring and muting the Snell bezel refraction seen in `IMG_7745`–`IMG_7748`.
5. **No Search / Combobox Filter or List Virtualization**:
   - PraxisChat's Model Picker (`BlurWave2Shots/testTrayModels` tests `500` models!) and MCP/Skill pickers require an inline search bar, pinned favorites, provider grouping, and 60fps virtualization for 500+ rows. `wapo.dp`'s `GlassDropdown` renders all DOM nodes eagerly with zero search/virtualization support.
6. **Multi-Line Rich Rows & Section Channels (`IMG_7773`–`IMG_7774`)**:
   - In `IMG_7773`–`IMG_7774`, submenu items support up to 3 lines of preview text (`"Hi, I got disconnected again. My name is Artem..."`) with vertically centered document icons and no rules between preview rows; only the submenu header has an inset rule. `wapo.dp` truncates every `Item` to a single line (`className="truncate"`).

---

## 3. Specification of the New `@praxis/glass` `GlassDropdown`

### 3.1 Component Architecture & Public API

Exported from `@praxis/glass` (`cloud/packages/glass/src/dropdown/GlassDropdown.tsx`):

```tsx
<GlassDropdown
  open={open}
  onOpenChange={setOpen}
  side="top" | "bottom" | "auto"
  align="start" | "center" | "end"
  sideOffset={8}
  submenuMode="morph" | "cascade"
  portal={false} // optional portal with automatic collision flip/shift
>
  <GlassDropdown.Trigger icon={...} value={...}>
    Label
  </GlassDropdown.Trigger>

  <GlassDropdown.Content minWidth={256} maxHeight={420} searchable placeholder="Filter models…">
    {/* 1. Optional iOS Top Quick-Action Tile Grid (IMG_7749: Scan | Pin Note | Lock) */}
    <GlassDropdown.ActionGrid columns={3}>
      <GlassDropdown.TileItem icon={<ScanIcon />} onSelect={...}>Scan</GlassDropdown.TileItem>
      <GlassDropdown.TileItem icon={<PinIcon />} onSelect={...}>Pin Note</GlassDropdown.TileItem>
      <GlassDropdown.TileItem icon={<LockIcon />} onSelect={...}>Lock</GlassDropdown.TileItem>
    </GlassDropdown.ActionGrid>

    {/* 2. Optional Sticky Search Input (for Model Picker / Command Menu) */}
    <GlassDropdown.Search value={query} onValueChange={setQuery} placeholder="Search models…" />

    {/* 3. Standard & Rich Multi-line Items, Checkboxes, Radios, DotMeters */}
    <GlassDropdown.Group label="Pinned">
      <GlassDropdown.Item
        icon={...}
        subtitle="Fastest reasoning"
        lines={1 | 2 | 3}
        selected={true}
        badge={<DotMeter speed={5} intelligence={4} />}
        trailingAction={<PinButton />}
        onSelect={...}
      >
        Claude 3.7 Sonnet
      </GlassDropdown.Item>
    </GlassDropdown.Group>

    <GlassDropdown.Separator variant="section" />

    {/* 4. In-Place Elevating Submenu (IMG_7769–IMG_7774: Recent Notes › -> Recent Notes ⌄) */}
    <GlassDropdown.Sub id="recent-notes" label="Recent Notes" icon={<NotesIcon />}>
      <GlassDropdown.SubTrigger>Recent Notes</GlassDropdown.SubTrigger>
      <GlassDropdown.SubContent>
        <GlassDropdown.Item lines={3} icon={<DocIcon />}>
          am i missing something? the protestors are over...
        </GlassDropdown.Item>
      </GlassDropdown.SubContent>
    </GlassDropdown.Sub>

    <GlassDropdown.Separator variant="section" />

    {/* 5. Destructive Action (IMG_7749: Delete) */}
    <GlassDropdown.Item tone="destructive" icon={<TrashIcon />} onSelect={...}>
      Delete
    </GlassDropdown.Item>

    {/* 6. Built-in Virtualized List Helper for 500+ items */}
    <GlassDropdown.VirtualList
      items={models}
      itemHeight={52}
      overscan={6}
      renderItem={(model) => <GlassDropdown.Item key={model.id}>...</GlassDropdown.Item>}
    />
  </GlassDropdown.Content>
</GlassDropdown>
```

### 3.2 Exact Geometry, Material & Visual Tokens

| Element | Token / Value | Reference Frame |
| :--- | :--- | :--- |
| **Outer Card Radius** | `24px` (`shape="free" radius={24}` on `GlassSurface`) | `IMG_7749`–`IMG_7752` |
| **Material Tier** | `material="regular"`, `refraction={true}`, `frost="progressive"`, `spotlight={true}` | `IMG_7745`–`IMG_7752` |
| **Vibrancy Substrate** | Integrated into `GlassSurface` tint (`rgba(251, 251, 249, 0.72)` light / `rgba(21, 21, 19, 0.74)` dark) so bezel displacement remains 100% visible at the outer `20px` ring | `IMG_7746`–`IMG_7750` |
| **Top `ActionGrid` Tiles** | Height `58px`, 3 equal columns, `1px` hairline vertical dividers (`var(--paper-hairline)`), `16px` icon above `12px` medium label, `10px` internal radius on highlight | `IMG_7749` (`Scan`, `Pin Note`, `Lock`) |
| **Standard Menu Row (`Item`)** | Min-height `40px` (`48px` with subtitle, up to `68px` when `lines={3}`), horizontal padding `14px`, vertical padding `9px`, label `14px` (`500` weight) on left, icon `16px` on leading or trailing slot | `IMG_7752`, `IMG_7773` |
| **Row Highlight Wash** | Full-bleed translucent wash (`rgba(21, 20, 15, 0.07)` light / `rgba(241, 239, 233, 0.11)` dark; destructive `rgba(179, 56, 46, 0.14)`), spring-tracked via `layoutId` (`k: 520, c: 36, m: 0.7`) | `IMG_7755`–`IMG_7758` |
| **Section Channel (`Separator variant="section"`)** | `7px` height channel with `rgba(0,0,0,0.04)` / `rgba(255,255,255,0.03)` recessed fill and top/bottom `1px` hairlines | Generic optional grouping only; not used above Delete in the frame replica |
| **Item Hairline (`Separator variant="hairline"`)** | `1px` inset hairline (`var(--paper-hairline)`), flush between rows | `IMG_7773`–`IMG_7774` |

### 3.3 Motion & Physics Specification (Matching `IMG_7745`–`IMG_7778`)

1. **Unfurl / Pop Open (`IMG_7745` → `IMG_7752`, `Δt = 270ms` + settle)**:
   - Anchored to the trigger corner (`transformOrigin` dynamically computed from resolved `side` × `align`, e.g., `top right` or `bottom left`).
   - Initial state: `opacity: 0, scaleX: 0.38, scaleY: 0.28, y: side === "top" ? 10 : -10, filter: "blur(6px)"`.
   - Spring transition (`Motion.pop` tuned to `IMG_7749` overshoot): `stiffness: 380, damping: 24, mass: 0.82` (produces the exact `~1.5%` vertical overshoot seen at `IMG_7749` `t=01.44s` before settling at `IMG_7751` `t=01.56s`).
   - Exit transition: `opacity: 0, scale: 0.74, y: side === "top" ? 6 : -6`, `duration: 120ms ease-in`.
2. **In-Place Submenu Elevation & Height Morph (`IMG_7768` → `IMG_7774` → `IMG_7775`)**:
   - When a `SubTrigger` (e.g., `Recent Notes ›`) is activated in `submenuMode="morph"`:
     - The outer `GlassSurface` container animates its height with a layout spring (`stiffness: 360, damping: 26, mass: 0.85`), reproducing the `948px → 1146px → 1122px` overshoot in `IMG_7773`–`IMG_7774`.
     - The activated `SubTrigger` morphs into the sticky top submenu header row (`layoutId` shared between trigger row and submenu header), rotating its trailing chevron `90°` (`›` → `⌄`, `IMG_7773` `x: 76%, y: 20%`).
     - Top `ActionGrid` tiles and sibling parent rows compress upward/fade out (`opacity: 0, y: -12, scale: 0.96, duration: 130ms`), while submenu children stagger-reveal downward (`y: -8 → 0, opacity: 0 → 1`).
     - Clicking the sticky `Recent Notes ⌄` header row (or pressing `ArrowLeft` / `Backspace` / `Escape`) reverses the morph back to the root menu (`IMG_7775`–`IMG_7778`).
3. **Touch & Pointer Scrubbing + Elastic Rubber-Band Pull (`IMG_7754`–`IMG_7767`)**:
   - **Cross-Row Touch Scrubbing**: On `pointerdown` inside the trigger or menu content, a window-level `pointermove` listener uses `document.elementFromPoint(e.clientX, e.clientY)?.closest('[role^="menuitem"]')` so dragging a finger or mouse across rows highlights each item in real time and activates on `pointerup` if dragged for `> 150ms`.
   - **2D Elastic Pull**: Dragging vertically or horizontally while holding inside the menu applies a damped hyperbolic tangent rubber-band offset:
     $$\Delta y_{\text{elastic}} = B_y \cdot \tanh\!\left(\frac{\Delta y_{\text{raw}}}{B_y \cdot 2.2}\right), \quad B_y = 48\text{px}, \quad B_x = 18\text{px}$$
     plus vertical scale stretch $s_y = 1 + \frac{|\Delta y_{\text{elastic}}|}{950}$ (up to `+5.1%`, matching `IMG_7759` `h: 948 → 996px`). Releasing snaps back with `stiffness: 420, damping: 26` (`IMG_7761`).
4. **Viewport Collision & Auto-Placement**:
   - Automatically measures trigger bounding rect vs. viewport (`12px` safe margin) on open and resize: flips `side` (`bottom ↔ top`) and clamps horizontal `x` offset so the menu never clips off-screen on mobile (`402×874`) or desktop (`1440×900`).
5. **Accessibility & Keyboard Navigation**:
   - WAI-ARIA compliant `role="menu"`, `role="menuitem"`, `role="menuitemcheckbox"`, `role="menuitemradio"`, `aria-haspopup="menu"`, `aria-expanded`, `aria-activedescendant`.
   - Full keyboard support: `ArrowDown`, `ArrowUp`, `Home`, `End`, `ArrowRight` (open submenu), `ArrowLeft` / `Backspace` (close submenu), `Enter` / `Space` (activate), `Escape` (close & return focus to trigger), and typeahead/search filtering.


## WP-B4 reference corrections and verification

The 240 CSS-px default width, 17 px labels and 40 px minimum single-line rows track
the approximately 235 pt frame card after scale conversion. Earlier table coordinates
are historical raw-image observations, not CSS dimensions or timing measurements.
The ActionGrid clips to the 24 px card corners. The translucent .74 tint is combined
with 24 px diffusion and the glass engine's progressive frost, sheen and rim; primary,
secondary and destructive text are checked for AA against black/white limiting backdrops.
The Recent Notes header is plain with an inset rule; its label and rotating chevron
share one layout row. Children enter with 30 ms staggering, bypassed under reduced motion.

Touch vertical/horizontal pans over matching scroll containers exceed an 8 px threshold
and stay native. Trigger-origin press-drag-release remains selection; content-origin
cancel never dismisses a scroll. Escape/ArrowLeft pop one level and restore its parent
SubTrigger. Tab/Shift-Tab leave the menu relative to the trigger, not the portal's DOM position.

Run the checked-in dropdown Playwright config with `PW_PORT=5191` (default 5192) or
`PW_BASE_URL`; `PW_OUTPUT_DIR` defaults to local `test-results/`. Screenshots are per-test
outputs and do not overwrite the external reference evidence.
