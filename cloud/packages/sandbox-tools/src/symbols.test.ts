import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {SealedSecret} from '@praxis/types';
import {approvalKey, ToolBoundaryError} from '@praxis/agent';
import {FakeSandboxPort, MemoryExportSink} from './fake.js';
import {sha256} from './support.js';
import {replaceSymbol} from './tools/symbols.js';
import {editFile} from './tools/files.js';
import {executeSandboxTool, sandboxToolClassifier} from './tools/registry.js';

const ROOT = '/workspace/chats/c1';
function setup(path: string, source: string) {
  const port = new FakeSandboxPort().writeText(`${ROOT}/${path}`, source);
  return {port, context: {port, root: ROOT, exports: new MemoryExportSink()}};
}
async function errorDetail(work: Promise<unknown>) {
  const error = await work.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(ToolBoundaryError);
  return (error as ToolBoundaryError).detail;
}

const GOLDENS = [
  {path: 'a.py', prefix: '# 🐍 café\r\n\r\n', old: 'def target(x):\r\n    return x + 1', next: 'def target(x):\r\n    return x + 2', suffix: '\r\n\r\ndef other():\r\n    pass\r\n'},
  {path: 'a.ts', prefix: '\ufeff// 😀\r\nexport ', old: 'function target(x: number): number { return x + 1; }', next: 'function target(x: number): number { return x + 2; }', suffix: '\r\nconst other = 3;\r\n'},
  {path: 'a.js', prefix: '// 😀\nexport default ', old: 'async function target(x) { return x + 1; }', next: 'async function target(x) { return x + 2; }', suffix: '\n// untouched\n'},
];

describe('replace_symbol grammar smoke and byte goldens', () => {
  for (const golden of GOLDENS) it(`preserves bytes outside a function in ${golden.path}`, async () => {
    const {port, context} = setup(golden.path, golden.prefix + golden.old + golden.suffix);
    const result = await replaceSymbol(context, {path: golden.path, symbol: 'target', new_text: golden.next});
    const expected = golden.prefix + golden.next + golden.suffix;
    expect(await port.readFile(`${ROOT}/${golden.path}`)).toEqual(new TextEncoder().encode(expected));
    expect(result.sha256).toBe(sha256(expected));
  });

  it.each(['a.tsx', 'a.jsx', 'a.mts', 'a.cts', 'a.mjs', 'a.cjs'])('loads the grammar for %s', async path => {
    const {port, context} = setup(path, path.endsWith('x') ? 'function target() { return <div/>; }' : 'function target() { return 1; }');
    await replaceSymbol(context, {path, symbol: 'target', new_text: 'function target() {}'});
    expect(port.readText(`${ROOT}/${path}`)).toBe('function target() {}');
  });

  it('preserves arbitrary Unicode comments outside the selected symbol', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({min: 0x20, max: 0x10ffff}).filter(n => n < 0xd800 || n > 0xdfff), {maxLength: 80}), async points => {
      const comment = JSON.stringify(String.fromCodePoint(...points)).replaceAll('\u2028', '').replaceAll('\u2029', '');
      const prefix = `// ${comment}\n`;
      const suffix = '\nfunction untouched() { return 3; }\n';
      const {port, context} = setup('a.js', prefix + 'function target() {}' + suffix);
      await replaceSymbol(context, {path: 'a.js', symbol: 'target', new_text: 'function target() { return 2; }'});
      expect(await port.readFile(`${ROOT}/a.js`)).toEqual(new TextEncoder().encode(prefix + 'function target() { return 2; }' + suffix));
    }), {numRuns: 60});
  });
});

describe('symbol resolution and safe failure', () => {
  it('lists missing and ambiguous candidates including duplicate qualified names and line numbers', async () => {
    const source = 'class A { target() {} }\nclass B { target() {} }\nfunction duplicate() {}\nfunction duplicate() {}';
    const {port, context} = setup('a.ts', source);
    expect(await errorDetail(replaceSymbol(context, {path: 'a.ts', symbol: 'target', new_text: ''}))).toMatchObject({code: 'conflict', message: expect.stringMatching(/A.target \(line 1\).*B.target \(line 2\)/)});
    expect(await errorDetail(replaceSymbol(context, {path: 'a.ts', symbol: 'duplicate', new_text: ''}))).toMatchObject({code: 'conflict'});
    expect(await errorDetail(replaceSymbol(context, {path: 'a.ts', symbol: 'missing', new_text: ''}))).toMatchObject({code: 'not-found', message: expect.stringContaining('Candidates: A')});
    expect(port.readText(`${ROOT}/a.ts`)).toBe(source);
    await replaceSymbol(context, {path: 'a.ts', symbol: 'A.target', new_text: 'target() { return 1; }'});
    expect(port.readText(`${ROOT}/a.ts`)).toContain('class B { target() {} }');
  });

  it('resolves nested Python definitions and includes decorators in the replacement range', async () => {
    const source = 'class A:\n    @staticmethod\n    def target():\n        def nested():\n            return 1\n        return nested()\n';
    const {port, context} = setup('a.py', source);
    await replaceSymbol(context, {path: 'a.py', symbol: 'A.target.nested', new_text: 'def nested():\n            return 2'});
    expect(port.readText(`${ROOT}/a.py`)).toBe(source.replace('return 1', 'return 2'));
    await replaceSymbol(context, {path: 'a.py', symbol: 'A.target', new_text: 'def target():\n        pass'});
    expect(port.readText(`${ROOT}/a.py`)).toBe('class A:\n    def target():\n        pass\n');
  });

  it('replaces classes and single arrow bindings as complete declarations', async () => {
    const {port, context} = setup('a.ts', 'export const target = () => 1;\nclass Other { run() {} }\n');
    await replaceSymbol(context, {path: 'a.ts', symbol: 'target', new_text: 'const target = () => 2;'});
    await replaceSymbol(context, {path: 'a.ts', symbol: 'Other', new_text: 'class Other {}'});
    expect(port.readText(`${ROOT}/a.ts`)).toBe('export const target = () => 2;\nclass Other {}\n');
  });

  it('refuses unsupported, missing, binary, oversized, internal and escaping files', async () => {
    const {port, context} = setup('a.rb', 'def target; end');
    port.files.set(`${ROOT}/binary.py`, new Uint8Array([0, 255]));
    port.writeText(`${ROOT}/huge.py`, 'x'.repeat(1_048_577));
    port.link(`${ROOT}/escape`, '/etc');
    for (const [path, code] of [['a.rb', 'schema'], ['missing.py', 'not-found'], ['binary.py', 'schema'], ['huge.py', 'budget'], ['.praxis/state.py', 'policy-denied'], ['../a.py', 'path-traversal'], ['escape/a.py', 'path-traversal']]) {
      expect(await errorDetail(replaceSymbol(context, {path, symbol: 'target', new_text: ''}))).toMatchObject({code, remediation: expect.any(String)});
    }
    expect((await errorDetail(replaceSymbol(context, {path: 'a.rb', symbol: 'target', new_text: ''}))).remediation).toContain('edit_file');
    expect(port.calls).toEqual([]);
  });

  it('refuses a directory edit without deadlocking the workspace lock', async () => {
    const {context} = setup('a.py', 'def target():\n    pass');
    await expect(editFile(context, {path: '.', old_text: 'a', new_text: 'b'})).rejects.toThrow(/not a file/);
  });

  it('shares the edit_file lock and refuses stale concurrent writes', async () => {
    const source = 'function target() { return 1; }';
    const {port, context} = setup('a.ts', source);
    const results = await Promise.allSettled([
      replaceSymbol(context, {path: 'a.ts', symbol: 'target', new_text: 'function target() { return 2; }', expected_sha256: sha256(source)}),
      editFile(context, {path: 'a.ts', old_text: 'return 1', new_text: 'return 3', expected_sha256: sha256(source)}),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(port.readText(`${ROOT}/a.ts`)).toContain('return 2');
  });

  it('uses the registry write/exec boundary, taints output and rejects escapes before execution', async () => {
    const call = {tool: 'replace_symbol', args: {path: 'a.py', symbol: 'target', new_text: ''}};
    expect(sandboxToolClassifier.classify(call)).toMatchObject({capabilities: ['write', 'exec'], untrustedSource: true, decision: 'allow'});
    expect(sandboxToolClassifier.classify({...call, args: {...call.args, path: '/etc/a.py'}})?.decision).toBe('deny');
    const {context} = setup('a.py', 'def target():\n    pass\n');
    const boundary = {mode: 'plan' as const, runId: 'run', toolCallId: 'call', taint: {tainted: false}, nowMs: () => 1_000, key: await approvalKey(SealedSecret.of('k'.repeat(32))), replay: {consume: async () => true}};
    expect(await executeSandboxTool(call, boundary, context)).toMatchObject({ok: false});
    expect(await executeSandboxTool(call, {...boundary, mode: 'build'}, context)).toMatchObject({ok: true, taint: {tainted: true}});
  });
});
