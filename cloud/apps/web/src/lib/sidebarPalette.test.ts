// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SIDEBAR_PALETTES, applySidebarLook, paletteVars, readPalette, setSidebarPalette, syncSidebarLook } from './sidebarPalette';

const hex = (value: string) => value.slice(1).match(/../g)!.map((v) => parseInt(v, 16));
const rgba = (value: string) => {
  const m = /rgba\((\d+),(\d+),(\d+),([\d.]+)\)/.exec(value.replace(/\s/g, ''))!;
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: Number(m[4]) };
};
const over = (top: number[], a: number, under: number[]) => under.map((u, i) => top[i]! * a + u * (1 - a));
const lum = (rgb: number[]) =>
  rgb
    .map((v) => v / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: number[], b: number[]) => {
  const [lo, hi] = [lum(a), lum(b)].sort((x, y) => x - y);
  return (hi! + 0.05) / (lo! + 0.05);
};

const html = readFileSync('apps/web/index.html', 'utf8');
const bootstrap = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
const runBootstrap = () =>
  new Function('localStorage', 'document', 'window', 'performance', bootstrap)(
    localStorage,
    document,
    { matchMedia: () => ({ matches: false }) },
    { mark: () => {} },
  );
const VARS = ['--sb-bg', '--sb-ring', '--sb-base', '--sb-border', '--sb-ink', '--sb-mute', '--sb-hl', '--sb-line', '--nb-fill', '--nb-ink', '--nb-border'];
const snapshot = () => {
  const root = document.documentElement;
  return {
    palette: root.dataset.sidebarPalette,
    vars: Object.fromEntries(VARS.map((name) => [name, root.style.getPropertyValue(name)])),
  };
};

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('style');
  delete document.documentElement.dataset.sidebarPalette;
});

it('ports PAL and grad() from the owner source exactly', () => {
  expect(SIDEBAR_PALETTES.map((p) => [p.name, p.base, p.border, p.dark])).toEqual([
    ['Graphite', '#16181b', '#3d4147', true],
    ['Midnight', '#101c33', '#2f4570', true],
    ['Forest', '#12261d', '#2f5a45', true],
    ['Plum', '#261530', '#5a3a6b', true],
    ['Sand', '#e9e4d8', '#cfc8b6', false],
    ['Paper', '#fbfbf9', '#d9d9e0', false],
  ]);
  // The owner's v2 file, where present (it is outside the repo): grad() and ringBg must be the same strings.
  let source = '';
  try {
    source = readFileSync(`${process.env.HOME}/.praxis-agent-state/cloud/design/G6-ref/zip/Chat Screen.dc.html`, 'utf8');
  } catch {
    /* Not on this machine. */
  }
  const grad = /grad\(base\) \{ (return [^}]+;) \}/.exec(source)?.[1];
  if (grad) expect(paletteVars('plum')['--sb-bg']).toBe(new Function('base', grad)('#261530'));
  const acc = /const ACC = (\[[^\]]+\]);/.exec(source)?.[1];
  if (acc) expect(SIDEBAR_PALETTES.map((p) => p.acc)).toEqual(JSON.parse(acc.replace(/'/g, '"')));
  const ring = /(const base = 'color-mix[\s\S]*?const ringBg = [^;]+;)/.exec(source)?.[1];
  if (ring)
    for (const p of SIDEBAR_PALETTES)
      expect(paletteVars(p.id)['--sb-ring']).toBe(new Function('acc', 'ang', 'st', `${ring} return ringBg;`)(p.acc, 45, 100));
  expect(SIDEBAR_PALETTES.map((p) => p.acc)).toEqual(['#8ea0b3', '#4b7fd6', '#44a877', '#a866d4', '#d9c79a', '#d6d6e0']);
  expect(paletteVars('graphite')['--sb-bg']).toBe(
    'linear-gradient(to bottom,rgb(255 255 255/20%) 0%,rgb(255 255 255/12%) 2%,rgb(255 255 255/6%) 5%,rgb(255 255 255/2%) 9%,transparent 14%,transparent 100%),linear-gradient(to bottom,#16181b 0%,#16181b 45%,color-mix(in srgb,#16181b 40%,transparent) 100%)',
  );
  expect(paletteVars('graphite')['--sb-ring']).toBe(
    'conic-gradient(from 45deg at 50% 50%,color-mix(in srgb,#8ea0b3 100%,color-mix(in srgb,#8ea0b3 10%,#000)) 0deg,color-mix(in srgb,#8ea0b3 40%,color-mix(in srgb,#8ea0b3 10%,#000)) 35deg,color-mix(in srgb,#8ea0b3 10%,#000) 110deg,color-mix(in srgb,#8ea0b3 10%,#000) 250deg,color-mix(in srgb,#8ea0b3 40%,color-mix(in srgb,#8ea0b3 10%,#000)) 325deg,color-mix(in srgb,#8ea0b3 100%,color-mix(in srgb,#8ea0b3 10%,#000)) 360deg)',
  );
});

it('keeps sidebar text AA where v2 keeps it readable, and pins the fade where it does not', () => {
  // The aside's literal gloss: white stops 20/12/6/2 % at 0/2/5/9 %, clear at 14 %, then black to 12 %.
  // sbBg = grad(base): the same white sheen (no black), over the base, solid to 45 % and 40 % at the bottom.
  const white = (y: number) => {
    if (y >= 0.14) return 0;
    const stops = [[0, 0.2], [0.02, 0.12], [0.05, 0.06], [0.09, 0.02], [0.14, 0]] as const;
    const i = stops.findIndex(([at]) => at > y);
    const [y0, a0] = stops[i - 1]!;
    const [y1, a1] = stops[i]!;
    return a0 + ((a1 - a0) * (y - y0)) / (y1 - y0);
  };
  const black = (y: number) => (y < 0.14 ? 0 : (0.12 * (y - 0.14)) / 0.86);
  const alpha = (y: number) => (y <= 0.45 ? 1 : 1 - (0.6 * (y - 0.45)) / 0.55);
  // What shows through the bottom: the main area's paper (tokens.css --paper-gradient), plain and under its
  // strongest tint, in each theme.
  const backdrops = {
    light: [hex('#fbfbf9'), over([214, 196, 164], 0.22, hex('#fbfbf9'))],
    dark: [hex('#0b0b0a'), over([120, 104, 78], 0.16, hex('#0b0b0a'))],
  };
  for (const p of SIDEBAR_PALETTES) {
    const vars = paletteVars(p.id);
    const hl = rgba(vars['--sb-hl']);
    for (const [theme, list] of Object.entries(backdrops))
      for (const backdrop of list) {
        // Same polarity (a dark palette in the dark app, a light one in the light app): AA top to bottom.
        // Opposite polarity: AA down to 60 % of the height; below, the owner's fade (DESIGN.md) is pinned so it cannot get worse.
        const same = p.dark === (theme === 'dark');
        // Text starts below the New chat pill (~9 % of the height) and ends at the footer's last line (~98 %).
        for (let y = 0.09; y <= 0.98; y += 0.01) {
          let bg = over(hex(p.base), alpha(y), backdrop);
          bg = over([255, 255, 255], white(y), bg);
          bg = over([0, 0, 0], black(y), over([255, 255, 255], white(y), bg));
          const at = `${p.name} in the ${theme} app at ${y.toFixed(2)}`;
          // The pins were set over v2's mBg; the main area is back on its own paper (WP-I1), whose dark is deeper.
          const [ink, mute] = same || y <= 0.6 ? [4.5, 4.5] : [2.2, 1.4];
          for (const surface of [bg, over(hl.rgb, hl.a, bg), over([255, 255, 255], 0.12, bg)])
            expect(contrast(hex(vars['--sb-ink']), surface), `ink, ${at}`).toBeGreaterThanOrEqual(ink);
          expect(contrast(hex(vars['--sb-mute']), bg), `mute, ${at}`).toBeGreaterThanOrEqual(mute);
        }
      }
  }
});

it('persists the palette and the pre-paint bootstrap applies exactly what the module applies', () => {
  for (const p of SIDEBAR_PALETTES) {
    applySidebarLook(p.id);
    const expected = snapshot();
    document.documentElement.removeAttribute('style');
    localStorage.setItem('praxis-sidebar-palette', p.id);
    runBootstrap();
    expect(snapshot()).toEqual(expected);
  }
  setSidebarPalette('forest');
  expect(readPalette()).toBe('forest');
  expect(localStorage.getItem('praxis-sidebar-palette')).toBe('forest');
});

it('never applies a button colour: the New chat pill stays the stylesheet white, old saved values are ignored and cleared', () => {
  localStorage.setItem('praxis-button-color', '#f4846b');
  runBootstrap();
  applySidebarLook('plum');
  for (const name of ['--nb-fill', '--nb-ink', '--nb-border']) expect(snapshot().vars[name]).toBe('');
  expect(document.documentElement.dataset.buttonColor).toBeUndefined();
  syncSidebarLook();
  expect(localStorage.getItem('praxis-button-color')).toBeNull();
  const css = readFileSync('apps/web/src/styles/tokens.css', 'utf8');
  expect(css).toContain('--nb-fill: #ffffff;');
  expect(css).toContain('--nb-ink: #1c1c1c;');
});

it('falls back to Graphite for a missing or invalid saved palette', () => {
  localStorage.setItem('praxis-sidebar-palette', 'neon');
  runBootstrap();
  expect(snapshot().palette).toBe('graphite');
  expect(snapshot().vars['--sb-base']).toBe('#16181b');
});

it('still applies the current session choice when persistence is blocked', () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  setSidebarPalette('sand');
  expect(readPalette()).toBe('sand');
  expect(document.documentElement.style.getPropertyValue('--sb-ink')).toBe('#1c1c1c');
});

it('applies a look saved in another tab even when no Settings control is mounted', () => {
  syncSidebarLook();
  localStorage.setItem('praxis-sidebar-palette', 'plum');
  window.dispatchEvent(new StorageEvent('storage', { key: 'praxis-sidebar-palette' }));
  expect(readPalette()).toBe('plum');
  expect(document.documentElement.style.getPropertyValue('--sb-base')).toBe('#261530');
  // The removed button colour's key changes nothing.
  localStorage.setItem('praxis-button-color', '#f4846b');
  window.dispatchEvent(new StorageEvent('storage', { key: 'praxis-button-color' }));
  expect(document.documentElement.style.getPropertyValue('--nb-fill')).toBe('');
});
