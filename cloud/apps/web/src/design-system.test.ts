import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
const sources = [...files(join(__dirname)), ...files(join(__dirname, '../../../packages/glass/src'))].filter(
  (f) => /\.(tsx?|css)$/.test(f) && !/\.test\.|\.pw\.|\/lab\/|tokens\.css$|motion\.ts$/.test(f),
);

describe('design system guard rails', () => {
  it('trailing icons share one weight: outline at the 1.75 stroke, 16 px, state by colour, never a fill', () => {
    for (const file of sources.filter((name) => name.endsWith('.tsx'))) {
      const src = readFileSync(file, 'utf8');
      // Check and Star are the trailing state icons in menus and lists.
      expect(src, file).not.toMatch(/<(Check|Star)\b[^>]*\bfill=/);
      for (const size of src.matchAll(/<(?:Check|Star)\b[^>]*\bsize=\{(\d+)\}/g)) expect(Number(size[1]), `${file}: ${size[0]}`).toBe(16);
    }
  });

  it('small labels are ink-2: ink-3 at 11 px does not hold AA on paper', () => {
    for (const file of sources.filter((name) => name.endsWith('.css'))) {
      for (const rule of readFileSync(file, 'utf8').match(/\{[^{}]*\}/g) ?? []) {
        expect(rule.includes('var(--text-xs)') && rule.includes('var(--color-ink-3)'), `${file}: ${rule}`).toBe(false);
      }
    }
  });

  it('has no ad-hoc durations, easings or springs outside tokens.css and motion.ts', () => {
    for (const file of sources) {
      const src = readFileSync(file, 'utf8').replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '');
      expect(src, file).not.toMatch(/\b\d+(\.\d+)?m?s\s+(ease|linear|cubic)|cubic-bezier\(|stiffness:|duration:\s*0?\.\d/);
    }
  });

  it('uses one icon family and never animates backdrop-filter', () => {
    for (const file of sources) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toContain('@tabler/icons-react');
      expect(src, file).not.toMatch(/transition[^;\n]*backdrop-filter|animate=\{\{[^}]*backdropFilter/);
    }
    expect(readFileSync(join(__dirname, '../package.json'), 'utf8')).not.toContain('@tabler');
  });

  it('keeps the Lab out of the main chat chrome', () => {
    expect(readFileSync(join(__dirname, 'components/chat/ChatHeader.tsx'), 'utf8')).not.toMatch(/Lab|Flask/);
  });
});
