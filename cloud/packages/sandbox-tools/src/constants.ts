/** Every chat works in its own directory on the user's Volume (PRA-19 decision). */
export const WORKSPACE_ROOT = '/workspace';
/** Tool bookkeeping (jobs, diagnostics config) lives here; checkpoints never commit it. */
export const PRAXIS_DIR = '.praxis';
export const DIAGNOSTICS_CONFIG = '.praxis/diagnostics.json';
/** Jobs die with the sandbox, so their records live on its own disk (not the Volume), in a root-owned path, not /tmp. */
export const JOBS_DIR = '/var/lib/praxis/jobs';

export const SHELL_TIMEOUT_DEFAULT_MS = 30_000;
/** Longer work goes to the background and is polled with wait_for_job, so no call blocks a turn. */
export const SHELL_TIMEOUT_MAX_MS = 120_000;
/** Per stream; the head and tail are kept and the middle is elided. */
export const OUTPUT_MAX_BYTES = 16_384;
export const READ_FILE_MAX_BYTES = 1_048_576;
export const READ_FILE_LINES_DEFAULT = 400;
export const EXPORT_FILE_MAX_BYTES = 26_214_400;
export const WAIT_FOR_JOB_DEFAULT_MS = 30_000;
export const WAIT_FOR_JOB_MAX_MS = 120_000;
export const JOB_POLL_INTERVAL_MS = 500;
/** All configured checks for one edit share this budget, so diagnostics never dominate a turn. */
export const DIAGNOSTICS_BUDGET_MS = 20_000;
export const DIAGNOSTICS_PROBLEMS_MAX = 50;
export const GIT_TIMEOUT_MS = 30_000;

export const NOTEBOOK_ARTIFACTS_MAX = 32;
export const NOTEBOOK_STARTUP_SECONDS = 15;
export const NOTEBOOK_INTERRUPT_SECONDS = 5;
/** The outer exec must outlive the driver deadline so it can return its recovery result. */
export const NOTEBOOK_EXEC_MARGIN_MS = 5_000;
export const NOTEBOOK_EXEC_ALLOWANCE_MS = (NOTEBOOK_STARTUP_SECONDS + NOTEBOOK_INTERRUPT_SECONDS) * 1_000 + NOTEBOOK_EXEC_MARGIN_MS;
