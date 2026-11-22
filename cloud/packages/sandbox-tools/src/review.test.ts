import {mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {afterEach, describe, expect, it} from 'vitest';
import {SealedSecret} from '@praxis/types';
import {approvalKey, ToolBoundaryError, type ApprovalReplayStore, type BoundaryContext} from '@praxis/agent';
import {execBackedJobs} from './exec-jobs.js';
import {FakeSandboxPort, MemoryExportSink} from './fake.js';
import {localExec, localSandboxPort} from './local.js';
import {sha256} from './support.js';
import type {SandboxToolContext} from './tools/context.js';
import {editFile, readFile} from './tools/files.js';
import {shell, waitForJob} from './tools/process.js';
import {executeSandboxTool, sandboxToolClassifier} from './tools/registry.js';

const ROOT = '/workspace/chats/c1';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});
function localWorkspace(): SandboxToolContext & {base: string} {
  const base = mkdtempSync(join(tmpdir(), 'praxis-review-'));
  roots.push(base);
  mkdirSync(join(base, 'chat'));
  return {base, port: localSandboxPort(join(base, 'jobs')), root: join(base, 'chat'), exports: new MemoryExportSink()};
}
async function toolError(work: Promise<unknown>) {
  const error = await work.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ToolBoundaryError);
  return (error as ToolBoundaryError).detail;
}

describe('workspace containment follows symlinks', () => {
  it('refuses a path whose real target leaves the chat directory', async () => {
    const port = new FakeSandboxPort().link(`${ROOT}/escape`, '/etc').writeText('/etc/passwd', 'root:x');
    const context = {port, root: ROOT, exports: new MemoryExportSink()};
    expect(await toolError(readFile(context, {path: 'escape/passwd'}))).toMatchObject({code: 'path-traversal'});
    expect(await toolError(editFile(context, {path: 'escape/new.txt', old_text: '', new_text: 'x'}))).toMatchObject({code: 'path-traversal'});
    expect(await toolError(shell(context, {command: 'pwd', cwd: 'escape'}))).toMatchObject({code: 'path-traversal'});
    expect(port.calls).toEqual([]);
  });

  it('refuses a real symlink to a sibling directory and a .praxis alias', async () => {
    const context = localWorkspace();
    mkdirSync(join(context.base, 'other'));
    symlinkSync(join(context.base, 'other'), join(context.root, 'link'));
    mkdirSync(join(context.root, '.praxis'));
    symlinkSync(join(context.root, '.praxis'), join(context.root, 'alias'));
    expect(await toolError(editFile(context, {path: 'link/x.txt', old_text: '', new_text: 'x'}))).toMatchObject({code: 'path-traversal'});
    expect(await toolError(editFile(context, {path: 'alias/diagnostics.json', old_text: '', new_text: '{}'}))).toMatchObject({code: 'policy-denied'});
    expect(existsSync(join(context.base, 'other', 'x.txt'))).toBe(false);
  });
});

describe('concurrent edits', () => {
  it('serializes read-check-write per file, so a stale hash cannot overwrite a newer edit', async () => {
    const port = new FakeSandboxPort().writeText(`${ROOT}/a.txt`, 'alpha beta');
    const context = {port, root: ROOT, exports: new MemoryExportSink()};
    const expected = sha256('alpha beta');
    const results = await Promise.allSettled([
      editFile(context, {path: 'a.txt', old_text: 'alpha', new_text: 'ALPHA', expected_sha256: expected}),
      editFile(context, {path: 'a.txt', old_text: 'beta', new_text: 'BETA', expected_sha256: expected}),
    ]);
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(port.readText(`${ROOT}/a.txt`)).toBe('ALPHA beta');
  });
});

describe('diagnostics configuration is untrusted input', () => {
  const config = JSON.stringify({version: 1, checks: [{name: 'evil', files: ['**/*.txt'], argv: ['sh', '-c', 'printf ATTACKER; exit 1']}, {name: 'lint', files: ['**/*.txt'], argv: ['lint', '{file}']}]});

  it('runs no configured command until the user approves that exact config', async () => {
    const port = new FakeSandboxPort().writeText(`${ROOT}/.praxis/diagnostics.json`, config);
    const result = await editFile({port, root: ROOT, exports: new MemoryExportSink()}, {path: 'a.txt', old_text: '', new_text: 'x'});
    expect(port.calls).toEqual([]);
    expect(result.diagnostics.problems[0]).toMatchObject({check: 'config', message: expect.stringContaining(sha256(config))});
  });

  it('never runs a check shellPolicy denies, even from an approved config', async () => {
    const port = new FakeSandboxPort().writeText(`${ROOT}/.praxis/diagnostics.json`, config).on(request => (request.argv[0] === 'lint' ? {exitCode: 0} : undefined));
    const result = await editFile({port, root: ROOT, exports: new MemoryExportSink(), trustedDiagnostics: new Set([sha256(config)])}, {path: 'a.txt', old_text: '', new_text: 'x'});
    expect(result.diagnostics.ran.map(entry => [entry.check, entry.outcome])).toEqual([['evil', 'denied'], ['lint', 'passed']]);
    expect(port.calls.map(call => call.argv.join(' '))).toEqual(['lint a.txt']);
  });
});

describe('PRA-76 decision table', () => {
  async function boundary(tainted: boolean): Promise<BoundaryContext> {
    const replay: ApprovalReplayStore = {consume: async () => true};
    return {mode: 'build', runId: 'run', toolCallId: 'call', taint: {tainted}, nowMs: () => 1_000, key: await approvalKey(SealedSecret.of('k'.repeat(32))), replay};
  }
  const tools = () => {
    const port = new FakeSandboxPort().on(request => (request.argv[2] === 'echo hi' ? {stdout: 'hi\n'} : undefined));
    return {port, context: {port, root: ROOT, exports: new MemoryExportSink()}};
  };

  it('runs confined allow calls untainted without a receipt, and needs one once the run is tainted', async () => {
    const {port, context} = tools();
    expect(await executeSandboxTool({tool: 'shell', args: {command: 'echo hi'}}, await boundary(false), context)).toMatchObject({ok: true, result: {value: {stdout: 'hi\n'}}});
    expect(await executeSandboxTool({tool: 'edit_file', args: {path: 'n.txt', old_text: '', new_text: 'x'}}, await boundary(false), context)).toMatchObject({ok: true, taint: {tainted: true}});
    expect(await executeSandboxTool({tool: 'edit_file', args: {path: 'm.txt', old_text: '', new_text: 'x'}}, await boundary(true), context)).toMatchObject({ok: false, error: {code: 'taint-blocked'}});
    expect(port.readText(`${ROOT}/m.txt`)).toBeUndefined();
  });

  it('denies arguments that leave the workspace before any receipt or execution', () => {
    for (const args of [{path: '../../../etc/passwd'}, {path: '/etc/passwd'}]) {
      expect(sandboxToolClassifier.classify({tool: 'read_file', args})?.decision).toBe('deny');
    }
    expect(sandboxToolClassifier.classify({tool: 'shell', args: {command: 'echo hi', cwd: '/root'}})?.decision).toBe('deny');
    expect(sandboxToolClassifier.classify({tool: 'read_file', args: {path: `${ROOT}/a.txt`}})?.decision).toBe('allow');
  });
});

describe('processes and job status', () => {
  it('kills the whole process group at the deadline, so descendants cannot keep running', async () => {
    const context = localWorkspace();
    const started = Date.now();
    await expect(shell(context, {command: 'sh -c "sleep 1.5; echo survived > after.txt" & wait', timeout_ms: 200})).rejects.toThrow(/stopped after 200 ms/);
    expect(Date.now() - started).toBeLessThan(1_000);
    await sleep(1_800);
    expect(existsSync(join(context.root, 'after.txt'))).toBe(false);
  });

  it('keeps NUL bytes in job output instead of breaking the status framing', async () => {
    const context = localWorkspace();
    const job = await shell(context, {command: "printf 'hello\\000world'; printf 'real stderr' >&2", background: true});
    if (!job.background) throw new Error('expected a job');
    expect(await waitForJob(context, {job_id: job.job_id, timeout_ms: 10_000})).toMatchObject({state: 'exited', exitCode: 0, stdout: 'hello\u0000world', stderr: 'real stderr'});
  });

  it('turns a failed or malformed status read into an error instead of a fake running job', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const timedOut = execBackedJobs(async () => ({exitCode: null, stdout: '', stderr: '', timedOut: true, durationMs: 15_000}));
    await expect(timedOut.jobStatus(id)).rejects.toThrow(/timed out/);
    const garbled = execBackedJobs(async () => ({exitCode: 0, stdout: 'not-a-time\n\n\n\n', stderr: '', timedOut: false, durationMs: 1}));
    await expect(garbled.jobStatus(id)).rejects.toThrow();
    expect(await localExec({argv: ['true'], cwd: '/', timeoutMs: 1_000})).toMatchObject({exitCode: 0});
  });
});
