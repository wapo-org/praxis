// Leave capacity for other scheduled jobs on Convex Free/Starter's eight-job limit.
export const WORKFLOW_PARALLELISM_MAX = 4;
export const RUN_UNPARK_EVENT = 'run-unpark';
/** Turns per workflow generation before continue-as-new; a full generation journals about 35 KB of 8 MiB. */
export const GENERATION_TURNS_MAX = 40;
/** Provider 5xx and 429s, deadlines and uncertain tool calls retry with backoff (2 s, 4 s, 8 s) before the run fails. */
export const TURN_ACTION_RETRY = {maxAttempts: 4, initialBackoffMs: 2_000, base: 2};
export const WORKFLOW_ERRORS = {
  unavailable: 'Run or chat unavailable',
  index: 'Unexpected turn index or generation',
  flags: 'Unsupported turn control flags',
  message: 'A turn commits only new assistant messages of its own run and chat',
  taint: 'Tainted tool results need run taint in the same commit',
  approval: 'A suspended turn needs a pending approval for the same call',
  exhausted: 'Turn index exhausted',
} as const;
