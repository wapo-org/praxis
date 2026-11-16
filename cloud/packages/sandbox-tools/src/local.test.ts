import {mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {checkpointTurn, diffSince, listCheckpoints, rewindTo} from './checkpoints.js';
import {MemoryExportSink} from './fake.js';
import {localSandboxPort} from './local.js';
import type {SandboxToolContext} from './tools/context.js';
import {editFile} from './tools/files.js';
import {shell, waitForJob} from './tools/process.js';

const roots: string[] = [];
function workspace(): SandboxToolContext {
  const base = mkdtempSync(join(tmpdir(), 'praxis-sandbox-'));
  roots.push(base);
  const root = join(base, 'chat');
  mkdirSync(root);
  return {port: localSandboxPort(join(base, 'jobs')), root, exports: new MemoryExportSink()};
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

describe('local port with real processes', () => {
  it('commits one checkpoint per changed turn, diffs and rewinds, and never commits .praxis', async () => {
    const {port, root} = workspace();
    writeFileSync(join(root, 'a.txt'), 'one\n');
    mkdirSync(join(root, '.praxis'));
    writeFileSync(join(root, '.praxis', 'state'), 'internal');
    const first = await checkpointTurn(port, root, 'turn-1');
    expect(first.files).toEqual(['a.txt']);
    expect(await checkpointTurn(port, root, 'turn-2')).toEqual({sha: null, files: []});
    writeFileSync(join(root, 'a.txt'), 'two\n');
    writeFileSync(join(root, 'b.txt'), 'new\n');
    const third = await checkpointTurn(port, root, 'turn-3');
    expect(third.files.sort()).toEqual(['a.txt', 'b.txt']);
    expect((await listCheckpoints(port, root)).map(checkpoint => checkpoint.turnId)).toEqual(['turn-3', 'turn-1']);
    expect((await diffSince(port, root, first.sha!)).patch).toContain('+two');
    writeFileSync(join(root, 'scratch.tmp'), 'uncommitted');
    await rewindTo(port, root, first.sha!);
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(root, 'b.txt'))).toBe(false);
    expect(existsSync(join(root, 'scratch.tmp'))).toBe(false);
    expect(readFileSync(join(root, '.praxis', 'state'), 'utf8')).toBe('internal');
  });

  it('refuses to rewind to a commit the runner did not make', async () => {
    const context = workspace();
    writeFileSync(join(context.root, 'a.txt'), 'x');
    await checkpointTurn(context.port, context.root, 'turn-1');
    const manual = await shell(context, {command: 'git -c user.name=u -c user.email=u@x commit -q --allow-empty -m manual && git rev-parse HEAD'});
    const sha = manual.background ? '' : manual.stdout.trim();
    await expect(rewindTo(context.port, context.root, sha)).rejects.toThrow(/not a Praxis checkpoint/);
  });

  it('runs a background job past the call and reports its exit through wait_for_job', async () => {
    const context = workspace();
    const started = await shell(context, {command: 'echo working; sleep 0.3; echo done >&2; exit 3', background: true});
    if (!started.background) throw new Error('expected a job');
    expect((await waitForJob(context, {job_id: started.job_id, timeout_ms: 100})).state).toBe('running');
    const finished = await waitForJob(context, {job_id: started.job_id, timeout_ms: 10_000});
    expect(finished).toMatchObject({state: 'exited', exitCode: 3, stdout: 'working\n', stderr: 'done\n'});
    expect((await context.port.listJobs()).map(job => job.id)).toEqual([started.job_id]);
  });

  it('kills a foreground command at its timeout', async () => {
    const context = workspace();
    await expect(shell(context, {command: 'sleep 5', timeout_ms: 200})).rejects.toThrow(/stopped after 200 ms/);
  });

  it('returns real node --check errors inline after an edit', async () => {
    const context = workspace();
    const result = await editFile(context, {path: 'app.js', old_text: '', new_text: 'const ok = 1;\nconst = 2;\n'});
    expect(result.diagnostics.ok).toBe(false);
    expect(result.diagnostics.problems[0]).toMatchObject({check: 'node-syntax', line: 2, message: expect.stringMatching(/^SyntaxError/)});
    const fixed = await editFile(context, {path: 'app.js', old_text: 'const = 2;', new_text: 'const two = 2;'});
    expect(fixed.diagnostics).toMatchObject({ok: true, ran: [{check: 'node-syntax', outcome: 'passed'}]});
  });
});
