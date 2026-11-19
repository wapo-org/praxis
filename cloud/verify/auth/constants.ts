export const VERIFY_AUTH = {
  resendKey: 'local-test-only',
  senderEmail: 'auth@example.test',
  senderName: 'Praxis verification',
  providerCredential: 'local-test-only',
} as const;
export const AUTH_BACKEND_PORT_OFFSET = 1;
export const AUTH_SITE_PORT_OFFSET = 2;
export const AUTH_START_TIMEOUT_MS = 120_000;
export const AUTH_FUNCTION_POLL_MS = 250;
// Keep the dependency closure intact so the fixture deploy can bundle the real owner queries.
export const AUTH_FIXTURE_FILES = [
  'auth.ts', 'authConstants.ts', 'auth.config.ts', 'convex.config.ts', 'schema.ts', 'users.ts',
  'access.ts', 'account.ts', 'accountOwner.ts', 'accountRecovery.ts', 'accountTables.ts', 'blobOwner.ts', 'functions.ts',
  'workflows/agentRun.ts', 'workflows/constants.ts', 'workflows/purge.ts', 'workflows/validators.ts',
] as const;
