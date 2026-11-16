import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DISABLED_RULES, RULES, checkDocFile, checkFile } from './check-rules-checks.mjs';
import { run } from './check-rules.mjs';

function rulesFor(file, text, enabled) {
  return checkFile(file, text, enabled).map((violation) => violation.rule);
}

describe('R1.web-effects', () => {
  const dirty = [
    "import React, { useEffect, useLayoutEffect } from 'react';",
    'export function Card() {',
    '  useEffect(() => {}, []);',
    '  useLayoutEffect(() => {}, []);',
    '  React.useEffect(() => {}, []);',
    '  setTimeout(() => {}, 10);',
    '  window.setInterval(() => {}, 10);',
    '  requestAnimationFrame(() => {});',
    '  globalThis.requestIdleCallback(() => {});',
    '  return null;',
    '}',
  ].join('\n');

  it('flags raw effects and timers in components, with the hook pattern in the message', () => {
    const found = checkFile('apps/web/src/components/chat/Card.tsx', dirty);
    expect(found.map((violation) => violation.rule)).toEqual(Array(7).fill(RULES.webEffects));
    expect(found.map((violation) => violation.line)).toEqual([3, 4, 5, 6, 7, 8, 9]);
    expect(found[0].message).toContain('raw useEffect in components/');
    expect(found[0].message).toContain('`use*` hook under apps/web/src/hooks/');
  });

  it('allows them in hooks/, lib/, state/ and in component tests', () => {
    for (const file of ['hooks/useCard.ts', 'lib/timers.ts', 'state/useRun.ts', 'components/chat/Card.test.tsx']) {
      expect(rulesFor(`apps/web/src/${file}`, dirty)).toEqual([]);
    }
  });

  it('ignores look-alike methods and custom hooks', () => {
    const clean = [
      'export function Card() {',
      '  useAutoFocus(ref);',
      '  scheduler.setTimeout(tick, 10);',
      '  clearTimeout(handle);',
      '  return null;',
      '}',
    ].join('\n');
    expect(rulesFor('apps/web/src/components/chat/Card.tsx', clean)).toEqual([]);
  });
});

describe('rules that are off by default', () => {
  const agentImport = "import { AgentRunner } from '@praxis/agent';\nimport { x } from '../../../packages/agent/src/x.js';\n";
  const tenantLeak = [
    "import { Redis } from '@upstash/redis';",
    "import { deriveTenantId } from '@praxis/types';",
    'export async function touch(redis, userId, secret) {',
    '  await redis.set(`seen:${userId}`, 1);',
    '  await track(userId);',
    '  const tenant = await deriveTenantId(userId, secret);',
    '  await redis.set(`seen:${tenant}`, 1);',
    '}',
  ].join('\n');

  it('names the issue each one waits for', () => {
    expect(DISABLED_RULES).toEqual({ [RULES.apiImportsAgent]: 'PRA-13', [RULES.tenantIdBoundary]: 'PRA-36' });
  });

  it('R1.api-imports-agent stays silent until enabled, then flags apps/api production imports only', () => {
    expect(rulesFor('apps/api/src/execution.ts', agentImport)).toEqual([]);
    const enabled = [RULES.apiImportsAgent];
    expect(rulesFor('apps/api/src/execution.ts', agentImport, enabled)).toEqual(Array(2).fill(RULES.apiImportsAgent));
    expect(rulesFor('apps/api/src/execution.test.ts', agentImport, enabled)).toEqual([]);
    expect(rulesFor('convex/turn.ts', agentImport, enabled)).toEqual([]);
  });

  it('R4.tenant-id-boundary stays silent until enabled, then flags a raw owner id beside an external SDK', () => {
    expect(rulesFor('apps/api/src/adapters/seen.ts', tenantLeak)).toEqual([]);
    const enabled = [RULES.tenantIdBoundary];
    const found = checkFile('apps/api/src/adapters/seen.ts', tenantLeak, enabled);
    expect(found.map((violation) => [violation.rule, violation.line])).toEqual([
      [RULES.tenantIdBoundary, 4],
      [RULES.tenantIdBoundary, 5],
    ]);
    expect(found[0].message).toContain('deriveTenantId(userId, secret)');
    const noSdk = tenantLeak.replace("import { Redis } from '@upstash/redis';", '');
    expect(rulesFor('apps/api/src/adapters/seen.ts', noSdk, enabled)).toEqual([]);
    expect(rulesFor('apps/web/src/lib/seen.ts', tenantLeak, enabled)).not.toContain(RULES.tenantIdBoundary);
  });
});

describe('R5.docs-commit', () => {
  it('allows the named documents and everything under cloud/docs', () => {
    const allowed = [
      'README.md',
      'ARCHITECTURE.md',
      'DEPLOY.md',
      '../AGENTS.md',
      '../README.md',
      'packages/protocol/PROTOCOL.md',
      'apps/web/DESIGN.md',
      'docs/function-maps/api.md',
      'docs/notes/anything.md',
      'apps/api/src/app.ts',
    ];
    for (const file of allowed) expect(checkDocFile(file), file).toBeNull();
  });

  it('flags status, plan and summary documents at the repo root and under cloud/', () => {
    const banned = ['../PLAN.md', '../SUMMARY.md', 'STATUS.md', 'apps/api/WP-J1-DESIGN.md', 'apps/web/docs/NOTES.md'];
    for (const file of banned) {
      const violation = checkDocFile(file);
      expect(violation, file).toMatchObject({ rule: RULES.docsCommit, path: file, line: 1 });
      expect(violation.message).toContain('Linear');
    }
  });
});

describe('CLI with the new rules', () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files) {
    const root = mkdtempSync(path.join(tmpdir(), 'check-rules-boundaries-'));
    roots.push(root);
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    return root;
  }

  function runIn(root, ...args) {
    const lines = [];
    const code = run(['--root', root, ...args], (line) => lines.push(line));
    return { code, lines };
  }

  it('ratchets a new markdown file and a new raw effect, and --enable turns on a disabled rule', () => {
    const root = fixture({
      'README.md': '# ok\n',
      'apps/web/src/components/Old.tsx': 'export const Old = () => { useEffect(() => {}, []); return null; };\n',
      'apps/api/src/run.ts': "import { AgentRunner } from '@praxis/agent';\nexport const runner = AgentRunner;\n",
    });
    expect(runIn(root, '--update-baseline').code).toBe(0);
    expect(runIn(root).code).toBe(0);

    writeFileSync(path.join(root, 'STATUS.md'), '# done\n');
    writeFileSync(path.join(root, 'apps/web/src/components/New.tsx'), 'export const New = () => { setTimeout(() => {}, 1); return null; };\n');
    const failed = runIn(root);
    expect(failed.code).toBe(1);
    expect(failed.lines.filter((line) => line.includes(' R'))).toEqual([
      expect.stringContaining('apps/web/src/components/New.tsx:1 R1.web-effects raw setTimeout'),
      expect.stringContaining('STATUS.md:1 R5.docs-commit'),
    ]);

    rmSync(path.join(root, 'STATUS.md'));
    rmSync(path.join(root, 'apps/web/src/components/New.tsx'));
    const enabled = runIn(root, '--enable', RULES.apiImportsAgent);
    expect(enabled.code).toBe(1);
    expect(enabled.lines[0]).toContain('apps/api/src/run.ts:1 R1.api-imports-agent');
    expect(runIn(root, '--enable', RULES.noAny).code).toBe(2);
  });
});
