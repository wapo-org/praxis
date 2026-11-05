import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
      'Content.tsx',
      'PlusTray.tsx',
      'Sidebar.tsx',
      'SubContent.tsx',
      'Trigger.tsx',
      'primitives.tsx',
    ]);
  });
  it('never turns the stretch off', () => {
    for (const file of uses) expect(readFileSync(file, 'utf8'), file).not.toMatch(/<GlassSurface[^>]*\bstretch=\{false\}/);
  });
});
