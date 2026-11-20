import {z} from 'zod';

/** One definition for the Convex connection actions and the API's Tool Router client. */
export const COMPOSIO_API = {
  BASE_URL: 'https://backend.composio.dev/api/v3.1',
  KEY_ENV: 'COMPOSIO_API_KEY',
  KEY_HEADER: 'x-api-key',
  TENANT_ID_SECRET_ENV: 'PRAXIS_TENANT_ID_SECRET',
} as const;

/** Model-facing Tool Router meta-tools; app tools are reached only through these names (PRA-48). */
export const COMPOSIO_META_TOOL_NAMES = {
  search: 'COMPOSIO_SEARCH_TOOLS',
  schemas: 'COMPOSIO_GET_TOOL_SCHEMAS',
  multiExecute: 'COMPOSIO_MULTI_EXECUTE_TOOL',
} as const;
export const COMPOSIO_LIMITS = {
  // Matches the PRA-76 boundary: larger batches deny instead of being split.
  BATCH_ACTIONS_MAX: 100,
  SEARCH_QUERIES_MAX: 5,
  USE_CASE_CHARACTERS_MAX: 1_024,
  KNOWN_FIELDS_CHARACTERS_MAX: 500,
  SCHEMA_SLUGS_MAX: 20,
  TOOL_SLUG_CHARACTERS_MAX: 128,
  // Below the runner's 32k cut so the untrusted-data envelope survives; the full result is spilled.
  RESULT_CHARACTERS_MAX: 24_000,
  RESPONSE_BYTES_MAX: 4_000_000,
  REQUEST_TIMEOUT_MS: 60_000,
  PARALLEL_CALLS_MAX: 8,
} as const;
/** Composio tags (MCP hints) the server reads from trusted tool metadata, never from the model. */
export const COMPOSIO_TOOL_HINTS = {
  readOnly: 'readOnlyHint',
  destructive: 'destructiveHint',
  create: 'createHint',
  update: 'updateHint',
} as const;
/** Hook id echoed in Composio `hook_results` and `blocked.reason.hook_id`. */
export const COMPOSIO_FIREWALL_HOOK_ID = 'praxis-firewall';
export const COMPOSIO_CONNECTOR_PREFIX = 'composio:';
export function composioConnectorId(toolkit: string): string {
  return `${COMPOSIO_CONNECTOR_PREFIX}${toolkit}`;
}

/** The curated launch catalogue (PRA-16); each toolkit also needs its server-side Composio auth config. */
export const COMPOSIO_APPS = [
  {toolkit: 'gmail', name: 'Gmail', description: 'Read, search and send email'},
  {toolkit: 'googlecalendar', name: 'Google Calendar', description: 'See and schedule events'},
  {toolkit: 'googledrive', name: 'Google Drive', description: 'Find and read files'},
  {toolkit: 'slack', name: 'Slack', description: 'Read channels and post messages'},
  {toolkit: 'notion', name: 'Notion', description: 'Search and edit pages'},
  {toolkit: 'github', name: 'GitHub', description: 'Work with repositories, issues and pull requests'},
  {toolkit: 'linear', name: 'Linear', description: 'Track and update issues'},
] as const satisfies readonly {toolkit: string; name: string; description: string}[];
export type ComposioApp = (typeof COMPOSIO_APPS)[number];

/** The per-chat app fields of `Chat`, typed structurally so this module does not import the chat schema. */
export interface ComposioChatScope {
  connectorIds: readonly string[];
  disabledConnectorIds: readonly string[];
}

/** Chat scope: a disabled toolkit drops out; a chat that names Composio connectors allows only those. */
export function composioEnabledInChat(chat: ComposioChatScope, toolkit: string): boolean {
  const id = composioConnectorId(toolkit);
  const named = chat.connectorIds.filter(connectorId => connectorId.startsWith(COMPOSIO_CONNECTOR_PREFIX));
  return !chat.disabledConnectorIds.includes(id) && (!named.length || named.includes(id));
}

/** The chat patch that turns one toolkit on or off under the same scope rules. */
export function composioChatScopePatch(chat: ComposioChatScope, toolkit: string, enabled: boolean): {
  connectorIds: string[];
  disabledConnectorIds: string[];
} {
  const id = composioConnectorId(toolkit);
  const disabledConnectorIds = chat.disabledConnectorIds.filter(connectorId => connectorId !== id);
  if (!enabled) return {connectorIds: [...chat.connectorIds], disabledConnectorIds: [...disabledConnectorIds, id]};

  const named = chat.connectorIds.some(connectorId => connectorId.startsWith(COMPOSIO_CONNECTOR_PREFIX));
  const connectorIds = chat.connectorIds.filter(connectorId => connectorId !== id);
  return {connectorIds: named ? [...connectorIds, id] : connectorIds, disabledConnectorIds};
}

/** Display name for a toolkit slug; a slug outside the catalogue shows as itself. */
export function composioAppName(toolkit: string): string {
  return COMPOSIO_APPS.find(app => app.toolkit === toolkit)?.name ?? toolkit;
}

// Nested meta-tools are an unsupported wrapper shape, so the reserved prefix never parses as an app action.
const ToolSlugSchema = z.string().regex(/^(?!COMPOSIO_)[A-Za-z0-9_]+$/).max(COMPOSIO_LIMITS.TOOL_SLUG_CHARACTERS_MAX);
const ActionArgumentsSchema = z.record(z.string(), z.json());
export const ComposioMultiExecuteInputSchema = z.object({
  tools: z.array(z.object({tool_slug: ToolSlugSchema, arguments: ActionArgumentsSchema}).strict())
    .min(1).max(COMPOSIO_LIMITS.BATCH_ACTIONS_MAX),
}).strict();
export const ComposioSearchInputSchema = z.object({
  queries: z.array(z.object({
    use_case: z.string().trim().min(1).max(COMPOSIO_LIMITS.USE_CASE_CHARACTERS_MAX),
    known_fields: z.string().max(COMPOSIO_LIMITS.KNOWN_FIELDS_CHARACTERS_MAX).optional(),
  }).strict()).min(1).max(COMPOSIO_LIMITS.SEARCH_QUERIES_MAX),
}).strict();
export const ComposioGetSchemasInputSchema = z.object({
  tool_slugs: z.array(ToolSlugSchema).min(1).max(COMPOSIO_LIMITS.SCHEMA_SLUGS_MAX),
}).strict();
export type ComposioMultiExecuteInput = z.infer<typeof ComposioMultiExecuteInputSchema>;
export type ComposioSearchInput = z.infer<typeof ComposioSearchInputSchema>;
export type ComposioGetSchemasInput = z.infer<typeof ComposioGetSchemasInputSchema>;

/** Tool result content that asks the client to open the inline connect flow for these toolkits. */
export const ComposioConnectRequiredSchema = z.object({
  type: z.literal('composio.connect-required'),
  toolkits: z.array(z.object({toolkit: z.string().min(1), connectorId: z.string().min(1)})).min(1),
}).strict();
export type ComposioConnectRequired = z.infer<typeof ComposioConnectRequiredSchema>;

// Server-token RPC between the API and Convex; both boundaries parse these shapes.
export const ComposioOwnerRequestSchema = z.object({userId: z.string().min(1)}).strict();
export const ComposioConnectedAccountSchema = z.object({
  toolkit: z.string().min(1), connectedAccountId: z.string().min(1),
}).strict();
export const ComposioConnectedAccountsSchema = z.array(ComposioConnectedAccountSchema);
export const COMPOSIO_USAGE_PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
export const ComposioUsageRequestSchema = z.object({
  userId: z.string().min(1), runId: z.string().min(1), callId: z.string().min(1),
  period: z.string().regex(COMPOSIO_USAGE_PERIOD_PATTERN),
  executions: z.number().int().min(1).max(COMPOSIO_LIMITS.BATCH_ACTIONS_MAX),
}).strict();
export type ComposioConnectedAccount = z.infer<typeof ComposioConnectedAccountSchema>;
export type ComposioUsageRequest = z.infer<typeof ComposioUsageRequestSchema>;
