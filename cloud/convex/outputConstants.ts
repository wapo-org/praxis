/** An uncommitted output older than this lost its commit (the turn retries within minutes), so the sweep removes it. */
export const OUTPUT_ORPHAN_AGE_MS = 86_400_000;
export const OUTPUT_SWEEP_INTERVAL_MINUTES = 60;
/** Bounds one sweep transaction; a full batch schedules the next one. */
export const OUTPUT_SWEEP_MANIFESTS_MAX = 100;
export const OUTPUT_SWEEP_CHUNKS_MAX = 1_000;
export const OUTPUT_ERRORS = {
  exists: 'Tool output id already in use',
  chunk: 'Tool output chunk does not match its manifest',
} as const;
