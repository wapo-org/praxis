import {posix} from 'node:path';
import type {ExecRequest, ExecResult, ExportSink, FileStat, JobStatus, SandboxPort} from './port.js';

export type FakeCommand = (request: ExecRequest, port: FakeSandboxPort) => Partial<ExecResult> | undefined;

/** In-process SandboxPort for unit tests: an in-memory filesystem and scripted commands, no processes. */
export class FakeSandboxPort implements SandboxPort {
  readonly files = new Map<string, Uint8Array>();
  readonly calls: ExecRequest[] = [];
  readonly #commands: FakeCommand[] = [];
  readonly #jobs = new Map<string, {status: JobStatus; pollsLeft: number; final: Partial<ExecResult>}>();
  #nextJob = 1;

  constructor(readonly clock: () => number = Date.now) {}

  /** First handler that returns a result wins; unmatched commands exit 127 like a missing binary. */
  on(command: FakeCommand): this {
    this.#commands.push(command);
    return this;
  }

  writeText(path: string, text: string): this {
    this.files.set(path, new TextEncoder().encode(text));
    return this;
  }

  readText(path: string): string | undefined {
    const bytes = this.files.get(path);
    return bytes && new TextDecoder().decode(bytes);
  }

  #run(request: ExecRequest): Partial<ExecResult> {
    for (const command of this.#commands) {
      const result = command(request, this);
      if (result) return result;
    }
    return {exitCode: 127, stderr: `${request.argv[0]}: not found`};
  }

  async exec(request: ExecRequest): Promise<ExecResult> {
    this.calls.push(request);
    return {exitCode: 0, stdout: '', stderr: '', timedOut: false, durationMs: 1, ...this.#run(request)};
  }

  /** The job reports `running` for `pollsBeforeExit` status reads, then the scripted result. */
  async startJob(request: Omit<ExecRequest, 'timeoutMs'>, pollsBeforeExit = 2): Promise<{id: string}> {
    this.calls.push({...request, timeoutMs: 0});
    const id = `job-${this.#nextJob++}`;
    const final = this.#run({...request, timeoutMs: 0});
    this.#jobs.set(id, {status: {id, state: 'running', exitCode: null, stdout: '', stderr: '', startedAtMs: this.clock()}, pollsLeft: pollsBeforeExit, final});
    return {id};
  }

  async jobStatus(id: string): Promise<JobStatus | undefined> {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    if (job.status.state === 'running' && job.pollsLeft-- <= 0) {
      job.status = {...job.status, state: 'exited', exitCode: job.final.exitCode ?? 0, stdout: job.final.stdout ?? '', stderr: job.final.stderr ?? ''};
    }
    return job.status;
  }

  async listJobs(): Promise<JobStatus[]> {
    return [...this.#jobs.values()].map(job => job.status);
  }

  /** `link(from, to)` makes every path under `from` resolve under `to`, like a directory symlink. */
  readonly links = new Map<string, string>();

  link(from: string, to: string): this {
    this.links.set(from, to);
    return this;
  }

  async realpath(path: string): Promise<string> {
    for (const [from, to] of this.links) {
      if (path === from || path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
    }
    return path;
  }

  async stat(path: string): Promise<FileStat | undefined> {
    const file = this.files.get(path);
    if (file) return {type: 'file', size: file.length};
    const prefix = path.endsWith('/') ? path : `${path}/`;
    return [...this.files.keys()].some(key => key.startsWith(prefix)) ? {type: 'directory', size: 0} : undefined;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`ENOENT: ${path}`);
    return file;
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(posix.normalize(path), bytes);
  }
}

export class MemoryExportSink implements ExportSink {
  readonly items: {name: string; mediaType: string; bytes: Uint8Array; sha256: string}[] = [];

  async put(input: {name: string; mediaType: string; bytes: Uint8Array; sha256: string}): Promise<{ref: string}> {
    this.items.push(input);
    return {ref: `export-${this.items.length}`};
  }
}
