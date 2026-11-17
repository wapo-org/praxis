export const VERIFY_AUTH = {
  password: 'browser mango zebra telescope orchard',
  resendKey: 'local-test-only',
  senderEmail: 'auth@example.test',
  senderName: 'Praxis verification',
  providerCredential: 'local-test-only',
} as const;
export const AUTH_BACKEND_PORT_OFFSET = 1;
export const AUTH_SITE_PORT_OFFSET = 2;
export const AUTH_START_TIMEOUT_MS = 120_000;
export const AUTH_FUNCTION_POLL_MS = 250;
export const AUTH_FIXTURE_FILES = ['auth.ts', 'authConstants.ts', 'auth.config.ts', 'convex.config.ts', 'schema.ts', 'users.ts'] as const;
