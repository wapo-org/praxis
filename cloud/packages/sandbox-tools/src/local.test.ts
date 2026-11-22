import {mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {checkpointTurn, diffSince, listCheckpoints, rewindTo} from './checkpoints.js';
import {MemoryExportSink} from './fake.js';
import {localSandboxPort} from './local.js';
import type {SandboxToolContext} from './tools/context.js';
import {replaceSymbol} from './tools/symbols.js';
import {sha256} from './support.js';
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
  it('returns syntax errors inline and checkpoints/rewinds the entire symbol edit', async () => {
    const context = workspace();
    const path = join(context.root, 'app.js');
    const source = '// 😀\nfunction target() { return 1; }\nfunction other() {}\n';
    writeFileSync(path, source);
    const first = await checkpointTurn(context.port, context.root, 'symbol-before');
    const edited = await replaceSymbol(context, {path: 'app.js', symbol: 'target', new_text: 'function target() { const = 2; }'});
    expect(edited.diagnostics).toMatchObject({ok: false, problems: [{check: 'node-syntax', line: 2}]});
    const next = await checkpointTurn(context.port, context.root, 'symbol-after');
    expect(next.files).toEqual(['app.js']);
    expect((await diffSince(context.port, context.root, first.sha!)).patch).toContain('+function target() { const = 2; }');
    await rewindTo(context.port, context.root, first.sha!);
    expect(readFileSync(path, 'utf8')).toBe(source);
  });

  it('runs approved configured TypeScript diagnostics exactly as edit_file', async () => {
    const context = workspace();
    writeFileSync(join(context.root, 'app.ts'), 'function target(): number { return 1; }');
    mkdirSync(join(context.root, '.praxis'));
    writeFileSync(join(context.root, 'diagnose.cjs'), "console.log('app.ts:1: invalid syntax'); process.exit(1)");
    const config = JSON.stringify({version: 1, checks: [{name: 'ts-syntax', files: ['**/*.ts'], argv: ['node', 'diagnose.cjs'], format: 'gnu'}]});
    writeFileSync(join(context.root, '.praxis', 'diagnostics.json'), config);
    context.trustedDiagnostics = new Set([sha256(config)]);
    const result = await replaceSymbol(context, {path: 'app.ts', symbol: 'target', new_text: 'function target(): number { return ; }'});
    expect(result.diagnostics).toMatchObject({ok: false, ran: [{check: 'ts-syntax', outcome: 'failed'}], problems: [{file: 'app.ts', line: 1, message: 'invalid syntax'}]});
    const exact = await editFile(context, {path: 'app.ts', old_text: 'return ;', new_text: 'return 1;'});
    expect(exact.diagnostics.problems).toEqual(result.diagnostics.problems);
  });

  it('does not let a checkpoint stage a partially written symbol edit', async () => {
    const context = workspace();
    const path = join(context.root, 'app.ts');
    writeFileSync(path, 'function target() {}');
    await checkpointTurn(context.port, context.root, 'before');
    const canonicalPath = await context.port.realpath(path);
    const write = context.port.writeFile.bind(context.port);
    const exec = context.port.exec.bind(context.port);
    let stagedWhileHeld = false;
    let isHeld = true;
    context.port.exec = async request => {
      if (isHeld && request.argv.includes('add')) stagedWhileHeld = true;
      return exec(request);
    };
    let release!: () => void;
    let writing!: () => void;
    const entered = new Promise<void>(resolve => { writing = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    context.port.writeFile = async (file, bytes) => {
      if (file === canonicalPath) {
        await write(file, bytes.subarray(0, 5));
        writing();
        await held;
      }
      await write(file, bytes);
    };
    const edit = replaceSymbol(context, {path: 'app.ts', symbol: 'target', new_text: 'function target() { return 2; }'});
    await entered;
    const checkpoint = checkpointTurn(context.port, context.root, 'after');
    await exec({argv: ['git', 'status', '--porcelain'], cwd: context.root, timeoutMs: 10_000});
    expect(stagedWhileHeld).toBe(false);
    isHeld = false;
    release();
    await edit;
    const result = await checkpoint;
    const committed = await context.port.exec({argv: ['git', 'show', `${result.sha}:app.ts`], cwd: context.root, timeoutMs: 10_000});
    expect(committed.stdout).toBe('function target() { return 2; }');
  });
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
