// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACCENTS, readAccent, setAccent } from './accent';
const tokens = readFileSync('apps/web/src/styles/tokens.css', 'utf8').split(
  '/* Accent palette:',
)[1]!;
const luminance = (hex: string) =>
  hex
    .slice(1)
    .match(/../g)!
    .map((v) => parseInt(v, 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
const contrast = (a: string, b: string) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
};
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    clear: () => data.clear(),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-accent');
});
it('all six palette choices have AA button text and links in both themes, with the highest contrast on-colour', () => {
  for (const theme of ['light', 'dark']) {
    const block = tokens.match(new RegExp(`data-theme='${theme}'\\] \\{([\\s\\S]*?)\\}`))![1]!;
    for (const id of ACCENTS) {
      const color = block.match(new RegExp(`--accent-${id}: (#[\\da-f]+)`))![1]!;
      const on = block.match(new RegExp(`--accent-${id}-on: (#[\\da-f]+)`))![1]!;
      expect(contrast(color, on)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color, theme === 'light' ? '#fbfbf9' : '#0b0b0a')).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrast(color, on)).toBe(
        Math.max(contrast(color, '#15140f'), contrast(color, '#fbfbf9')),
      );
    }
  }
});
it('persists immediately and applies the saved accent in the pre-paint bootstrap', () => {
  setAccent('violet');
  expect(readAccent()).toBe('violet');
  expect(localStorage.getItem('praxis-accent')).toBe('violet');
  document.documentElement.removeAttribute('data-accent');
  const html = readFileSync('apps/web/index.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
  new Function('localStorage', 'document', 'window', 'performance', script)(
    localStorage,
    document,
    { matchMedia: () => ({ matches: false }) },
    { mark: () => {} },
  );
  expect(document.documentElement.dataset.accent).toBe('violet');
});
it('still applies the current session choice when persistence is blocked', () => {
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw Error('blocked');
  });
  setAccent('blue');
  expect(readAccent()).toBe('blue');
});
