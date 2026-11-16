/** Opt-in: the sandbox tools on a real Modal sandbox (spends money, so it is a script, not a skipped test). */
import {appendFileSync} from 'node:fs';
import {ModalClient} from 'modal';
import {checkpointTurn, diffSince, listCheckpoints, rewindTo} from '../src/checkpoints.js';
import {MemoryExportSink} from '../src/fake.js';
import {modalSandboxPort} from '../src/modal/port.js';
import type {SandboxToolContext} from '../src/tools/context.js';
import {editFile, exportFile, readFile} from '../src/tools/files.js';
import {shell, waitForJob} from '../src/tools/process.js';

const APP_NAME = 'praxis-pra77-spike';
const IMAGE = 'node:22-bookworm';
const SANDBOX_TIMEOUT_MS = 110_000;
const ROOT = '/workspace/chats/check';

const logFile = process.argv[2];
function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  if (logFile) appendFileSync(logFile, `${stamped}\n`);
}

const checks: {name: string; ok: boolean; detail: string}[] = [];
async function check(name: string, work: () => Promise<string>): Promise<void> {
  try {
    checks.push({name, ok: true, detail: await work()});
  } catch (error) {
    checks.push({name, ok: false, detail: error instanceof Error ? error.message : String(error)});
  }
  const last = checks.at(-1)!;
  log(`${last.ok ? 'OK  ' : 'FAIL'} ${name}: ${last.detail}`);
}

const modal = new ModalClient();
const app = await modal.apps.fromName(APP_NAME, {createIfMissing: true});
const sandbox = await modal.sandboxes.create(app, modal.images.fromRegistry(IMAGE), {cpu: 0.125, memoryMiB: 256, timeoutMs: SANDBOX_TIMEOUT_MS, tags: {wp: 'PRA-77'}});
log(`SANDBOX adapter-check created ${sandbox.sandboxId}`);
try {
  const port = modalSandboxPort(sandbox);
  await port.exec({argv: ['mkdir', '-p', ROOT], cwd: '/', timeoutMs: 10_000});
  const context: SandboxToolContext = {port, root: ROOT, exports: new MemoryExportSink()};
  await check('shell', async () => {
    const result = await shell(context, {command: 'echo hi && pwd'});
    if (result.background || result.exitCode !== 0 || !result.stdout.includes(ROOT)) throw new Error(JSON.stringify(result));
    return result.stdout.trim().replace(/\n/g, ' | ');
  });
  await check('edit_file + node diagnostics', async () => {
    const broken = await editFile(context, {path: 'app.js', old_text: '', new_text: 'const = 1;\n'});
    const fixed = await editFile(context, {path: 'app.js', old_text: 'const = 1;', new_text: 'const one = 1;'});
    if (broken.diagnostics.ok || !fixed.diagnostics.ok) throw new Error(JSON.stringify({broken: broken.diagnostics, fixed: fixed.diagnostics}));
    return `broken → ${broken.diagnostics.problems[0]?.message}; fixed → ok`;
  });
  await check('read_file', async () => {
    const result = await readFile(context, {path: 'app.js'});
    return `${result.content} (sha ${result.sha256.slice(0, 12)})`;
  });
  await check('background job + wait_for_job', async () => {
    const started = await shell(context, {command: 'sleep 8; echo finished', background: true});
    if (!started.background) throw new Error('not started in the background');
    const running = await waitForJob(context, {job_id: started.job_id, timeout_ms: 1_000});
    const done = await waitForJob(context, {job_id: started.job_id, timeout_ms: 20_000});
    if (running.state !== 'running' || done.state !== 'exited' || done.stdout.trim() !== 'finished') throw new Error(JSON.stringify({running, done}));
    return `running after 1 s, exited ${done.exitCode} after ${done.elapsedMs} ms`;
  });
  await check('checkpoints + rewind', async () => {
    const first = await checkpointTurn(port, ROOT, 'turn-1');
    await editFile(context, {path: 'app.js', old_text: 'const one = 1;', new_text: 'const one = 2;'});
    const second = await checkpointTurn(port, ROOT, 'turn-2');
    const diff = await diffSince(port, ROOT, first.sha!);
    await rewindTo(port, ROOT, first.sha!);
    const back = await readFile(context, {path: 'app.js'});
    const listed = await listCheckpoints(port, ROOT);
    if (!second.sha || !diff.patch.includes('+const one = 2;') || !back.content.includes('const one = 1;')) throw new Error('rewind did not restore turn-1');
    return `${listed.length} checkpoints; rewound ${second.sha.slice(0, 8)} → ${first.sha!.slice(0, 8)}`;
  });
  await check('export_file', async () => {
    const result = await exportFile(context, {path: 'app.js'});
    return `${result.name} ${result.mediaType} ${result.bytes} bytes sha ${result.sha256.slice(0, 12)} → ${result.ref}`;
  });
} finally {
  await sandbox.terminate();
  log(`SANDBOX adapter-check terminated ${sandbox.sandboxId}`);
  // The listing lags terminate() by a moment; poll briefly so the check reports the settled state.
  let running: string[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    running = [];
    for await (const listed of modal.sandboxes.list({appId: app.appId, tags: {wp: 'PRA-77'}})) running.push(listed.sandboxId);
    if (!running.length) break;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  log(`CHECK running sandboxes for ${APP_NAME}: ${running.length ? running.join(', ') : 'none'}`);
}
process.exitCode = checks.every(entry => entry.ok) ? 0 : 1;
