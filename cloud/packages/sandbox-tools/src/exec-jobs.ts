import {randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import {JOBS_DIR} from './constants.js';
import type {ExecRequest, ExecResult, JobStatus, SandboxPort} from './port.js';

type Exec = (request: ExecRequest) => Promise<ExecResult>;

/** Detaches the job from the exec call, records its exit code atomically, and never shares the caller's stdio. */
const START = 'dir="$1"; started="$2"; shift 2; mkdir -p "$dir" && echo "$started" >"$dir/started" || exit 1; ( "$@" >"$dir/stdout" 2>"$dir/stderr" </dev/null; echo $? >"$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit" ) >/dev/null 2>&1 </dev/null &';
/** One round trip per status read: Modal file calls cost about a second each, an exec about the same for all four files. */
const STATUS = 'cd "$1" 2>/dev/null || exit 3; cat started; printf "\\0"; cat exit 2>/dev/null; printf "\\0"; cat stdout 2>/dev/null; printf "\\0"; cat stderr 2>/dev/null';
const NOT_FOUND_EXIT = 3;
const JOB_ID = /^[0-9a-f-]{36}$/;
const QUICK_EXEC_MS = 15_000;

/** Background jobs for any port that can exec `sh`: Modal and the local port share it. */
export function execBackedJobs(exec: Exec, jobsDir = JOBS_DIR): Pick<SandboxPort, 'startJob' | 'jobStatus' | 'listJobs'> {
  const status = async (id: string): Promise<JobStatus | undefined> => {
    if (!JOB_ID.test(id)) return undefined;
    const result = await exec({argv: ['sh', '-c', STATUS, 'praxis-status', posix.join(jobsDir, id)], cwd: '/', timeoutMs: QUICK_EXEC_MS});
    if (result.exitCode === NOT_FOUND_EXIT) return undefined;
    const [started = '', exit = '', stdout = '', stderr = ''] = result.stdout.split('\0');
    return {
      id,
      state: exit.trim() ? 'exited' : 'running',
      exitCode: exit.trim() ? Number.parseInt(exit.trim(), 10) : null,
      stdout,
      stderr,
      startedAtMs: Number.parseInt(started.trim(), 10),
    };
  };
  return {
    async startJob(request) {
      const id = randomUUID();
      const argv = ['sh', '-c', START, 'praxis-job', posix.join(jobsDir, id), String(Date.now()), ...request.argv];
      const started = await exec({argv, cwd: request.cwd, ...(request.env ? {env: request.env} : {}), timeoutMs: QUICK_EXEC_MS});
      if (started.exitCode !== 0) throw new Error(`could not start the job: ${started.stderr.trim() || `exit ${started.exitCode}`}`);
      return {id};
    },
    jobStatus: status,
    async listJobs() {
      const listing = await exec({argv: ['ls', '-1', jobsDir], cwd: '/', timeoutMs: QUICK_EXEC_MS});
      const ids = listing.exitCode === 0 ? listing.stdout.split('\n').filter(id => JOB_ID.test(id)) : [];
      const jobs = await Promise.all(ids.map(status));
      return jobs.filter((job): job is JobStatus => !!job).sort((a, b) => a.startedAtMs - b.startedAtMs);
    },
  };
}
