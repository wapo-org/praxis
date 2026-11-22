import {describe, expect, it} from 'vitest';
import {ToolBoundaryError} from '@praxis/agent';
import {FakeSandboxPort, MemoryExportSink} from './fake.js';
import {capOutput, resolveInside, sha256, stripAnsi} from './support.js';
import type {SandboxToolContext} from './tools/context.js';
import {editFile, exportFile, readFile} from './tools/files.js';
import {shell, waitForJob} from './tools/process.js';

const ROOT = '/workspace/chats/c1';
function setup() {
  let now = 0;
  const port = new FakeSandboxPort(() => now);
  const exports = new MemoryExportSink();
  const context: SandboxToolContext = {port, root: ROOT, exports, now: () => now, sleep: async ms => {
    now += ms;
  }};
  return {port, exports, context, advance: (ms: number) => (now += ms)};
}

async function toolError(work: Promise<unknown>) {
  const error = await work.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ToolBoundaryError);
  return (error as ToolBoundaryError).detail;
}

describe('paths and output', () => {
  it('keeps every path inside the chat directory', () => {
    expect(resolveInside(ROOT, 'src/a.ts')).toBe(`${ROOT}/src/a.ts`);
    expect(resolveInside(ROOT, `${ROOT}/b`)).toBe(`${ROOT}/b`);
    for (const escape of ['../c2/x', '/etc/passwd', `${ROOT}/../../x`, '/workspace/chats/c10']) {
      expect(() => resolveInside(ROOT, escape)).toThrow(ToolBoundaryError);
    }
  });

  it('caps long output keeping head and tail, and strips terminal codes', () => {
    const capped = capOutput(`${'a'.repeat(100)}${'z'.repeat(100)}`, 40);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toMatch(/^a{20}\n… 160 bytes omitted …\nz{20}$/);
    expect(stripAnsi('\u001b[31mred\u001b[0m')).toBe('red');
  });
});

describe('read_file and edit_file', () => {
  it('numbers lines and returns the content hash', async () => {
    const {port, context} = setup();
    port.writeText(`${ROOT}/a.txt`, 'one\ntwo\nthree');
    const result = await readFile(context, {path: 'a.txt', offset: 2, limit: 1});
    expect(result).toMatchObject({content: '2\ttwo', totalLines: 3, firstLine: 2, lastLine: 2, sha256: sha256('one\ntwo\nthree')});
  });

  it('refuses missing, binary and internal files with a remediation', async () => {
    const {port, context} = setup();
    port.files.set(`${ROOT}/blob`, new Uint8Array([0, 255]));
    expect(await toolError(readFile(context, {path: 'missing.txt'}))).toMatchObject({code: 'not-found', remediation: expect.any(String)});
    expect((await toolError(readFile(context, {path: 'blob'}))).code).toBe('schema');
    expect((await toolError(editFile(context, {path: '.praxis/diagnostics.json', old_text: '', new_text: '{}'}))).code).toBe('policy-denied');
  });

  it('replaces exactly one match, and refuses none, several, or a stale hash', async () => {
    const {port, context} = setup();
    port.writeText(`${ROOT}/notes.md`, 'alpha beta alpha');
    expect((await toolError(editFile(context, {path: 'notes.md', old_text: 'gamma', new_text: 'x'}))).code).toBe('conflict');
    expect((await toolError(editFile(context, {path: 'notes.md', old_text: 'alpha', new_text: 'x'}))).message).toMatch(/matches 2 places/);
    expect((await toolError(editFile(context, {path: 'notes.md', old_text: 'beta', new_text: 'x', expected_sha256: '0'.repeat(64)}))).message).toMatch(/changed since/);
    const edited = await editFile(context, {path: 'notes.md', old_text: 'beta', new_text: 'BETA', expected_sha256: sha256('alpha beta alpha')});
    expect(port.readText(`${ROOT}/notes.md`)).toBe('alpha BETA alpha');
    expect(edited).toMatchObject({replacements: 1, created: false, diagnostics: {ok: true, ran: [], problems: []}});
    await editFile(context, {path: 'notes.md', old_text: 'alpha', new_text: 'A', replace_all: true});
    expect(port.readText(`${ROOT}/notes.md`)).toBe('A BETA A');
  });

  it('creates a file only when it does not exist yet', async () => {
    const {port, context} = setup();
    expect((await editFile(context, {path: 'new/file.txt', old_text: '', new_text: 'hi'})).created).toBe(true);
    expect(port.readText(`${ROOT}/new/file.txt`)).toBe('hi');
    expect((await toolError(editFile(context, {path: 'new/file.txt', old_text: '', new_text: 'again'}))).code).toBe('conflict');
  });
});

describe('export_file', () => {
  it('hands bytes, media type and hash to the sink', async () => {
    const {port, context, exports} = setup();
    port.files.set(`${ROOT}/out/chart.png`, new Uint8Array([1, 2, 3]));
    const result = await exportFile(context, {path: 'out/chart.png'});
    expect(result).toMatchObject({name: 'chart.png', mediaType: 'image/png', bytes: 3, ref: 'export-1', sha256: sha256(new Uint8Array([1, 2, 3]))});
    expect(exports.items[0]?.sha256).toBe(result.sha256);
  });
});

describe('shell and wait_for_job', () => {
  it('runs through sh -c in the chat directory and caps output', async () => {
    const {port, context} = setup();
    port.on(request => (request.argv[2] === 'make' ? {exitCode: 2, stdout: 'x'.repeat(40_000), stderr: '\u001b[31merror\u001b[0m'} : undefined));
    const result = await shell(context, {command: 'make', cwd: 'src'});
    expect(port.calls[0]).toMatchObject({argv: ['sh', '-c', 'make'], cwd: `${ROOT}/src`});
    expect(result).toMatchObject({background: false, exitCode: 2, stderr: 'error', truncated: true});
  });

  it('turns a timeout into a ToolError that points at background jobs', async () => {
    const {port, context} = setup();
    port.on(() => ({timedOut: true, exitCode: null}));
    expect(await toolError(shell(context, {command: 'sleep 999', timeout_ms: 1_000}))).toMatchObject({code: 'timeout', remediation: expect.stringMatching(/wait_for_job/)});
  });

  it('starts background jobs and waits with a bound instead of sleep loops', async () => {
    const {port, context} = setup();
    port.on(request => (request.argv[2] === 'npm test' ? {exitCode: 0, stdout: 'ok'} : undefined));
    const started = await shell(context, {command: 'npm test', background: true});
    expect(started).toMatchObject({background: true, job_id: 'job-1'});
    expect(await waitForJob(context, {job_id: 'job-1', timeout_ms: 5_000})).toMatchObject({state: 'exited', exitCode: 0, stdout: 'ok'});
    await port.startJob({argv: ['sh', '-c', 'forever'], cwd: ROOT}, 1_000);
    expect(await waitForJob(context, {job_id: 'job-2', timeout_ms: 2_000})).toMatchObject({state: 'running', exitCode: null, elapsedMs: 2_000});
    expect((await toolError(waitForJob(context, {job_id: 'nope'}))).code).toBe('not-found');
  });
});
