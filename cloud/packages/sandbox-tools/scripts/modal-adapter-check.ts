/** Opt-in: the sandbox tools on a real Modal sandbox (spends money, so it is a script, not a skipped test). */
import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModalClient, type Sandbox} from 'modal';
import {sandboxToolsImage, NODE_VERSION, PYTHON_VERSION} from '../src/modal/image.js';
import {sha256} from '../src/support.js';
import {checkpointTurn, diffSince, listCheckpoints, rewindTo} from '../src/checkpoints.js';
import {MemoryExportSink} from '../src/fake.js';
import {modalSandboxPort} from '../src/modal/port.js';
import type {SandboxToolContext} from '../src/tools/context.js';
import {editFile, exportFile, readFile} from '../src/tools/files.js';
import {shell, waitForJob} from '../src/tools/process.js';

const APP_NAME = 'praxis-pra51-image';
const IMAGE_NAME = 'praxis-sandbox';
const REVISION_PATTERN = /^[a-f0-9]{40}$/;
const REVISION = process.env.PRAXIS_IMAGE_REVISION;
if (!REVISION || !REVISION_PATTERN.test(REVISION)) throw new Error('Set PRAXIS_IMAGE_REVISION to the full git SHA.');
const CPU_CORES = 0.125;
const MEMORY_MIB = 256;
const EXEC_TIMEOUT_MS = 10_000;
const TAGS = {wp: 'PRA-51'};
const SANDBOX_TIMEOUT_MS = 110_000;
const ROOT = '/workspace/chats/check';

/** A fixed, gitignored log: the scripts take no paths from the command line. */
const logFile = fileURLToPath(new URL('../../../artifacts/modal/sandboxes.log', import.meta.url));
mkdirSync(dirname(logFile), {recursive: true});
function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(logFile, `${stamped}\n`);
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

async function terminate(sandbox: Sandbox): Promise<void> {
  await sandbox.terminate({wait: true});
  log(`SANDBOX adapter-check terminated ${sandbox.sandboxId}`);
  if (await sandbox.poll() === null) throw new Error(`Sandbox still running: ${sandbox.sandboxId}`);
}

const modal = new ModalClient();
const app = await modal.apps.fromName(APP_NAME, {createIfMissing: true});
const image = await sandboxToolsImage(modal).build(app);
await image.publish(`${IMAGE_NAME}:${REVISION}`);
log(`IMAGE ${image.imageId} published ${IMAGE_NAME}:${REVISION}`);
const bootStarted = Date.now();
const sandbox = await modal.sandboxes.create(app, image, {cpu: CPU_CORES, memoryMiB: MEMORY_MIB, timeoutMs: SANDBOX_TIMEOUT_MS, tags: TAGS});
try {
  log(`SANDBOX adapter-check created ${sandbox.sandboxId}`);
  await sandbox.waitUntilReady(EXEC_TIMEOUT_MS);
  log(`BOOT ready in ${Date.now() - bootStarted} ms`);
  const port = modalSandboxPort(sandbox);
  await port.exec({argv: ['mkdir', '-p', ROOT], cwd: '/', timeoutMs: EXEC_TIMEOUT_MS});
  const context: SandboxToolContext = {port, root: ROOT, exports: new MemoryExportSink()};
  await check('pinned runtimes and build tools', async () => {
    const result = await port.exec({argv: ['sh', '-ec', 'node --version; python3 --version; git --version; make --version; gcc --version; tmux -V'], cwd: ROOT, timeoutMs: EXEC_TIMEOUT_MS});
    if (result.exitCode !== 0 || !result.stdout.includes(`v${NODE_VERSION}`) || !result.stdout.includes(`Python ${PYTHON_VERSION}`)) throw new Error('image toolchain mismatch');
    return result.stdout.trim();
  });
  await check('port write/read', async () => {
    const bytes = new TextEncoder().encode('fixture\n');
    const path = `${ROOT}/fixture.txt`;
    await port.writeFile(path, bytes);
    if (sha256(await port.readFile(path)) !== sha256(bytes)) throw new Error('file bytes differ');
    return 'bytes round trip';
  });
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
  await check('approved workspace diagnostics + Python', async () => {
    const config = new TextEncoder().encode(JSON.stringify({version: 1, checks: [{name: 'fixture-python', files: ['**/*.py'], argv: ['python3', '-m', 'py_compile', '{file}'], format: 'python'}]}));
    await port.writeFile(`${ROOT}/.praxis/diagnostics.json`, config);
    const approved = {...context, trustedDiagnostics: new Set([sha256(config)])};
    const broken = await editFile(approved, {path: 'app.py', old_text: '', new_text: 'def broken(:\n'});
    const fixed = await editFile(approved, {path: 'app.py', old_text: 'def broken(:', new_text: 'value = 1'});
    if (broken.diagnostics.ok || !fixed.diagnostics.ok || fixed.diagnostics.ran[0]?.check !== 'fixture-python') throw new Error('workspace diagnostics failed');
    return 'approved config rejects broken Python and accepts repair';
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
  await terminate(sandbox);
}
const running: string[] = [];
for await (const listed of modal.sandboxes.list({appId: app.appId, tags: TAGS})) {
  if (await listed.poll() === null) running.push(listed.sandboxId);
}
if (running.length) throw new Error(`Sandboxes still running: ${running.join(', ')}`);
log(`CHECK running sandboxes for ${APP_NAME}: none`);
process.exitCode = checks.every(entry => entry.ok) ? 0 : 1;
