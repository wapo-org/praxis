import {spawn} from 'node:child_process';
import {mkdir, readFile, realpath, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {execBackedJobs} from './exec-jobs.js';
import type {ExecRequest, ExecResult, FileStat, SandboxPort} from './port.js';

/** Real processes on this machine; tests and local development only, never apps/api (R5 bans child_process there). */
export function localExec(request: ExecRequest): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const [command, ...args] = request.argv;
    if (!command) return reject(new Error('empty argv'));
    // Own process group, so a timeout kills the command's descendants too and their pipes close at the deadline.
    const child = spawn(command, args, {cwd: request.cwd, env: {...process.env, ...request.env}, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
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

/** Resolves the longest existing prefix and re-appends the rest, like `realpath -m`. */
async function localRealpath(path: string): Promise<string> {
  const rest: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch {
      if (dirname(current) === current) return path;
      rest.push(basename(current));
    }
  }
}

const files = {
  realpath: localRealpath,
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
