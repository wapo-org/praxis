/** Same keyring `apps/api` seals with: comma-separated base64 32-byte keys, current first. */
export const ENCRYPTION_KEYRING_ENV = 'PRAXIS_ENCRYPTION_KEYS';
export const ENCRYPTION_KEY_ENV = 'PRAXIS_ENCRYPTION_KEY';
export const ENCRYPTION_KEY_BYTES = 32;
export const MODEL_KEY_KIND = 'modelKey';
export const MODEL_KEY_ID = 'current';
/** AES-GCM authenticated-data resource for the OpenRouter key, as `apps/api/src/openrouter/keys.ts` seals it. */
export const MODEL_KEY_RESOURCE = 'modelKey';
export const LEDGER_KIND = 'turnLedger';
/** One attempt's model call plus its tools; well under the 30-minute Convex-runtime action limit, retried by the workflow. */
export const TURN_DEADLINE_MS = 600_000;
/** History beyond this fails closed until context shortening (PRA-46) lands; a query reads at most 16 MiB. */
export const HISTORY_MESSAGES_MAX = 2_000;
export const AGENT_ERRORS = {
  encryption: 'Secret storage is not configured',
  sealed: 'The OpenRouter key could not be read',
  history: 'Chat history is too long for one turn',
  fenced: 'The run left this turn',
} as const;
