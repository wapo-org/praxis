import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import {JOB_POLL_INTERVAL_MS, SHELL_TIMEOUT_DEFAULT_MS, SHELL_TIMEOUT_MAX_MS, WAIT_FOR_JOB_DEFAULT_MS, WAIT_FOR_JOB_MAX_MS} from '../constants.js';
import type {JobStatus} from '../port.js';
import {capOutput, containedPath, fail, stripAnsi} from '../support.js';
import type {SandboxToolContext} from './context.js';

export const ShellInputSchema = z.object({
  /** Classified by PRA-76's shellPolicy before this runs (see registry.ts). */
  command: z.string().min(1),
  /** Each call starts fresh in this directory; `cd` and `export` do not carry over between calls. */
  cwd: z.string().default('.'),
  timeout_ms: z.number().int().positive().max(SHELL_TIMEOUT_MAX_MS).default(SHELL_TIMEOUT_DEFAULT_MS),
  /** Returns a job id at once; poll it with wait_for_job. */
  background: z.boolean().default(false),
}).strict();

export const WaitForJobInputSchema = z.object({
  job_id: z.string().min(1),
  timeout_ms: z.number().int().positive().max(WAIT_FOR_JOB_MAX_MS).default(WAIT_FOR_JOB_DEFAULT_MS),
}).strict();

function streams(stdout: string, stderr: string) {
  const out = capOutput(stripAnsi(stdout));
  const err = capOutput(stripAnsi(stderr));
  return {stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated};
}

export async function shell(context: SandboxToolContext, raw: unknown) {
  const input = ShellInputSchema.parse(raw);
  const {path: cwd} = await containedPath(context.port, context.root, input.cwd);
  const argv = ['sh', '-c', input.command];
  if (input.background) {
    const {id} = await context.port.startJob({argv, cwd});
    return {background: true as const, job_id: id, hint: 'Poll with wait_for_job; do not sleep in a loop.'};
  }
  const result = await context.port.exec({argv, cwd, timeoutMs: input.timeout_ms});
  if (result.timedOut) fail('timeout', `The command was stopped after ${input.timeout_ms} ms.`);
  return {background: false as const, exitCode: result.exitCode, durationMs: result.durationMs, ...streams(result.stdout, result.stderr)};
}

function jobView(job: JobStatus, now: number) {
  return {job_id: job.id, state: job.state, exitCode: job.exitCode, elapsedMs: now - job.startedAtMs, ...streams(job.stdout, job.stderr)};
}

/** Structured status with a bounded wait: a still-running job is a normal answer, not an error, so the model polls again. */
export async function waitForJob(context: SandboxToolContext, raw: unknown) {
  const input = WaitForJobInputSchema.parse(raw);
  const now = context.now ?? Date.now;
  const sleep = context.sleep ?? (ms => delay(ms));
  const deadline = now() + input.timeout_ms;
  for (;;) {
    const job = await context.port.jobStatus(input.job_id);
    if (!job) fail('not-found', `No job ${input.job_id} in this sandbox.`);
    if (job.state === 'exited' || now() >= deadline) return jobView(job, now());
    await sleep(Math.min(JOB_POLL_INTERVAL_MS, Math.max(0, deadline - now())));
  }
}
