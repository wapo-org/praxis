import { useSyncExternalStore } from 'react';

export const SIDEBAR_PALETTES = [
  { id: 'graphite', name: 'Graphite', base: '#16181b', border: '#3d4147', acc: '#8ea0b3', dark: true },
  { id: 'midnight', name: 'Midnight', base: '#101c33', border: '#2f4570', acc: '#4b7fd6', dark: true },
  { id: 'forest', name: 'Forest', base: '#12261d', border: '#2f5a45', acc: '#44a877', dark: true },
  { id: 'plum', name: 'Plum', base: '#261530', border: '#5a3a6b', acc: '#a866d4', dark: true },
  { id: 'sand', name: 'Sand', base: '#ede7da', border: '#cfc5b0', acc: '#dfd1af', dark: false },
  { id: 'paper', name: 'Paper', base: '#fafaf9', border: '#d6d7e0', acc: '#e2e3eb', dark: false },
] as const;

const LIGHT_STOP_TONES = {
  sand: {
    top: '#f5f0e5',
    mid: '#ede5d5',
    bottom: '#e5dcc9',
    glossBottom: 'rgb(225 214 192/14%)',
    shadowShade: '#8c8578',
  },
  paper: {
    top: '#ffffff',
    mid: '#f7f7fa',
    bottom: '#efeff4',
    glossBottom: 'rgb(232 234 242/14%)',
    shadowShade: '#8e90a0',
  },
} as const;

export type SidebarPaletteId = (typeof SIDEBAR_PALETTES)[number]['id'];
export const DEFAULT_PALETTE: SidebarPaletteId = 'graphite';

export const PALETTE_KEY = 'praxis-sidebar-palette';
const EVENT = 'praxis:sidebar-look';

export const isPaletteId = (value: unknown): value is SidebarPaletteId =>
  SIDEBAR_PALETTES.some((p) => p.id === value);

export const sidebarGradient = (base: string) =>
  'linear-gradient(to bottom,rgb(255 255 255/20%) 0%,rgb(255 255 255/12%) 2%,rgb(255 255 255/6%) 5%,rgb(255 255 255/2%) 9%,transparent 14%,transparent 100%),linear-gradient(to bottom,' +
  base +
  ' 0%,' +
  base +
  ' 45%,color-mix(in srgb,' +
  base +
  ' 40%,transparent) 100%)';

const lightSidebarGradient = (id: 'sand' | 'paper') => {
  const t = LIGHT_STOP_TONES[id];
  return (
    'linear-gradient(to bottom,' +
    t.top +
    ' 0%,' +
    t.mid +
    ' 45%,color-mix(in srgb,' +
    t.bottom +
    ' 90%,transparent) 100%)'
  );
};

const DARK_GLOSS =
  'linear-gradient(to bottom,rgb(255 255 255/20%) 0%,rgb(255 255 255/12%) 2%,rgb(255 255 255/6%) 5%,rgb(255 255 255/2%) 9%,transparent 14%,rgb(0 0 0/12%) 100%)';

const lightGloss = (id: 'sand' | 'paper') => {
  const t = LIGHT_STOP_TONES[id];
  const top = id === 'paper' ? 75 : 65;
  const s2 = id === 'paper' ? 45 : 38;
  const s6 = id === 'paper' ? 18 : 16;
  const s11 = id === 'paper' ? 5 : 4;
  return (
    'linear-gradient(to bottom,rgb(255 255 255/' +
    top +
    '%) 0%,rgb(255 255 255/' +
    s2 +
    '%) 2%,rgb(255 255 255/' +
    s6 +
    '%) 6%,rgb(255 255 255/' +
    s11 +
    '%) 11%,transparent 18%,' +
    t.glossBottom +
    ' 100%)'
  );
};

/** v2's reflection defaults (`borderAngle`, `glowStrength`). */
export const RING_ANGLE = 45;
export const RING_STRENGTH = 100;

/** v2's `ringBg`: a conic "border reflection" in the palette's `ACC`, hot at the angle, dark opposite. */
export function ringBackground(acc: string, angle = RING_ANGLE, strength = RING_STRENGTH) {
  const base = 'color-mix(in srgb,' + acc + ' 10%,#000)';
  const hot = 'color-mix(in srgb,' + acc + ' ' + strength + '%,' + base + ')';
  const mid = 'color-mix(in srgb,' + acc + ' ' + Math.round(strength * 0.4) + '%,' + base + ')';
  return (
    'conic-gradient(from ' +
    angle +
    'deg at 50% 50%,' +
    hot +
    ' 0deg,' +
    mid +
    ' 35deg,' +
    base +
    ' 110deg,' +
    base +
    ' 250deg,' +
    mid +
    ' 325deg,' +
    hot +
    ' 360deg)'
  );
}

function lightRingBackground(id: 'sand' | 'paper', border: string, acc: string, angle = RING_ANGLE) {
  const shade = LIGHT_STOP_TONES[id].shadowShade;
  const hi = '#ffffff';
  const mid = 'color-mix(in srgb,' + acc + ' 45%,#ffffff)';
  const lo = 'color-mix(in srgb,' + border + ' 72%,' + shade + ')';
  return (
    'conic-gradient(from ' +
    angle +
    'deg at 50% 50%,' +
    hi +
    ' 0deg,' +
    mid +
    ' 35deg,' +
    lo +
    ' 110deg,' +
    lo +
    ' 250deg,' +
    mid +
    ' 325deg,' +
    hi +
    ' 360deg)'
  );
}

const DARK_SHADOW = 'inset 0 1px 2px rgb(255 255 255/30%)';
const LIGHT_SHADOW =
  'inset 0 1.5px 1px rgb(255 255 255/92%),inset 0 -1px 1px rgb(21 20 15/6%),0 12px 30px rgb(21 20 15/11%),0 2px 6px rgb(21 20 15/7%)';

export function paletteVars(id: SidebarPaletteId) {
  const p = SIDEBAR_PALETTES.find((x) => x.id === id)!;
  const lightId = p.dark ? null : (id as 'sand' | 'paper');
  return {
    '--sb-bg': lightId ? lightSidebarGradient(lightId) : sidebarGradient(p.base),
    '--sb-gloss': lightId ? lightGloss(lightId) : DARK_GLOSS,
    '--sb-ring': lightId ? lightRingBackground(lightId, p.border, p.acc) : ringBackground(p.acc),
    '--sb-shadow': lightId ? LIGHT_SHADOW : DARK_SHADOW,
    '--sb-base': p.base,
    '--sb-border': p.border,
    '--sb-accent': p.acc,
    '--sb-ink': p.dark ? '#f2f1ed' : '#1c1c1c',
    '--sb-mute': p.dark ? '#b5b4b0' : '#44423c',
    '--sb-hl': p.dark ? 'rgba(255,255,255,0.12)' : 'rgba(21,20,15,0.06)',
    '--sb-line': p.dark ? 'rgba(255,255,255,0.1)' : 'rgba(21,20,15,0.1)',
    '--sb-active': p.dark ? 'rgba(255,255,255,0.12)' : 'rgba(21,20,15,0.09)',
  };
}

export function readPalette(): SidebarPaletteId {
  if (typeof document === 'undefined') return DEFAULT_PALETTE;
  const value = document.documentElement.dataset.sidebarPalette;
  return isPaletteId(value) ? value : DEFAULT_PALETTE;
}

/** Writes the look onto <html>: what index.html does before first paint. */
export function applySidebarLook(palette: unknown, root = document.documentElement) {
  const id = isPaletteId(palette) ? palette : DEFAULT_PALETTE;
  root.dataset.sidebarPalette = id;
  for (const [name, value] of Object.entries(paletteVars(id))) root.style.setProperty(name, value);
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* The current session still works with storage denied. */
  }
}

export function setSidebarPalette(id: SidebarPaletteId) {
  applySidebarLook(id);
  persist(PALETTE_KEY, id);
  window.dispatchEvent(new Event(EVENT));
}

/** Another tab changed the look: apply it here whether or not Settings is open. */
function applyFromStorage(event: StorageEvent) {
  if (event.key !== PALETTE_KEY && event.key !== null) return;
  let palette: string | null = null;
  try {
    palette = localStorage.getItem(PALETTE_KEY);
  } catch {
    return; /* Keep what is applied. */
  }
  applySidebarLook(palette);
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
