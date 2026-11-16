/** What the sandbox tools need from a container; Modal, a local temp dir and the in-memory fake implement it. */
export interface ExecRequest {
  /** No shell is involved unless argv asks for one; the shell tool passes `['sh', '-c', command]` after policy. */
  argv: readonly string[];
  /** Absolute path inside the sandbox. */
  cwd: string;
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface ExecResult {
  /** null when the process was killed for exceeding `timeoutMs`. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export type JobState = 'running' | 'exited';

export interface JobStatus {
  id: string;
  state: JobState;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAtMs: number;
}

export interface FileStat {
  type: 'file' | 'directory' | 'other';
  size: number;
}

export interface SandboxPort {
  exec(request: ExecRequest): Promise<ExecResult>;
  /** Starts a background process that outlives the call; its status is read later, possibly in another turn. */
  startJob(request: Omit<ExecRequest, 'timeoutMs'>): Promise<{id: string}>;
  /** Never blocks; undefined for an unknown id. */
  jobStatus(id: string): Promise<JobStatus | undefined>;
  listJobs(): Promise<JobStatus[]>;
  /** undefined when the path does not exist. */
  stat(path: string): Promise<FileStat | undefined>;
  readFile(path: string): Promise<Uint8Array>;
  /** Creates parent directories. */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
}

/** Where export_file hands bytes to durable storage (Convex File Storage, PRA-12/PRA-54). */
export interface ExportSink {
  put(input: {name: string; mediaType: string; bytes: Uint8Array; sha256: string}): Promise<{ref: string}>;
}
