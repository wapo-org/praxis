// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  BUTTON_COLORS,
  SIDEBAR_PALETTES,
  applySidebarLook,
  buttonVars,
  luminance,
  paletteVars,
  readButton,
  readPalette,
  setButtonColor,
  setSidebarPalette,
} from './sidebarPalette';

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
const VARS = ['--sb-bg', '--sb-base', '--sb-border', '--sb-ink', '--sb-mute', '--sb-hl', '--sb-line', '--nb-fill', '--nb-ink', '--nb-border'];
const snapshot = () => {
  const root = document.documentElement;
  return {
    palette: root.dataset.sidebarPalette,
    button: root.dataset.buttonColor,
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
  delete document.documentElement.dataset.buttonColor;
});

it('ports PAL, BP and grad() from the owner source exactly', () => {
  expect(SIDEBAR_PALETTES.map((p) => [p.name, p.base, p.border, p.dark])).toEqual([
    ['Graphite', '#16181b', '#3d4147', true],
    ['Midnight', '#101c33', '#2f4570', true],
    ['Forest', '#12261d', '#2f5a45', true],
    ['Plum', '#261530', '#5a3a6b', true],
    ['Sand', '#e9e4d8', '#cfc8b6', false],
    ['Paper', '#fbfbf9', '#d9d9e0', false],
  ]);
  expect(BUTTON_COLORS.map((c) => [c.name, c.color])).toEqual([
    ['White', '#ffffff'],
    ['Cyan', '#79e0f8'],
    ['Navy', '#1d4056'],
    ['Gray', '#8d8d99'],
    ['Graphite', '#2b2e33'],
    ['Coral', '#f4846b'],
    ['Lime', '#b6e36b'],
  ]);
  // The owner's file, where present (it is outside the repo): grad() must be the same string.
  let source = '';
  try {
    source = readFileSync(`${process.env.HOME}/.praxis-agent-state/cloud/design/G4-ref/sidebar-design-source.html`, 'utf8');
  } catch {
    /* Not on this machine. */
  }
  const grad = /grad\(base\) \{ return '([^']+)' \+ base; \}/.exec(source)?.[1];
  if (grad) expect(paletteVars('plum')['--sb-bg']).toBe(grad + '#261530');
  expect(paletteVars('graphite')['--sb-bg']).toBe(
    'linear-gradient(to bottom,rgb(255 255 255/20%) 0%,rgb(255 255 255/12%) 2%,rgb(255 255 255/6%) 5%,rgb(255 255 255/2%) 9%,transparent 14%,rgb(0 0 0/12%) 100%),#16181b',
  );
});

it('derives button ink from the source inks and its border from color-mix', () => {
  expect(buttonVars('#79e0f8')).toEqual({ '--nb-fill': '#79e0f8', '--nb-ink': '#10242d', '--nb-border': 'color-mix(in srgb,#79e0f8,#000 18%)' });
  expect(buttonVars('#1d4056')['--nb-ink']).toBe('#ffffff');
  expect(buttonVars('#ffffff')).toEqual({ '--nb-fill': '#ffffff', '--nb-ink': '#1c1c1c', '--nb-border': 'transparent' });
  // The source's 0.35 switch everywhere except Gray, where its white ink is not AA.
  for (const { name, color } of BUTTON_COLORS.slice(1))
    expect(buttonVars(color)['--nb-ink']).toBe(name === 'Gray' || luminance(color) > 0.35 ? '#10242d' : '#ffffff');
});

it('keeps every sidebar text colour AA on all six palettes, anywhere on the doubled gloss', () => {
  // grad() as a function of height: white stops 20/12/6/2 % at 0/2/5/9 %, clear at 14 %, then black to 12 %.
  const gloss = (y: number) => {
    if (y >= 0.14) return { white: 0, black: (0.12 * (y - 0.14)) / 0.86 };
    const stops = [[0, 0.2], [0.02, 0.12], [0.05, 0.06], [0.09, 0.02], [0.14, 0]] as const;
    const i = stops.findIndex(([at]) => at > y);
    const [y0, a0] = stops[i - 1]!;
    const [y1, a1] = stops[i]!;
    return { white: a0 + ((a1 - a0) * (y - y0)) / (y1 - y0), black: 0 };
  };
  for (const p of SIDEBAR_PALETTES) {
    const vars = paletteVars(p.id);
    const hl = rgba(vars['--sb-hl']);
    // Text starts below the New chat pill (~9 % of the height) and ends at the footer's last line (~98 %).
    for (let y = 0.09; y <= 0.98; y += 0.01) {
      const { white, black } = gloss(y);
      // The aside paints the gloss twice over the base.
      let bg = hex(p.base);
      for (let layer = 0; layer < 2; layer++) bg = over([0, 0, 0], black, over([255, 255, 255], white, bg));
      for (const surface of [bg, over(hl.rgb, hl.a, bg), over([255, 255, 255], 0.12, bg)])
        expect(contrast(hex(vars['--sb-ink']), surface), `${p.name} ink at ${y.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(vars['--sb-mute']), bg), `${p.name} mute at ${y.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  }
  for (const { color } of BUTTON_COLORS) {
    const vars = buttonVars(color);
    expect(contrast(hex(vars['--nb-ink']), hex(color)), color).toBeGreaterThanOrEqual(4.5);
  }
});

it('persists both settings and the pre-paint bootstrap applies exactly what the module applies', () => {
  for (const p of SIDEBAR_PALETTES)
    for (const color of ['#ffffff', '#f4846b', '#123abc']) {
      applySidebarLook(p.id, color);
      const expected = snapshot();
      document.documentElement.removeAttribute('style');
      localStorage.setItem('praxis-sidebar-palette', p.id);
      localStorage.setItem('praxis-button-color', color);
      runBootstrap();
      expect(snapshot()).toEqual(expected);
    }
  setSidebarPalette('forest');
  setButtonColor('#B6E36B');
  expect(readPalette()).toBe('forest');
  expect(readButton()).toBe('#b6e36b');
  expect(localStorage.getItem('praxis-sidebar-palette')).toBe('forest');
  expect(localStorage.getItem('praxis-button-color')).toBe('#b6e36b');
});

it('falls back to Graphite and White for missing or invalid saved values', () => {
  localStorage.setItem('praxis-sidebar-palette', 'neon');
  localStorage.setItem('praxis-button-color', 'red');
  runBootstrap();
  expect(snapshot().palette).toBe('graphite');
  expect(snapshot().button).toBe('#ffffff');
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
