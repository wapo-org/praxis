// Leave capacity for other scheduled jobs on Convex Free/Starter's eight-job limit.
export const WORKFLOW_PARALLELISM_MAX = 4;
export const STUB_TURNS_MAX = 3;
export const WORKFLOW_ERRORS = {
  unavailable: 'Run or chat unavailable',
  index: 'Unexpected turn index or generation',
  flags: 'Unsupported turn control flags',
} as const;
