import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { squirclePath } from './squircle';
import { PAPER_DARK, PAPER_LIGHT, popIn, press, resolvePreset, sheet, SPRING } from './index';

const here = new URL('.', import.meta.url).pathname;
const tokensCss = readFileSync(join(here, '../../../apps/web/src/styles/tokens.css'), 'utf8');
const block = (selector: string) => {
  const start = tokensCss.indexOf(`${selector} {`);
  return tokensCss.slice(start, tokensCss.indexOf('\n}', start));
};
const KEYS: Record<keyof typeof PAPER_LIGHT, string> = {
  paper: '--color-paper', surface: '--color-surface', ink: '--color-ink', ink2: '--color-ink-2',
  ink3: '--color-ink-3', fill1: '--color-fill-1', fill2: '--color-fill-2',
  success: '--color-success', danger: '--color-danger',
};
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe('@praxis/glass design system', () => {
  it('keeps tokens.css on the iOS Paper palette in light and dark', () => {
    const light = block("[data-theme='light']");
    const dark = block("[data-theme='dark']");
    for (const [key, cssVar] of Object.entries(KEYS)) {
      expect(light).toContain(`${cssVar}: ${PAPER_LIGHT[key as keyof typeof KEYS]};`);
      expect(dark).toContain(`${cssVar}: ${PAPER_DARK[key as keyof typeof KEYS]};`);
    }
  });

  it('ships dark glass tints that are actually dark', () => {
    const dark = block("[data-theme='dark']");
    for (const recipe of ['regular', 'thick', 'clear']) {
      const match = dark.match(new RegExp(`--glass-${recipe}-tint: rgba\\((\\d+), (\\d+), (\\d+)`));
      expect(match, recipe).not.toBeNull();
      expect(Math.max(...match!.slice(1).map(Number))).toBeLessThan(64);
    }
  });


  it('uses the spring family and collapses presets to a fade under reduced motion', () => {
    expect(popIn.transition).toBe(SPRING);
    expect(sheet.transition).toBe(SPRING);
    expect(press.whileTap.scale).toBe(0.97);
    expect(resolvePreset(popIn, true).initial).toEqual({ opacity: 0 });
    expect(resolvePreset(popIn, false)).toBe(popIn);
  });

  it('has no WebGL, DOM capture, rAF loop or animated blur; canvas only builds the lens maps', () => {
    for (const file of files(here).filter((f) => /\.(tsx?|css)$/.test(f) && !/test|\.pw\./.test(f))) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/WebGL|webgl|html2canvas|drawWindow|requestAnimationFrame\((tick|loop|frame|render|draw)|<canvas/);
      expect(src, file).not.toMatch(/transition:[^;]*backdrop-filter/);
      if (!file.endsWith('displacement-map.ts')) expect(src, file).not.toMatch(/getContext\(/);
    }
  });
});

describe('continuous corners', () => {
  it('a squircle path spans the radius, closes, and stays inside the box', () => {
    const path = squirclePath(200, 120, 42);
    expect(path.startsWith('M')).toBe(true);
    expect(path.endsWith('Z')).toBe(true);
    const points = path.slice(1, -1).split('L').map((point) => point.split(' ').map(Number));
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(200);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(120);
    }
    // The corner's apex is cut by the measured amount: 22 % of the span.
    const apex = Math.min(...points.map(([x, y]) => Math.hypot(x!, y!)));
    expect(apex / Math.SQRT2 / 42).toBeCloseTo(0.2227, 1);
    // Clamped on a small box.
    expect(() => squirclePath(30, 20, 42)).not.toThrow();
  });
  it('all glass reads the corner and radius tokens', () => {
    const css = readFileSync(join(here, 'glass.module.css'), 'utf8');
    expect(css).toContain('corner-shape: var(--glass-corner)');
    expect(css).toContain('border-radius: var(--glass-radius-round, var(--glass-radius))');
    expect(tokensCss).toContain('--glass-corner: superellipse(1.46)');
  });
});

describe('the more transparent glass keeps AA over paper', () => {
  const lin = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const lum = ([r, g, b]: number[]) => 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
  const hex = (value: string) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
  const contrast = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  it.each([["[data-theme='light']", PAPER_LIGHT], ["[data-theme='dark']", PAPER_DARK]] as const)('%s', (selector, paper) => {
    const theme = block(selector);
    const page = hex(paper.paper);
    for (const name of ['regular', 'thick', 'menu', 'clear']) {
      const hit = new RegExp(`--glass-${name}-tint: rgba\\(([\\d., ]+)\\)`).exec(theme)!;
      const [r, g, b, a] = hit[1]!.split(',').map(Number) as [number, number, number, number];
      const over = [r, g, b].map((v, i) => v * a + page[i]! * (1 - a));
      expect(contrast(hex(paper.ink), over), name).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(paper.ink2), over), name).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('every GlassSurface stretches', () => {
  const root = join(here, '../../..');
  const uses = [...files(join(root, 'apps/web/src')), ...files(here)].filter(
    (file) => /\.tsx$/.test(file) && !/\.test\.|\/lab\//.test(file) && /<GlassSurface\b/.test(readFileSync(file, 'utf8')),
  );
  it('knows every use, so a new one has to be looked at', () => {
    expect(uses.map((file) => file.slice(file.lastIndexOf('/') + 1)).sort()).toEqual([
      'ChatHeader.tsx',
      'Composer.tsx',
      'ConsentPopover.tsx',
      'GlassMorph.tsx',
      'Sidebar.tsx',
      'Trigger.tsx',
      'primitives.tsx',
    ]);
  });
  it('never turns the stretch off', () => {
    for (const file of uses) expect(readFileSync(file, 'utf8'), file).not.toMatch(/<GlassSurface[^>]*\bstretch=\{false\}/);
  });
});
