import {posix} from 'node:path';
import {SandboxFilesystemNotFoundError, type Sandbox} from 'modal';
import {execBackedJobs} from '../exec-jobs.js';
import type {ExecRequest, ExecResult, FileStat, SandboxPort} from '../port.js';

/** Modal reports a killed exec as 128 + SIGKILL. */
const KILLED_EXIT_CODE = 137;
/** Modal rejects exec time-outs that are not whole seconds (found by the PRA-77 adapter check). */
const MODAL_TIMEOUT_STEP_MS = 1_000;
const REALPATH_TIMEOUT_MS = 10_000;

async function drain(stream: ReadableStream<string>): Promise<string> {
  let text = '';
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) text += next.value;
  return text;
}

/** Modal's native exec and filesystem (PRA-100: no in-sandbox server); boot and reaping stay with PRA-52 and PRA-55. */
export function modalSandboxPort(sandbox: Sandbox): SandboxPort {
  const exec = async (request: ExecRequest): Promise<ExecResult> => {
    const started = Date.now();
    const timeoutMs = Math.max(MODAL_TIMEOUT_STEP_MS, Math.ceil(request.timeoutMs / MODAL_TIMEOUT_STEP_MS) * MODAL_TIMEOUT_STEP_MS);
    const process = await sandbox.exec([...request.argv], {workdir: request.cwd, timeoutMs, ...(request.env ? {env: {...request.env}} : {})});
    const [stdout, stderr, exitCode] = await Promise.all([drain(process.stdout), drain(process.stderr), process.wait()]);
    const durationMs = Date.now() - started;
    const timedOut = exitCode === KILLED_EXIT_CODE && durationMs >= timeoutMs;
    return {exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut, durationMs};
  };
  const files = {
    async realpath(path: string): Promise<string> {
      const resolved = await exec({argv: ['realpath', '-m', '--', path], cwd: '/', timeoutMs: REALPATH_TIMEOUT_MS});
      if (resolved.exitCode !== 0) throw new Error(`realpath failed for ${path}: ${resolved.stderr.trim()}`);
      return resolved.stdout.trim();
    },
    async stat(path: string): Promise<FileStat | undefined> {
      try {
        const info = await sandbox.filesystem.stat(path);
        return {type: info.type === 'file' || info.type === 'directory' ? info.type : 'other', size: info.size};
      } catch (error) {
        if (error instanceof SandboxFilesystemNotFoundError) return undefined;
        throw error;
      }
    },
    readFile: (path: string) => sandbox.filesystem.readBytes(path),
    async writeFile(path: string, bytes: Uint8Array) {
      await sandbox.filesystem.makeDirectory(posix.dirname(path));
      await sandbox.filesystem.writeBytes(bytes, path);
    },
  };
  return {exec, ...files, ...execBackedJobs(exec)};
}
