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
