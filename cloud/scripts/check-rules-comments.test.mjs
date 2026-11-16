import { describe, expect, it } from 'vitest';
import { RULES, checkFile } from './check-rules-checks.mjs';

function narratingLines(text, file = 'apps/api/src/thing.ts') {
  return checkFile(file, text)
    .filter((violation) => violation.rule === RULES.narratingComment)
    .map((violation) => violation.line);
}

describe('R3.narrating-comment', () => {
  it('flags a comment whose every word is already on the next line', () => {
    const text = [
      'let count = 0;',
      '// Set count to total',
      'count = total;',
      '// user id',
      'const userId = session.userId;',
      '// Return the fallback',
      'export const pick = () => fallback;',
      '// Consent Prompt',
      'const pendingConsentPrompt = null;',
      '// Increment retries',
      'retries += 1;',
    ].join('\n');
    expect(narratingLines(text)).toEqual([2, 4, 6, 8, 10]);
  });

  it('names the fix in the message', () => {
    const [violation] = checkFile('apps/api/src/thing.ts', '// user id\nconst userId = 1;\n');
    expect(violation).toMatchObject({ rule: RULES.narratingComment, path: 'apps/api/src/thing.ts', line: 1 });
    expect(violation.message).toContain('delete it, or say why');
  });

  it('keeps comments that add a reason, a constraint or any word the code lacks', () => {
    const text = [
      '// Convex caps a mutation at 8 MB, so count before writing.',
      'count = total;',
      '// Retry once: the first call warms the cache.',
      'retry();',
      '// Stale after a deploy',
      'const userId = session.userId;',
      '// eslint-disable-next-line no-console',
      'console.log(userId);',
      '// TODO(PRA-36): userId',
      'send(userId);',
    ].join('\n');
    expect(narratingLines(text)).toEqual([]);
  });

  it('leaves multi-line comments, trailing comments, docs and comment-like strings alone', () => {
    const text = [
      '// user id',
      '// kept apart from the tenant id on purpose',
      'const userId = session.userId;',
      'const tenantId = derive(userId); // tenant id',
      '/** user id */',
      'const other = userId;',
      'const template = `',
      '// user id',
      'const userId = 1;`;',
      '// user id',
      '',
      'const spaced = userId;',
    ].join('\n');
    expect(narratingLines(text)).toEqual([]);
  });

  it('runs on tests and plain JavaScript too', () => {
    expect(narratingLines('// user id\nconst userId = 1;\n', 'apps/web/src/a.test.tsx')).toEqual([1]);
    expect(narratingLines('// user id\nconst userId = 1;\n', 'scripts/tool.mjs')).toEqual([1]);
  });
});
