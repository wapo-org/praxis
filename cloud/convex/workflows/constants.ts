// Leave capacity for other scheduled jobs on Convex Free/Starter's eight-job limit.
export const WORKFLOW_PARALLELISM_MAX = 4;
export const RUN_UNPARK_EVENT = 'run-unpark';
/** Worker 5xx, timeouts and unresolved 409s retry with backoff (2 s, 4 s, 8 s) before the run fails. */
export const TURN_ACTION_RETRY = {maxAttempts: 4, initialBackoffMs: 2_000, base: 2};
export const TURN_WORKER_URL_ENV = 'PRAXIS_API_URL';
export const WORKFLOW_ERRORS = {
  unavailable: 'Run or chat unavailable',
  index: 'Unexpected turn index or generation',
  flags: 'Unsupported turn control flags',
  conflict: 'Turn worker reported a conflict but no flags are saved',
  unconfigured: 'Turn worker is not configured',
  message: 'A turn commits only new assistant messages of its own run and chat',
  taint: 'Tainted tool results need run taint in the same commit',
  approval: 'A suspended turn needs a pending approval for the same call',
  exhausted: 'Turn index exhausted',
} as const;
