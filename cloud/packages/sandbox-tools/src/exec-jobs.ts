import {randomUUID} from 'node:crypto';
import {posix} from 'node:path';
import {z} from 'zod';
import {JOBS_DIR} from './constants.js';
import type {ExecRequest, ExecResult, JobStatus, SandboxPort} from './port.js';

type Exec = (request: ExecRequest) => Promise<ExecResult>;

/** Detaches the job from the exec call, records its exit code atomically, and never shares the caller's stdio. */
const START = 'dir="$1"; started="$2"; shift 2; mkdir -p "$dir" && echo "$started" >"$dir/started" || exit 1; ( "$@" >"$dir/stdout" 2>"$dir/stderr" </dev/null; echo $? >"$dir/exit.tmp" && mv "$dir/exit.tmp" "$dir/exit" ) >/dev/null 2>&1 </dev/null &';
/** One round trip per status read; streams are base64 so any byte (NUL included) survives the line framing. */
const STATUS = 'cd "$1" 2>/dev/null || exit 3; printf "%s\\n%s\\n" "$(cat started)" "$(cat exit 2>/dev/null)"; base64 < stdout 2>/dev/null | tr -d "\\n"; echo; base64 < stderr 2>/dev/null | tr -d "\\n"; echo';
const NOT_FOUND_EXIT = 3;
const JOB_ID = /^[0-9a-f-]{36}$/;
const QUICK_EXEC_MS = 15_000;
/** started ms, exit code (empty while running), stdout and stderr as base64: anything else is a broken sandbox reply. */
const StatusLines = z.tuple([z.string().regex(/^\d+$/), z.string().regex(/^(\d+)?$/), z.string().regex(/^[A-Za-z0-9+/=]*$/), z.string().regex(/^[A-Za-z0-9+/=]*$/)]);

/** Background jobs for any port that can exec `sh`: Modal and the local port share it. */
export function execBackedJobs(exec: Exec, jobsDir = JOBS_DIR): Pick<SandboxPort, 'startJob' | 'jobStatus' | 'listJobs'> {
  const status = async (id: string): Promise<JobStatus | undefined> => {
    if (!JOB_ID.test(id)) return undefined;
    const result = await exec({argv: ['sh', '-c', STATUS, 'praxis-status', posix.join(jobsDir, id)], cwd: '/', timeoutMs: QUICK_EXEC_MS});
    if (result.exitCode === NOT_FOUND_EXIT) return undefined;
    if (result.timedOut || result.exitCode !== 0) throw new Error(`job status read failed: ${result.timedOut ? 'timed out' : `exit ${result.exitCode}`} ${result.stderr.trim()}`.trim());
    const [started, exit, stdout, stderr] = StatusLines.parse(result.stdout.split('\n').slice(0, 4));
    const decode = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');
    return {id, state: exit === '' ? 'running' : 'exited', exitCode: exit === '' ? null : Number(exit), stdout: decode(stdout), stderr: decode(stderr), startedAtMs: Number(started)};
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
