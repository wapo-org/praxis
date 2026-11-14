import { describe, expect, it } from 'vitest';
import { copyText, fenceLines, fencePlan, parseFence } from './codeFence';

describe('fence info string (WP-N2)', () => {
  it('reads a title, highlighted lines, line numbers and a start line', () => {
    const f = parseFence('ts', 'title="src/app ts/a.ts" {2,5-7} showLineNumbers startLine=40');
    expect(f).toMatchObject({ kind: 'code', language: 'ts', codeLanguage: 'ts', title: 'src/app ts/a.ts', lineNumbers: true, startLine: 40, destructive: false });
    expect([...f.highlight]).toEqual([2, 5, 6, 7]);
    expect(parseFence('py', 'startLine=12')).toMatchObject({ lineNumbers: true, startLine: 12 });
    expect(parseFence('ts', 'showLineNumbers{9}')).toMatchObject({ lineNumbers: true, startLine: 9 });
    expect(parseFence('ts', "title='a.ts'").title).toBe('a.ts');
    expect(parseFence('ts', '').label).toBe('ts');
    expect(parseFence('ts', 'title="src/ap').title).toBe('src/ap');
  });
  it('diff: +/- lines are added/removed without their marker, and the language after diff colours the code', () => {
    const f = parseFence('diff', 'ts');
    expect(f).toMatchObject({ kind: 'diff', codeLanguage: 'ts', label: 'diff · ts' });
    const lines = fenceLines('@@ -1 +1 @@\n context\n-old()\n+new()\nbare', f);
    expect(lines.map((l) => [l.variant, l.role ?? '', l.text])).toEqual([
      ['default', 'meta', '@@ -1 +1 @@'], ['default', '', 'context'], ['removed', '', 'old()'], ['added', '', 'new()'], ['default', '', 'bare'],
    ]);
    expect(fencePlan(f, () => lines).languages).toEqual(['typescript']);
    expect(fencePlan(parseFence('diff'), () => lines).languages).toEqual([]);
    expect(fenceLines('--- a/x\n+++ b/x', f).map((l) => l.role)).toEqual(['meta', 'meta']);
    expect(copyText('-a\n+b', f)).toBe('-a\n+b');
  });
  it('terminal: $ lines are commands with a prompt, the rest is output; copy takes the commands', () => {
    for (const language of ['terminal', 'console', 'shell-session']) expect(parseFence(language).kind).toBe('terminal');
    const f = parseFence('terminal');
    const lines = fenceLines('$ npm test\n\u001b[32mok\u001b[0m\n$ ls', f);
    expect(lines.map((l) => [l.role, l.prompt ?? '', l.text])).toEqual([['command', '$ ', 'npm test'], ['output', '', '\u001b[32mok\u001b[0m'], ['command', '$ ', 'ls']]);
    const plan = fencePlan(f, () => lines);
    expect([plan.lineLanguage!(0), plan.lineLanguage!(1)]).toEqual(['bash', 'ansi']);
    expect(copyText('$ npm test\nok\n$ ls', f)).toBe('npm test\nls');
    expect(f.label).toBe('Terminal');
  });
  it('ansi, text and error', () => {
    expect(parseFence('ansi')).toMatchObject({ kind: 'ansi', codeLanguage: 'ansi' });
    expect(copyText('\u001b[31mred\u001b[0m', parseFence('ansi'))).toBe('red');
    expect(parseFence('text')).toMatchObject({ kind: 'text', codeLanguage: '', label: undefined });
    expect(parseFence('')).toMatchObject({ kind: 'text', label: undefined });
    expect(parseFence('error')).toMatchObject({ kind: 'text', destructive: true, label: 'Error' });
    expect(parseFence('log', 'title="Error: build failed"')).toMatchObject({ destructive: true, title: 'Error: build failed' });
    expect(parseFence('log', 'title="Errors.md"').destructive).toBe(false);
  });
});
