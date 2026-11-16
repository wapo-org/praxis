/** PRA-100 spike, opt-in: which sandbox capabilities the Modal JS SDK covers on a real account; prints no secrets. */
import {appendFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ModalClient, type Sandbox} from 'modal';

const APP_NAME = 'praxis-pra77-spike';
const VOLUME_NAME = 'praxis-pra77-spike-workspace';
/** Includes git, Node and Python, as the v1 tools need. */
const IMAGE = 'node:22-bookworm';
/** Budget approved for the spike: each sandbox under two minutes, smallest size. */
const SANDBOX_TIMEOUT_MS = 110_000;
const SANDBOX_CPU = 0.125;
const SANDBOX_MEMORY_MIB = 256;
const TUNNEL_PORT = 8080;

/** A fixed, gitignored log: the scripts take no paths from the command line. */
const logFile = fileURLToPath(new URL('../../../artifacts/modal/sandboxes.log', import.meta.url));
mkdirSync(dirname(logFile), {recursive: true});
const results: {capability: string; ok: boolean; detail: string; ms: number}[] = [];

function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(logFile, `${stamped}\n`);
}

async function probe(capability: string, work: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await work();
    results.push({capability, ok: true, detail, ms: Date.now() - started});
  } catch (error) {
    results.push({capability, ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error), ms: Date.now() - started});
  }
  const last = results.at(-1)!;
  log(`${last.ok ? 'OK  ' : 'FAIL'} ${capability} (${last.ms} ms): ${last.detail}`);
}

async function collect(stream: ReadableStream<string>): Promise<{text: string; chunks: number[]}> {
  let text = '';
  const chunks: number[] = [];
  const started = Date.now();
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    text += next.value;
    chunks.push(Date.now() - started);
  }
  return {text, chunks};
}

async function withSandbox(label: string, create: () => Promise<Sandbox>, work: (sandbox: Sandbox) => Promise<void>): Promise<void> {
  const sandbox = await create();
  log(`SANDBOX ${label} created ${sandbox.sandboxId}`);
  try {
    await work(sandbox);
  } finally {
    await sandbox.terminate();
    log(`SANDBOX ${label} terminated ${sandbox.sandboxId}`);
  }
}

const modal = new ModalClient();
const app = await modal.apps.fromName(APP_NAME, {createIfMissing: true});
const image = modal.images.fromRegistry(IMAGE);
const volume = await modal.volumes.fromName(VOLUME_NAME, {createIfMissing: true});
const params = {cpu: SANDBOX_CPU, memoryMiB: SANDBOX_MEMORY_MIB, timeoutMs: SANDBOX_TIMEOUT_MS, volumes: {'/workspace': volume}};
const marker = `pra77-${Date.now()}`;

try {
  await withSandbox('first', () => modal.sandboxes.create(app, image, {...params, encryptedPorts: [TUNNEL_PORT], tags: {wp: 'PRA-77'}}), async sandbox => {
    await probe('exec: stdout, stderr and exit code', async () => {
      const process = await sandbox.exec(['sh', '-c', 'echo out; echo err >&2; exit 3']);
      const [stdout, stderr, code] = await Promise.all([collect(process.stdout), collect(process.stderr), process.wait()]);
      if (stdout.text.trim() !== 'out' || stderr.text.trim() !== 'err' || code !== 3) throw new Error(`got ${JSON.stringify({stdout: stdout.text, stderr: stderr.text, code})}`);
      return 'stdout "out", stderr "err", exit 3';
    });
    await probe('exec: streaming output', async () => {
      const process = await sandbox.exec(['sh', '-c', 'for i in 1 2 3; do echo $i; sleep 1; done']);
      const {text, chunks} = await collect(process.stdout);
      await process.wait();
      if (chunks.length < 2 || chunks.at(-1)! - chunks[0]! < 1500) throw new Error(`chunks at ${chunks.join(',')} ms`);
      return `${chunks.length} chunks spread over ${chunks.at(-1)! - chunks[0]!} ms ("${text.replace(/\n/g, ' ').trim()}")`;
    });
    await probe('exec: timeoutMs kills a long command', async () => {
      const started = Date.now();
      const process = await sandbox.exec(['sleep', '30'], {timeoutMs: 2_000});
      let outcome: string;
      try {
        outcome = `exit ${await process.wait()}`;
      } catch (error) {
        outcome = `throws ${error instanceof Error ? error.name : 'error'}`;
      }
      const elapsed = Date.now() - started;
      if (elapsed > 10_000) throw new Error(`still waited ${elapsed} ms`);
      return `${outcome} after ${elapsed} ms`;
    });
    await probe('exec: workdir, env and stdin', async () => {
      const process = await sandbox.exec(['sh', '-c', 'pwd; echo $GREETING; cat'], {workdir: '/workspace', env: {GREETING: 'hi'}});
      await process.stdin.writeText('from-stdin');
      await process.stdin.close();
      const {text} = await collect(process.stdout);
      await process.wait();
      if (!text.includes('/workspace') || !text.includes('hi') || !text.includes('from-stdin')) throw new Error(JSON.stringify(text));
      return text.replace(/\n/g, ' | ').trim();
    });
    await probe('filesystem: write, read, stat, list', async () => {
      await sandbox.filesystem.makeDirectory('/workspace/chats/c1');
      await sandbox.filesystem.writeText(`hello ${marker}\n`, '/workspace/chats/c1/note.txt');
      const text = await sandbox.filesystem.readText('/workspace/chats/c1/note.txt');
      const info = await sandbox.filesystem.stat('/workspace/chats/c1/note.txt');
      const listing = await sandbox.filesystem.listFiles('/workspace/chats/c1');
      if (!text.includes(marker)) throw new Error(`read back ${JSON.stringify(text)}`);
      return `read back ${text.length} chars; stat ${JSON.stringify(info)}; list ${listing.length} entries`;
    });
    await probe('filesystem: binary round trip', async () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 255]);
      await sandbox.filesystem.writeBytes(bytes, '/workspace/chats/c1/blob.bin');
      const back = await sandbox.filesystem.readBytes('/workspace/chats/c1/blob.bin');
      if (Buffer.compare(Buffer.from(back), Buffer.from(bytes)) !== 0) throw new Error(`got ${[...back].join(',')}`);
      return '5 bytes identical';
    });
    await probe('git available in the image', async () => {
      const process = await sandbox.exec(['sh', '-c', 'git --version && node --version && python3 --version']);
      const {text} = await collect(process.stdout);
      if ((await process.wait()) !== 0) throw new Error('non-zero exit');
      return text.replace(/\n/g, ' | ').trim();
    });
    await probe('encrypted port tunnel', async () => {
      await sandbox.exec(['sh', '-c', `cd /workspace && nohup python3 -m http.server ${TUNNEL_PORT} > /workspace/http.log 2>&1 &`]);
      const tunnels = await sandbox.tunnels(30_000);
      const tunnel = tunnels[TUNNEL_PORT];
      if (!tunnel) throw new Error(`no tunnel for ${TUNNEL_PORT}: ${Object.keys(tunnels).join(',')}`);
      let status = 0;
      for (let attempt = 0; attempt < 20 && status !== 200; attempt++) {
        status = await fetch(`${tunnel.url}/chats/c1/note.txt`, {signal: AbortSignal.timeout(5_000)}).then(response => response.status, () => 0);
        if (status !== 200) await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (status !== 200) throw new Error(`HTTP ${status} from ${new URL(tunnel.url).host}`);
      return `HTTPS ${new URL(tunnel.url).protocol} → 200 from the in-sandbox server (TLS socket ${tunnel.tlsSocket[1]})`;
    });
  });

  await withSandbox('second', () => modal.sandboxes.create(app, image, {...params, tags: {wp: 'PRA-77'}}), async sandbox => {
    await probe('volume: file survives termination into a new sandbox', async () => {
      const text = await sandbox.filesystem.readText('/workspace/chats/c1/note.txt');
      if (!text.includes(marker)) throw new Error(`read ${JSON.stringify(text)}`);
      return `new sandbox read "${text.trim()}"`;
    });
    await probe('terminate: poll reports the exit', async () => {
      await sandbox.terminate();
      const code = await sandbox.poll();
      return `poll() after terminate → ${code}`;
    });
  });
} finally {
  // The listing lags terminate() by a moment; poll briefly so the check reports the settled state.
  let running: string[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    running = [];
    for await (const sandbox of modal.sandboxes.list({appId: app.appId, tags: {wp: 'PRA-77'}})) running.push(sandbox.sandboxId);
    if (!running.length) break;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  log(`CHECK running sandboxes for ${APP_NAME}: ${running.length ? running.join(', ') : 'none'}`);
  await modal.volumes.delete(VOLUME_NAME).then(() => log(`volume ${VOLUME_NAME} deleted`), error => log(`volume delete failed: ${error instanceof Error ? error.message : error}`));
  log(`RESULTS ${JSON.stringify(results)}`);
}
