import {z} from 'zod';
import type {
  SessionCreateParams, SessionCreateResponse, SessionExecuteParams, SessionExecuteResponse, SessionSearchParams,
  SessionSearchResponse,
} from '@composio/client/resources/tool-router/session';
import type {ToolRetrieveResponse} from '@composio/client/resources/tools';
import {classifyHttp, CredentialSignalError, withCredential, type CooldownStore, type CredentialLog, type CredentialPool} from '@praxis/credentials';
import {COMPOSIO_API, COMPOSIO_FIREWALL_HOOK_ID, COMPOSIO_LIMITS} from '@praxis/protocol';
import type {SealedSecret} from '@praxis/types';
import {readLimited} from '../tools/http.js';

// Zod adapters for the pinned @composio/client 2.1.33 types; `satisfies` fails typecheck when the SDK shape drifts.
const HookResultSchema = z.discriminatedUnion('status', [
  z.object({id: z.string(), status: z.literal('evaluated'), outcome: z.enum(['continue', 'block'])}),
  z.object({id: z.string(), status: z.literal('unavailable')}),
]);
const HookResults = z.array(HookResultSchema).optional();
const FirewallHookSchema = z.object({
  type: z.literal('after_execute'), id: z.literal(COMPOSIO_FIREWALL_HOOK_ID), applies_to: z.literal('all'),
  handler: z.object({type: z.literal('prompt_injection_check'), action: z.literal('block')}),
});
type SdkFirewallHook = NonNullable<SessionCreateResponse['config']['hooks']>[number];
export const SessionCreatedSchema = z.object({
  session_id: z.string().min(1),
  // Echoed config proves the Firewall was applied to this session; any other hooks are irrelevant here.
  config: z.object({hooks: z.array(z.unknown()).refine(hooks => hooks.some(hook => FirewallHookSchema.safeParse(hook).success))}),
}) satisfies z.ZodType<Pick<SessionCreateResponse, 'session_id'>>;
FirewallHookSchema satisfies z.ZodType<SdkFirewallHook>;

const Completed = z.object({result_type: z.literal('completed'), data: z.record(z.string(), z.unknown()), error: z.string().nullable(),
  log_id: z.string(), hook_results: HookResults});
const Failed = Completed.extend({result_type: z.literal('failed')});
const Blocked = z.object({result_type: z.literal('blocked'), message: z.string(),
  reason: z.object({type: z.enum(['request_blocked', 'response_blocked']), hook_id: z.string()}), hook_results: HookResults});
const InputRequired = z.object({result_type: z.literal('input_required')});
export const ExecuteResultSchema = z.discriminatedUnion('result_type', [Completed, Failed, Blocked, InputRequired]);
export type ExecuteResult = z.infer<typeof ExecuteResultSchema>;
ExecuteResultSchema satisfies z.ZodType<Pick<SessionExecuteResponse, 'result_type'>>;

const SearchQueryResult = z.object({
  use_case: z.string(), primary_tool_slugs: z.array(z.string()), related_tool_slugs: z.array(z.string()),
  toolkits: z.array(z.string()), execution_guidance: z.string().optional(), known_pitfalls: z.array(z.string()).optional(),
  recommended_plan_steps: z.array(z.string()).optional(), error: z.string().nullable().optional(),
});
export const SearchResultSchema = z.object({
  success: z.boolean(), error: z.string().nullable(), results: z.array(SearchQueryResult),
  toolkit_connection_statuses: z.array(z.object({toolkit: z.string(), has_active_connection: z.boolean(), status_message: z.string()})),
  tool_schemas: z.record(z.string(), z.object({
    toolkit: z.string(), tool_slug: z.string(), description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(), hasFullSchema: z.boolean().optional(),
  })),
}) satisfies z.ZodType<Pick<SessionSearchResponse, 'success' | 'error'>>;
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const ToolMetadataSchema = z.object({
  slug: z.string().min(1), description: z.string(), toolkit: z.object({slug: z.string().min(1)}),
  input_parameters: z.record(z.string(), z.unknown()), tags: z.array(z.string()), is_deprecated: z.boolean(),
}) satisfies z.ZodType<Pick<ToolRetrieveResponse, 'slug' | 'description' | 'input_parameters' | 'tags' | 'is_deprecated'>>;
export type ToolMetadata = z.infer<typeof ToolMetadataSchema>;

/** Carries a status only: Composio error bodies can echo request data, so they are dropped. */
export class ComposioUpstreamError extends Error {
  constructor(readonly status: number) {
    super(`Composio request failed with HTTP ${status}`);
    this.name = 'ComposioUpstreamError';
  }
}

export interface ToolRouterClient {
  createSession(body: SessionCreateParams, signal: AbortSignal): Promise<z.infer<typeof SessionCreatedSchema>>;
  search(sessionId: string, body: SessionSearchParams, signal: AbortSignal): Promise<SearchResult>;
  execute(sessionId: string, body: SessionExecuteParams, signal: AbortSignal): Promise<ExecuteResult>;
  /** Trusted server-side metadata for classification; null when Composio has no such tool. */
  tool(slug: string, signal: AbortSignal): Promise<ToolMetadata | null>;
}
export interface ToolRouterTransport {
  pool: CredentialPool<SealedSecret>;
  cooldowns: CooldownStore;
  fetch: typeof fetch;
  log?: CredentialLog;
}

export function toolRouterClient(transport: ToolRouterTransport): ToolRouterClient {
  const session = (id: string, action: string) => `/tool_router/session/${encodeURIComponent(id)}/${action}`;
  return {
    async createSession(body, signal) {
      return SessionCreatedSchema.parse(await request(transport, 'POST', '/tool_router/session', body, signal));
    },
    async search(sessionId, body, signal) {
      return SearchResultSchema.parse(await request(transport, 'POST', session(sessionId, 'search'), body, signal));
    },
    async execute(sessionId, body, signal) {
      return ExecuteResultSchema.parse(await request(transport, 'POST', session(sessionId, 'execute'), body, signal));
    },
    async tool(slug, signal) {
      const raw = await request(transport, 'GET', `/tools/${encodeURIComponent(slug)}`, undefined, signal, true);
      return raw === null ? null : ToolMetadataSchema.parse(raw);
    },
  };
}

async function request(transport: ToolRouterTransport, method: 'GET' | 'POST', path: string, body: object | undefined,
  signal: AbortSignal, missingIsNull = false): Promise<unknown> {
  const result = await withCredential(transport.pool, transport.cooldowns, async credential => {
    const response = await transport.fetch(`${COMPOSIO_API.BASE_URL}${path}`, {
      method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(COMPOSIO_LIMITS.REQUEST_TIMEOUT_MS)]),
      headers: {'content-type': 'application/json', [COMPOSIO_API.KEY_HEADER]: credential.reveal()},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    // A 403 refuses this request (e.g. a disabled toolkit), not the key, so it must not cool the only slot.
    const signalled = response.status === 403 ? {kind: 'ok' as const} : classifyHttp(response.status, response.headers);
    if (signalled.kind !== 'ok') {
      await response.body?.cancel();
      throw new CredentialSignalError(signalled);
    }
    if (missingIsNull && response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ComposioUpstreamError(response.status);
    }
    return JSON.parse(new TextDecoder().decode(await readLimited(response.body, COMPOSIO_LIMITS.RESPONSE_BYTES_MAX))) as unknown;
  }, transport.log ? {log: transport.log} : {});
  return result.value;
}
