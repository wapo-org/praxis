import {describe, expect, it} from 'vitest';
import {SealedSecret} from '@praxis/types';
import {approvalKey, argsHash, issueApproval, type ApprovalReplayStore, type BoundaryContext} from '@praxis/agent';
import {DIAGNOSTICS_BUDGET_MS} from './constants.js';
import {globToRegExp, runDiagnostics} from './diagnostics.js';
import {sha256} from './support.js';
import {FakeSandboxPort, MemoryExportSink} from './fake.js';
import {editFile} from './tools/files.js';
import {executeSandboxTool, sandboxToolClassifier} from './tools/registry.js';

const ROOT = '/workspace/chats/c1';
const NODE_SYNTAX_ERROR = `${ROOT}/app.js:2\n  const = 1;\n        ^\n\nSyntaxError: Unexpected token '='\n    at wrapSafe (node:internal)`;

describe('diagnostics contract', () => {
  it('matches globs the way the contract documents', () => {
    expect(globToRegExp('**/*.ts').test('src/deep/a.ts')).toBe(true);
    expect(globToRegExp('**/*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false);
    expect(globToRegExp('*.json').test('package.json')).toBe(true);
  });

  it('runs built-in syntax checks without a config and returns problems inline', async () => {
    const port = new FakeSandboxPort().on(request => (request.argv[0] === 'node' ? {exitCode: 1, stderr: NODE_SYNTAX_ERROR} : undefined));
    const result = await editFile({port, root: ROOT, exports: new MemoryExportSink()}, {path: 'app.js', old_text: '', new_text: 'ok;\n  const = 1;\n'});
    expect(port.calls[0]).toMatchObject({argv: ['node', '--check', 'app.js'], cwd: ROOT});
    expect(result.diagnostics).toEqual({ok: false, ran: [{check: 'node-syntax', outcome: 'failed', ms: 1}], truncated: false,
      problems: [{check: 'node-syntax', file: `${ROOT}/app.js`, line: 2, message: "SyntaxError: Unexpected token '='"}]});
  });

  it('checks JSON in-process and reports invalid configuration instead of failing the edit', async () => {
    const port = new FakeSandboxPort().writeText(`${ROOT}/.praxis/diagnostics.json`, '{"version": 2}');
    const report = await runDiagnostics(port, ROOT, 'data.json', '{"a": }', {trustedConfigs: new Set([sha256('{"version": 2}')])});
    expect(report.problems.map(problem => problem.check)).toEqual(['config', 'json-syntax']);
    expect(report.problems[0]!.message).toMatch(/^ignored: version/);
  });

  it('runs configured checks with {file}, parses tsc and gnu output, and shares one time budget', async () => {
    let now = 0;
    const config = {version: 1, checks: [
      {name: 'tsc', files: ['**/*.ts'], argv: ['npx', 'tsc', '--noEmit'], format: 'tsc'},
      {name: 'eslint', files: ['src/**'], argv: ['eslint', '-f', 'unix', '{file}']},
      {name: 'slow', files: ['**/*.ts'], argv: ['slow']},
    ]};
    const port = new FakeSandboxPort().writeText(`${ROOT}/.praxis/diagnostics.json`, JSON.stringify(config)).on(request => {
      now += request.argv[0] === 'eslint' ? DIAGNOSTICS_BUDGET_MS : 10;
      if (request.argv[0] === 'npx') return {exitCode: 2, stdout: 'src/a.ts(3,7): error TS2322: Type string is not assignable to type number.'};
      if (request.argv[0] === 'eslint') return {exitCode: 1, stdout: `src/a.ts:9:1: 'x' is defined but never used. [no-unused-vars]`};
      return undefined;
    });
    const report = await runDiagnostics(port, ROOT, 'src/a.ts', '', {trustedConfigs: new Set([sha256(JSON.stringify(config))]), now: () => now});
    expect(port.calls.map(call => call.argv.join(' '))).toEqual(['npx tsc --noEmit', 'eslint -f unix src/a.ts']);
    expect(report.ran.map(entry => [entry.check, entry.outcome])).toEqual([['tsc', 'failed'], ['eslint', 'failed'], ['slow', 'skipped']]);
    expect(report.problems).toEqual([
      {check: 'tsc', file: 'src/a.ts', line: 3, column: 7, message: 'TS2322: Type string is not assignable to type number.'},
      {check: 'eslint', file: 'src/a.ts', line: 9, column: 1, message: "'x' is defined but never used. [no-unused-vars]"},
    ]);
  });
});

describe('PRA-76 gate', () => {
  async function boundary(mode: BoundaryContext['mode'] = 'build') {
    const key = await approvalKey(SealedSecret.of('k'.repeat(32)));
    const used = new Set<string>();
    const replay: ApprovalReplayStore = {consume: async nonce => !used.has(nonce) && !!used.add(nonce)};
    const context: BoundaryContext = {mode, runId: 'run', toolCallId: 'call', taint: {tainted: false}, nowMs: () => 1_000, key, replay};
    const approve = async (tool: string, args: Record<string, unknown>) => issueApproval(key, {runId: 'run', toolCallId: 'call', tool, argsHash: await argsHash(args)}, 2_000, `n-${tool}`);
    return {context, approve};
  }
  const tools = () => {
    const port = new FakeSandboxPort().writeText(`${ROOT}/a.txt`, 'hello').on(request => (request.argv[2] === 'ls' ? {stdout: 'a.txt\n'} : undefined));
    return {port, context: {port, root: ROOT, exports: new MemoryExportSink()}};
  };

  it('classifies shell through shellPolicy and the rest by capability', () => {
    expect(sandboxToolClassifier.classify({tool: 'shell', args: {command: 'rm -rf /'}})?.decision).toBe('deny');
    expect(sandboxToolClassifier.classify({tool: 'shell', args: {command: 'echo hi'}})).toMatchObject({decision: 'allow', capabilities: ['exec']});
    expect(sandboxToolClassifier.classify({tool: 'read_file', args: {path: 'a'}})).toMatchObject({decision: 'allow', capabilities: ['read'], untrustedSource: true});
    expect(sandboxToolClassifier.classify({tool: 'read_file', args: {nope: 1}})?.decision).toBe('deny');
    expect(sandboxToolClassifier.classify({tool: 'unknown', args: {}})).toBeUndefined();
  });

  it('runs reads directly, needs a receipt for side effects, and never runs a denied command', async () => {
    const {port, context} = tools();
    const gate = await boundary();
    expect(await executeSandboxTool({tool: 'read_file', args: {path: 'a.txt'}}, gate.context, context)).toMatchObject({ok: true, taint: {tainted: true}});
    expect(await executeSandboxTool({tool: 'shell', args: {command: 'ls'}}, gate.context, context)).toMatchObject({ok: false, error: {code: 'approval-required'}});
    expect(await executeSandboxTool({tool: 'shell', args: {command: 'rm -rf x'}}, gate.context, context, await gate.approve('shell', {command: 'rm -rf x'}))).toMatchObject({ok: false, error: {code: 'policy-denied'}});
    expect(port.calls).toEqual([]);
    const ran = await executeSandboxTool({tool: 'shell', args: {command: 'ls'}}, gate.context, context, await gate.approve('shell', {command: 'ls'}));
    expect(ran).toMatchObject({ok: true, result: {value: {exitCode: 0, stdout: 'a.txt\n'}}});
  });

  it('refuses edits in ask mode and turns tool failures into ToolErrors', async () => {
    const {context} = tools();
    const ask = await boundary('ask');
    expect(await executeSandboxTool({tool: 'edit_file', args: {path: 'a.txt', old_text: 'hello', new_text: 'x'}}, ask.context, context)).toMatchObject({ok: false, error: {code: 'policy-denied'}});
    const build = await boundary();
    const args = {path: 'a.txt', old_text: 'missing', new_text: 'x'};
    expect(await executeSandboxTool({tool: 'edit_file', args}, build.context, context, await build.approve('edit_file', args))).toMatchObject({ok: false, error: {code: 'conflict', remediation: expect.any(String)}});
  });
});
