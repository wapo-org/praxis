import {spawn, type ChildProcess} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {createServer} from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
import {LOOPBACK_HOST, SERVER_POLL_INTERVAL_MS, SERVER_READY_TIMEOUT_MS, SERVER_STOP_GRACE_MS} from './constants.js';

export interface CommandResult {
  code: number;
  output: string;
  ms: number;
}

export interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Full output also goes here, so a long log never has to fit in memory twice. */
  logFile?: string;
}

/** Runs to completion and captures stdout+stderr interleaved; never throws on a non-zero exit. */
export function runCommand(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe']});
    const log = options.logFile ? createWriteStream(options.logFile) : undefined;
    const chunks: Buffer[] = [];
    const collect = (chunk: Buffer) => {
      chunks.push(chunk);
      log?.write(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', code => {
      log?.end();
      resolve({code: code ?? 1, output: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started});
    });
  });
}

/** Refuses an occupied port: probing a stranger's server would verify the wrong code. */
export async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(`Port ${port} on ${LOOPBACK_HOST} is already in use; pick another with --ports or stop that server`)));
    probe.listen(port, LOOPBACK_HOST, () => probe.close(() => resolve()));
  });
}

export async function waitForUrl(url: string, timeoutMs = SERVER_READY_TIMEOUT_MS, alive: () => boolean = () => true): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error(`Server for ${url} exited before it was ready`);
    try {
      const response = await fetch(url, {signal: AbortSignal.timeout(SERVER_POLL_INTERVAL_MS * 8)});
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await sleep(SERVER_POLL_INTERVAL_MS);
  }
  throw new Error(`${url} was not ready within ${timeoutMs} ms`);
}

export interface ManagedServer {
  name: string;
  readonly exited: boolean;
  stop(): Promise<void>;
}

/** Own process group, so stop() reaches tsx/vite grandchildren without touching anyone else's processes. */
export function startServer(name: string, command: string, args: readonly string[], options: CommandOptions & {logFile: string}): ManagedServer {
  const log = createWriteStream(options.logFile);
  const child: ChildProcess = spawn(command, args, {cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  let exited = false;
  const done = new Promise<void>(resolve => child.on('exit', () => {
    exited = true;
    resolve();
  }));
  // The leader may exit first (tsx, npm) while its children keep the port, so signal the group regardless.
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Group already gone.
    }
  };
  const groupAlive = () => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  return {
    name,
    get exited() {
      return exited;
    },
    async stop() {
      signalGroup('SIGTERM');
      const deadline = Date.now() + SERVER_STOP_GRACE_MS;
      while (groupAlive() && Date.now() < deadline) await sleep(SERVER_POLL_INTERVAL_MS);
      signalGroup('SIGKILL');
      await Promise.race([done, sleep(SERVER_STOP_GRACE_MS)]);
      log.end();
    },
  };
}
