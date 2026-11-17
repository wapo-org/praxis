import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FILE_LENGTH_MAX, RULES, checkFile, countLines } from './check-rules-checks.mjs';
import { buildBaseline, compareToBaseline, formatViolation, parseBaseline, run } from './check-rules.mjs';

function rulesFor(file, text) {
  return checkFile(file, text).map((violation) => violation.rule);
}

describe('R1 layer imports', () => {
  it('protocol may import only zod and its own files', () => {
    const clean = "import { z } from 'zod';\nexport * from './events.js';\n";
    expect(rulesFor('packages/protocol/src/index.ts', clean)).toEqual([]);

    const dirty = [
      "import { Hono } from 'hono';",
      "import { api } from '../../../apps/api/src/app.js';",
      "import { v } from 'convex/values';",
      "const lazy = await import('@upstash/redis');",
    ].join('\n');
    const found = checkFile('packages/protocol/src/index.ts', dirty);
    expect(found.map((violation) => violation.rule)).toEqual(Array(4).fill(RULES.protocolImports));
    expect(found.map((violation) => violation.line)).toEqual([1, 2, 3, 4]);
  });

  it('protocol tests may use vitest, production files may not', () => {
    const text = "import { it } from 'vitest';\n";
    expect(rulesFor('packages/protocol/src/index.test.ts', text)).toEqual([]);
    expect(rulesFor('packages/protocol/src/index.ts', text)).toEqual([RULES.protocolImports]);
  });

  it('agent rejects runtime SDKs but allows protocol and node builtins', () => {
    const clean = "import { RunSchema } from '@praxis/protocol';\nimport { createHash } from 'node:crypto';\n";
    expect(rulesFor('packages/agent/src/runner.ts', clean)).toEqual([]);

    const dirty = [
      "import { Hono } from 'hono';",
      "import { waitUntil } from '@vercel/functions';",
      "import { ConvexHttpClient } from 'convex/browser';",
      "import { Redis } from '@upstash/redis';",
      "import { store } from '../../../convex/store.js';",
    ].join('\n');
    expect(rulesFor('packages/agent/src/runner.ts', dirty)).toEqual(Array(5).fill(RULES.agentImports));
  });

  it('web rejects server SDKs and server code, but not look-alike packages or tests', () => {
    const clean = [
      "import { ChatSchema } from '@praxis/protocol';",
      "import { tokens } from '@praxis/glass';",
      "import { useQuery } from 'convex/react';",
      "import { api } from '../../../convex/_generated/api.js';",
      "import { honorific } from 'honorifics';",
    ].join('\n');
    expect(rulesFor('apps/web/src/app.tsx', clean)).toEqual([]);

    const dirty = [
      "import { Hono } from 'hono';",
      "import { createApp } from '../../api/src/app.js';",
      "import { query } from 'convex/server';",
      "import { pool } from '@praxis/credentials';",
    ].join('\n');
    expect(rulesFor('apps/web/src/app.tsx', dirty)).toEqual(Array(4).fill(RULES.webImports));
    expect(rulesFor('apps/web/src/app.test.tsx', dirty)).toEqual([]);
  });

  it('credentials: numbered or runtime-built env keys only inside packages/credentials', () => {
    const dirty = [
      'const second = process.env.OPENAI_API_KEY_2;',
      "const third = env['MODAL_TOKEN_3'];",
      'for (let n = 1; n < 4; n += 1) keys.push(process.env[`EXA_KEY_${n}`]);',
      "const built = c.env['KEY_' + index];",
    ].join('\n');
    expect(rulesFor('apps/api/src/keys.ts', dirty)).toEqual(Array(4).fill(RULES.credentialsPool));
    expect(rulesFor('packages/credentials/src/env.ts', dirty)).toEqual([]);

    const clean = 'const key = process.env.OPENAI_API_KEY;\nconst named = env[name];\nconst v2 = config.KEY_2;\n';
    expect(rulesFor('apps/api/src/keys.ts', clean)).toEqual([]);
  });
});

describe('R3 file length', () => {
  it('flags files over the limit with their line count', () => {
    const atLimit = 'x\n'.repeat(FILE_LENGTH_MAX);
    expect(countLines(atLimit)).toBe(FILE_LENGTH_MAX);
    expect(rulesFor('packages/sync/src/a.ts', atLimit)).toEqual([]);

    const [violation] = checkFile('packages/sync/src/a.ts', `${atLimit}x\n`);
    expect(violation).toMatchObject({ rule: RULES.fileLength, lines: FILE_LENGTH_MAX + 1 });
    expect(countLines('a\nb')).toBe(2);
  });
});

describe('R4 type discipline', () => {
  it('flags every raw any in TypeScript, tests included, but not the word in strings or comments', () => {
    const dirty = [
      'const a = input as any;',
      'function f(value: any) { return value; }',
      'const b = <any>input;',
      'const c: Record<string, any> = {};',
    ].join('\n');
    expect(rulesFor('apps/api/src/x.ts', dirty)).toEqual(Array(4).fill(RULES.noAny));
    expect(rulesFor('apps/api/src/x.test.ts', 'const a = input as any;')).toEqual([RULES.noAny]);

    const clean = "// as any would be wrong\nconst text = 'value: any';\nconst many = anyOf(company);\n";
    expect(rulesFor('apps/api/src/x.ts', clean)).toEqual([]);
    expect(rulesFor('scripts/tool.mjs', 'const any = 1;')).toEqual([]);
  });

  it('flags v.any() only under convex/', () => {
    const text = "import { v } from 'convex/values';\nexport const shape = { value: v.any() };\n";
    expect(rulesFor('convex/schema.ts', text)).toEqual([RULES.convexVAny]);
    expect(rulesFor('apps/api/src/schema.ts', text)).toEqual([]);
    expect(rulesFor('convex/schema.ts', 'export const shape = { value: v.string() };')).toEqual([]);
  });
});

describe('R5 security', () => {
  it('bans execution primitives in apps/api but not method calls named eval', () => {
    const dirty = [
      "import { spawn } from 'node:child_process';",
      "import vm from 'vm';",
      "const { Worker } = await import('node:worker_threads');",
      "const out = eval('1 + 1');",
      "const fn = new Function('return 1');",
    ].join('\n');
    expect(rulesFor('apps/api/src/run.ts', dirty)).toEqual(Array(5).fill(RULES.bannedPrimitives));
    expect(rulesFor('packages/sync/src/run.ts', dirty)).toEqual([]);

    const clean = "await redis.eval(SCRIPT, [key], [token]);\nconst note = 'eval(x) and new Function are banned';\n";
    expect(rulesFor('apps/api/src/redis.ts', clean)).toEqual([]);
  });

  it('flags public Convex functions taking a client owner id, including through spreads', () => {
    const dirty = [
      "import { v } from 'convex/values';",
      "import { query, mutation, internalMutation } from './functions.js';",
      'const scope = { serverToken: v.string(), userId: v.string() };',
      'const address = { ...scope, id: v.string() };',
      'const args = { ownerId: v.string() };',
      'export const direct = query({ args: { userId: v.string() }, handler: async () => null });',
      'export const spread = mutation({ args: { ...address, value: v.string() }, handler: async () => null });',
      'export const shorthand = query({ args, handler: async () => null });',
      'export const internal = internalMutation({ args: scope, handler: async () => null });',
      'export const clean = query({ args: { id: v.string() }, handler: async () => null });',
      'export const trustedQuery = serverQuery({ args: scope, handler: async () => null });',
      'export const trustedMutation = serverMutation({ args: scope, handler: async () => null });',
      'export const trustedAction = serverAction({ args: scope, handler: async () => null });',
    ].join('\n');
    const found = checkFile('convex/store.ts', dirty);
    expect(found.map((violation) => [violation.rule, violation.line])).toEqual([
      [RULES.clientOwnerArg, 6],
      [RULES.clientOwnerArg, 7],
      [RULES.clientOwnerArg, 8],
    ]);
    expect(rulesFor('apps/api/src/store.ts', dirty)).toEqual([]);
  });
});

describe('ratchet baseline', () => {
  const anyHit = (file, line) => ({ rule: RULES.noAny, path: file, line, message: 'raw any' });
  const longFile = (file, lines) => ({ rule: RULES.fileLength, path: file, line: lines, lines, message: 'long' });
  const directories = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function fixture(files) {
    const root = mkdtempSync(path.join(tmpdir(), 'check-rules-'));
    directories.push(root);
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

  it('stores counts per path and rule, and line counts for file length', () => {
    const baseline = buildBaseline([anyHit('a.ts', 1), anyHit('a.ts', 9), longFile('b.ts', 512)]);
    expect(baseline.rules).toEqual({ [RULES.fileLength]: { 'b.ts': 512 }, [RULES.noAny]: { 'a.ts': 2 } });
    expect(parseBaseline(JSON.stringify(baseline))).toEqual(baseline);
    expect(() => parseBaseline('{"version":99,"rules":{}}')).toThrow(/unsupported baseline/);
  });

  it('passes on baselined violations and reports improvements as stale', () => {
    const baseline = buildBaseline([anyHit('a.ts', 1), anyHit('a.ts', 9), longFile('b.ts', 512)]);
    const same = compareToBaseline([anyHit('a.ts', 4), anyHit('a.ts', 30), longFile('b.ts', 512)], baseline);
    expect(same).toEqual({ failures: [], stale: [] });

    const better = compareToBaseline([anyHit('a.ts', 4), longFile('b.ts', 450)], baseline);
    expect(better.failures).toEqual([]);
    expect(better.stale.map((entry) => entry.path)).toEqual(['b.ts', 'a.ts']);
  });

  it('fails on a new path, a higher count, or a baselined file that grows', () => {
    const baseline = buildBaseline([anyHit('a.ts', 1), longFile('b.ts', 512)]);
    const newPath = compareToBaseline([anyHit('a.ts', 1), anyHit('c.ts', 2)], baseline);
    expect(newPath.failures.map(formatViolation)).toEqual(['c.ts:2 R4.no-any raw any']);

    const more = compareToBaseline([anyHit('a.ts', 1), anyHit('a.ts', 7)], baseline);
    expect(more.failures).toHaveLength(2);
    expect(more.failures[0].message).toContain('2 in file, baseline allows 1');

    const grew = compareToBaseline([longFile('b.ts', 513)], baseline);
    expect(grew.failures.map((failure) => failure.message)).toEqual(['long [grew from baseline 512]']);
  });

  it('CLI: update writes the baseline, then only new violations fail', () => {
    const root = fixture({
      'apps/api/src/old.ts': 'export const old = input as any;\n',
      'node_modules/pkg/index.ts': 'export const ignored = input as any;\n',
    });
    expect(runIn(root).code).toBe(2);
    expect(runIn(root, '--update-baseline').code).toBe(0);
    const written = JSON.parse(readFileSync(path.join(root, 'check-rules.baseline.json'), 'utf8'));
    expect(written.rules).toEqual({ [RULES.noAny]: { 'apps/api/src/old.ts': 1 } });
    expect(runIn(root).code).toBe(0);

    writeFileSync(path.join(root, 'apps/api/src/new.ts'), "import 'node:vm';\n");
    const failed = runIn(root);
    expect(failed.code).toBe(1);
    expect(failed.lines[0]).toBe('apps/api/src/new.ts:1 R5.banned-primitives import "node:vm" is banned in apps/api');

    writeFileSync(path.join(root, 'apps/api/src/new.ts'), 'export const fine = 1;\n');
    writeFileSync(path.join(root, 'apps/api/src/old.ts'), 'export const old = 1;\n');
    const improved = runIn(root);
    expect(improved.code).toBe(0);
    expect(improved.lines.join('\n')).toContain('1 baseline entr(ies) improved');
  });

  it('CLI: --baseline compares against another file and rejects unknown flags', () => {
    const root = fixture({ 'apps/api/src/old.ts': 'export const old = input as any;\n' });
    runIn(root, '--update-baseline');
    const empty = path.join(root, 'empty.json');
    writeFileSync(empty, JSON.stringify(buildBaseline([])));
    expect(runIn(root, '--baseline', empty).code).toBe(1);
    expect(runIn(root, '--nope').code).toBe(2);
  });
});
