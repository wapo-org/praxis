import {spawn} from 'node:child_process';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {execBackedJobs} from './exec-jobs.js';
import type {ExecRequest, ExecResult, FileStat, SandboxPort} from './port.js';

/** Real processes on this machine; tests and local development only, never apps/api (R5 bans child_process there). */
export function localExec(request: ExecRequest): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const [command, ...args] = request.argv;
    if (!command) return reject(new Error('empty argv'));
    const child = spawn(command, args, {cwd: request.cwd, env: {...process.env, ...request.env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, request.timeoutMs);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({exitCode: 127, stdout, stderr: `${stderr}${error.message}`, timedOut: false, durationMs: Date.now() - started});
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({exitCode: timedOut ? null : code, stdout, stderr, timedOut, durationMs: Date.now() - started});
    });
  });
}

async function localStat(path: string): Promise<FileStat | undefined> {
  try {
    const info = await stat(path);
    return {type: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other', size: info.size};
  } catch {
    return undefined;
  }
}

const files = {
  stat: localStat,
  readFile: async (path: string) => new Uint8Array(await readFile(path)),
  writeFile: async (path: string, bytes: Uint8Array) => {
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, bytes);
  },
};

/** Paths are host paths; give the tools a temp directory as their root. */
export function localSandboxPort(jobsDir: string): SandboxPort {
  return {exec: localExec, ...files, ...execBackedJobs(localExec, jobsDir)};
}
