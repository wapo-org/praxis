export const VERIFY_AUTH = {
  resendKey: 'local-test-only',
  senderEmail: 'auth@example.test',
  senderName: 'Praxis verification',
  providerCredential: 'local-test-only',
} as const;
/** Composio connection fixture: env the real connect action needs, plus the stand-ins copied over the real modules. */
export const VERIFY_COMPOSIO = {
  tenantIdSecret: 'local-verification-tenant-secret-not-for-production',
  /** Copied from `cloud/verify/auth/<source>` to `<deployment>/convex/<target>`, replacing the real module. */
  replacements: [
    {source: 'composio/client.ts.template', target: 'composio/client.ts'},
    {source: 'composio/returnTarget.ts.template', target: 'composio/returnTarget.ts'},
    {source: 'http.ts.template', target: 'http.ts'},
  ],
} as const;
export const AUTH_BACKEND_PORT_OFFSET = 1;
export const AUTH_SITE_PORT_OFFSET = 2;
export const AUTH_START_TIMEOUT_MS = 120_000;
export const AUTH_FUNCTION_POLL_MS = 250;
// Keep the dependency closure intact so the fixture deploy can bundle the real owner queries.
export const AUTH_FIXTURE_FILES = [
  'auth.ts', 'authConstants.ts', 'auth.config.ts', 'convex.config.ts', 'composio/schema.ts', 'context/constants.ts', 'context/tables.ts', 'domainSchema.ts', 'schema.ts', 'users.ts',
  'access.ts', 'account.ts', 'accountOwner.ts', 'accountRecovery.ts', 'accountTables.ts', 'blobOwner.ts', 'boundedRead.ts', 'functions.ts', 'listConstants.ts',
  'workflows/agentRun.ts', 'workflows/constants.ts', 'workflows/purge.ts', 'workflows/validators.ts',
  'composio/actions.ts', 'composio/connections.ts', 'composio/connectionStore.ts', 'composio/constants.ts',
] as const;
