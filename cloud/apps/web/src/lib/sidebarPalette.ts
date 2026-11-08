import { useSyncExternalStore } from 'react';

/**
 * The owner's sidebar palettes and New-chat button colours, ported from Chat Screen.dc.html (design v2:
 * `PAL`, `ACC`, `BP`, `grad()`, `renderVals()`). Both persist and are applied before first paint by the inline
 * script in index.html, which must stay in step with `applySidebarLook` (sidebarPalette.test.ts runs it).
 * `acc` is v2's `ACC`: the colour of each palette's border reflection.
 */
export const SIDEBAR_PALETTES = [
  { id: 'graphite', name: 'Graphite', base: '#16181b', border: '#3d4147', acc: '#8ea0b3', dark: true },
  { id: 'midnight', name: 'Midnight', base: '#101c33', border: '#2f4570', acc: '#4b7fd6', dark: true },
  { id: 'forest', name: 'Forest', base: '#12261d', border: '#2f5a45', acc: '#44a877', dark: true },
  { id: 'plum', name: 'Plum', base: '#261530', border: '#5a3a6b', acc: '#a866d4', dark: true },
  { id: 'sand', name: 'Sand', base: '#e9e4d8', border: '#cfc8b6', acc: '#d9c79a', dark: false },
  { id: 'paper', name: 'Paper', base: '#fbfbf9', border: '#d9d9e0', acc: '#d6d6e0', dark: false },
] as const;
export type SidebarPaletteId = (typeof SIDEBAR_PALETTES)[number]['id'];
export const DEFAULT_PALETTE: SidebarPaletteId = 'graphite';

/** `BP` from the source, with White first: the rendered design shows a white pill. */
export const BUTTON_COLORS = [
  { name: 'White', color: '#ffffff' },
  { name: 'Cyan', color: '#79e0f8' },
  { name: 'Navy', color: '#1d4056' },
  { name: 'Gray', color: '#8d8d99' },
  { name: 'Graphite', color: '#2b2e33' },
  { name: 'Coral', color: '#f4846b' },
  { name: 'Lime', color: '#b6e36b' },
] as const;
export const DEFAULT_BUTTON = '#ffffff';

export const PALETTE_KEY = 'praxis-sidebar-palette';
export const BUTTON_KEY = 'praxis-button-color';
const EVENT = 'praxis:sidebar-look';

const HEX = /^#[0-9a-f]{6}$/i;
export const isPaletteId = (value: unknown): value is SidebarPaletteId =>
  SIDEBAR_PALETTES.some((p) => p.id === value);
export const isHex = (value: unknown): value is string => typeof value === 'string' && HEX.test(value);

/**
 * v2's `grad(base)`, verbatim: the top sheen over the base, which is solid to 45 % and then fades to 40 % of
 * itself at the bottom, so the sidebar turns translucent toward the bottom (the aside blurs what is behind).
 */
export const sidebarGradient = (base: string) =>
  'linear-gradient(to bottom,rgb(255 255 255/20%) 0%,rgb(255 255 255/12%) 2%,rgb(255 255 255/6%) 5%,rgb(255 255 255/2%) 9%,transparent 14%,transparent 100%),linear-gradient(to bottom,' +
  base +
  ' 0%,' +
  base +
  ' 45%,color-mix(in srgb,' +
  base +
  ' 40%,transparent) 100%)';

/** v2's reflection defaults (`borderAngle`, `glowStrength`). */
export const RING_ANGLE = 45;
export const RING_STRENGTH = 100;

/** v2's `ringBg`: a conic "border reflection" in the palette's `ACC`, hot at the angle, dark opposite. */
export function ringBackground(acc: string, angle = RING_ANGLE, strength = RING_STRENGTH) {
  const base = 'color-mix(in srgb,' + acc + ' 10%,#000)';
  const hot = 'color-mix(in srgb,' + acc + ' ' + strength + '%,' + base + ')';
  const mid = 'color-mix(in srgb,' + acc + ' ' + Math.round(strength * 0.4) + '%,' + base + ')';
  return (
    'conic-gradient(from ' + angle + 'deg at 50% 50%,' + hot + ' 0deg,' + mid + ' 35deg,' + base + ' 110deg,' +
    base + ' 250deg,' + mid + ' 325deg,' + hot + ' 360deg)'
  );
}

/**
 * The derived values from `renderVals()`. One deviation, carried from v1: the light mute is #454440, not
 * #5c5b57 (#5c5b57 is 3.2:1 on Sand under the aside's literal gloss, which still darkens the bottom by 12 %).
 */
export function paletteVars(id: SidebarPaletteId) {
  const p = SIDEBAR_PALETTES.find((x) => x.id === id)!;
  return {
    '--sb-bg': sidebarGradient(p.base),
    '--sb-ring': ringBackground(p.acc),
    '--sb-base': p.base,
    '--sb-border': p.border,
    '--sb-ink': p.dark ? '#f2f1ed' : '#1c1c1c',
    '--sb-mute': p.dark ? '#b5b4b0' : '#454440',
    '--sb-hl': p.dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
    '--sb-line': p.dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
  };
}

/** The source's relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/**
 * The source's two inks, #10242d and #fff. The source switches at luminance 0.35; this takes whichever
 * contrasts more (a switch at ~0.21), which differs only for mid tones such as Gray (#8d8d99), where the
 * source's white is 3.3:1 and #10242d is AA.
 */
export function buttonInk(color: string): string {
  const l = luminance(color);
  return (l + 0.05) / (luminance('#10242d') + 0.05) >= 1.05 / (l + 0.05) ? '#10242d' : '#ffffff';
}

/**
 * `nbFill`, `nbInk` and `nbBorder` from the source. White is the source's literal pill (`background:#fff;
 * color:#1c1c1c;border:0`), which is what the rendered design shows.
 */
export function buttonVars(color: string) {
  if (color.toLowerCase() === DEFAULT_BUTTON)
    return { '--nb-fill': DEFAULT_BUTTON, '--nb-ink': '#1c1c1c', '--nb-border': 'transparent' };
  return {
    '--nb-fill': color,
    '--nb-ink': buttonInk(color),
    '--nb-border': `color-mix(in srgb,${color},#000 18%)`,
  };
}

export function readPalette(): SidebarPaletteId {
  if (typeof document === 'undefined') return DEFAULT_PALETTE;
  const value = document.documentElement.dataset.sidebarPalette;
  return isPaletteId(value) ? value : DEFAULT_PALETTE;
}

export function readButton(): string {
  if (typeof document === 'undefined') return DEFAULT_BUTTON;
  const value = document.documentElement.dataset.buttonColor;
  return isHex(value) ? value : DEFAULT_BUTTON;
}

/** Writes the look onto <html>: what index.html does before first paint. */
export function applySidebarLook(palette: unknown, button: unknown, root = document.documentElement) {
  const id = isPaletteId(palette) ? palette : DEFAULT_PALETTE;
  const color = isHex(button) ? button.toLowerCase() : DEFAULT_BUTTON;
  root.dataset.sidebarPalette = id;
  root.dataset.buttonColor = color;
  for (const [name, value] of Object.entries({ ...paletteVars(id), ...buttonVars(color) }))
    root.style.setProperty(name, value);
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The current session still works with storage denied. */
  }
}

export function setSidebarPalette(id: SidebarPaletteId) {
  applySidebarLook(id, readButton());
  persist(PALETTE_KEY, id);
  window.dispatchEvent(new Event(EVENT));
}

export function setButtonColor(color: string) {
  if (!isHex(color)) return;
  applySidebarLook(readPalette(), color);
  persist(BUTTON_KEY, color.toLowerCase());
  window.dispatchEvent(new Event(EVENT));
}

/** Another tab changed the look: apply it here whether or not Settings is open. */
function applyFromStorage(event: StorageEvent) {
  if (event.key !== PALETTE_KEY && event.key !== BUTTON_KEY && event.key !== null) return;
  let palette: string | null = null;
  let button: string | null = null;
  try {
    palette = localStorage.getItem(PALETTE_KEY);
    button = localStorage.getItem(BUTTON_KEY);
  } catch {
    return; /* Keep what is applied. */
  }
  applySidebarLook(palette, button);
  window.dispatchEvent(new Event(EVENT));
}

let syncing = false;
/** Called once at startup (main.tsx): keeps every tab's sidebar in step with the saved look. */
export function syncSidebarLook() {
  if (syncing || typeof window === 'undefined') return;
  syncing = true;
  window.addEventListener('storage', applyFromStorage);
}

function subscribe(notify: () => void) {
  window.addEventListener(EVENT, notify);
  return () => window.removeEventListener(EVENT, notify);
}

export const useSidebarPalette = () => useSyncExternalStore(subscribe, readPalette, () => DEFAULT_PALETTE);
export const useButtonColor = () => useSyncExternalStore(subscribe, readButton, () => DEFAULT_BUTTON);
