import {COMPOSIO_API, COMPOSIO_CATALOG_LIMITS, type ComposioApp, type ComposioAppPage} from '@praxis/protocol';
import {SealedSecret, type TenantId} from '@praxis/types';
import {z} from 'zod';

// Plain fetch, not `@composio/core`: no SDK dependency, and it runs in the Convex runtime as is.
/** Optional override followed by the upper-cased toolkit slug, e.g. `COMPOSIO_AUTH_CONFIG_GITHUB`. */
export const COMPOSIO_AUTH_CONFIG_ENV_PREFIX = 'COMPOSIO_AUTH_CONFIG_';
const AUTH_CONFIG_LIST_LIMIT = 50;

export const COMPOSIO_ERROR_CODES = {
  notConfigured: 'composio_not_configured',
  invalidToolkit: 'composio_invalid_toolkit',
  http: 'composio_http_error',
  invalidResponse: 'composio_invalid_response',
} as const;
export type ComposioErrorCode = (typeof COMPOSIO_ERROR_CODES)[keyof typeof COMPOSIO_ERROR_CODES];

const TOOLKIT_SLUG_PATTERN = /^[a-z0-9_]+$/i;
const HttpsUrlSchema = z.url({protocol: /^https$/});

/** Carries a stable code and HTTP status only: Composio error bodies can echo request data, so they are dropped. */
export class ComposioError extends Error {
  readonly code: ComposioErrorCode;
  readonly status: number | undefined;

  constructor(code: ComposioErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'ComposioError';
    this.code = code;
    this.status = status;
  }
}

export interface ComposioClient {
  listToolkits(input?: {search?: string; cursor?: string; limit?: number}): Promise<ComposioAppPage>;
  createConnectLink(input: {
    tenantId: TenantId;
    toolkit: string;
    callbackUrl: string;
  }): Promise<{redirectUrl: string; connectedAccountId: string; expiresAt: number}>;
  revokeConnection(connectedAccountId: string): Promise<void>;
}

const ConnectLinkResponseSchema = z.object({
  redirect_url: HttpsUrlSchema,
  connected_account_id: z.string().min(1),
  expires_at: z.iso.datetime({offset: true}),
});

const ToolkitListResponseSchema = z.object({
  items: z.array(z.object({
    slug: z.string().min(1),
    name: z.string().min(1),
    meta: z.object({
      description: z.string().default(''),
      logo: z.string().optional(),
    }),
  })),
  next_cursor: z.string().min(1).nullable().optional(),
  total_items: z.number().int().nonnegative(),
});

const AuthConfigListResponseSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    type: z.enum(['default', 'custom']).optional(),
    is_composio_managed: z.boolean().optional(),
    status: z.enum(['ENABLED', 'DISABLED']),
  })),
});

const AuthConfigCreateResponseSchema = z.object({
  auth_config: z.object({
    id: z.string().min(1),
  }),
});

function notConfigured(message: string, status?: number): ComposioError {
  return new ComposioError(COMPOSIO_ERROR_CODES.notConfigured, message, status);
}

export function normalizeToolkit(toolkit: string): string {
  if (!TOOLKIT_SLUG_PATTERN.test(toolkit)) {
    throw new ComposioError(COMPOSIO_ERROR_CODES.invalidToolkit, 'Toolkit slug must be letters, digits or _');
  }
  return toolkit.toLowerCase();
}

async function request(apiKey: SealedSecret, path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(`${COMPOSIO_API.BASE_URL}${path}`, {
      ...init,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        [COMPOSIO_API.KEY_HEADER]: apiKey.reveal(),
      },
    });
  } catch {
    throw new ComposioError(COMPOSIO_ERROR_CODES.http, 'Composio request failed');
  }
}

function httpError(operation: string, status: number): ComposioError {
  return new ComposioError(COMPOSIO_ERROR_CODES.http, `Composio ${operation} failed with HTTP ${status}`, status);
}

function clampPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return COMPOSIO_CATALOG_LIMITS.DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(COMPOSIO_CATALOG_LIMITS.MAX_PAGE_SIZE, Math.trunc(limit)));
}

function parseHttpsLogo(logo: string | undefined): string | undefined {
  if (!logo) return undefined;
  const parsed = HttpsUrlSchema.safeParse(logo);
  return parsed.success ? parsed.data : undefined;
}

/** Resolution order: explicit env pin → existing project auth config (custom preferred) → auto-created managed config. */
async function resolveAuthConfigId(
  apiKey: SealedSecret,
  env: Record<string, string | undefined>,
  toolkit: string,
): Promise<string> {
  const envName = `${COMPOSIO_AUTH_CONFIG_ENV_PREFIX}${toolkit.toUpperCase()}`;
  const pinned = env[envName]?.trim();
  if (pinned) return pinned;

  const query = new URLSearchParams({toolkit_slug: toolkit, limit: String(AUTH_CONFIG_LIST_LIMIT)});
  const listResponse = await request(apiKey, `/auth_configs?${query.toString()}`, {method: 'GET'});
  if (!listResponse.ok) throw httpError('auth config lookup', listResponse.status);

  const listParsed = AuthConfigListResponseSchema.safeParse(await listResponse.json().catch(() => undefined));
  if (!listParsed.success) {
    throw new ComposioError(COMPOSIO_ERROR_CODES.invalidResponse, 'Composio auth config list is malformed');
  }
  const enabled = listParsed.data.items.filter(item => item.status === 'ENABLED');
  const preferred = enabled.find(item => item.is_composio_managed === false || item.type === 'custom') ?? enabled[0];
  if (preferred) return preferred.id;

  const createResponse = await request(apiKey, '/auth_configs', {
    method: 'POST',
    body: JSON.stringify({
      toolkit: {slug: toolkit},
      auth_config: {type: 'use_composio_managed_auth'},
    }),
  });
  if (createResponse.status === 400 || createResponse.status === 404 || createResponse.status === 422) {
    throw notConfigured(`Create an auth config for ${toolkit} in Composio`, createResponse.status);
  }
  if (!createResponse.ok) throw httpError('auth config creation', createResponse.status);

  const createParsed = AuthConfigCreateResponseSchema.safeParse(await createResponse.json().catch(() => undefined));
  if (!createParsed.success) {
    throw new ComposioError(COMPOSIO_ERROR_CODES.invalidResponse, 'Composio auth config response is malformed');
  }
  return createParsed.data.auth_config.id;
}

/** Fails closed: without the API key there is no client at all. */
export function composioFor(env: Record<string, string | undefined>): ComposioClient {
  const rawKey = env[COMPOSIO_API.KEY_ENV];
  if (!rawKey) throw notConfigured(`${COMPOSIO_API.KEY_ENV} is not set`);
  const apiKey = SealedSecret.of(rawKey);

  return {
    async listToolkits(input = {}) {
      const params = new URLSearchParams({
        sort_by: 'usage',
        limit: String(clampPageSize(input.limit)),
      });
      const search = input.search?.trim().slice(0, COMPOSIO_CATALOG_LIMITS.SEARCH_CHARACTERS_MAX);
      if (search) params.set('search', search);
      if (input.cursor) params.set('cursor', input.cursor);

      const response = await request(apiKey, `/toolkits?${params.toString()}`, {method: 'GET'});
      if (!response.ok) throw httpError('toolkit catalog', response.status);

      const parsed = ToolkitListResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new ComposioError(COMPOSIO_ERROR_CODES.invalidResponse, 'Composio toolkit catalog is malformed');
      }
      const items: ComposioApp[] = parsed.data.items.map(item => {
        const logo = parseHttpsLogo(item.meta.logo);
        return {
          toolkit: item.slug.toLowerCase(),
          name: item.name,
          description: item.meta.description,
          ...(logo ? {logo} : {}),
        };
      });
      return {
        items,
        nextCursor: parsed.data.next_cursor ?? null,
        totalItems: parsed.data.total_items,
      };
    },

    async createConnectLink({tenantId, toolkit, callbackUrl}) {
      const normalized = normalizeToolkit(toolkit);
      const authConfigId = await resolveAuthConfigId(apiKey, env, normalized);

      // https://docs.composio.dev/reference/api-reference/connected-accounts/postConnectedAccountsLink
      const response = await request(apiKey, '/connected_accounts/link', {
        method: 'POST',
        body: JSON.stringify({auth_config_id: authConfigId, user_id: tenantId, callback_url: callbackUrl}),
      });
      if (!response.ok) throw httpError('connect link', response.status);

      const parsed = ConnectLinkResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new ComposioError(COMPOSIO_ERROR_CODES.invalidResponse, 'Composio connect link response is malformed');
      }
      return {
        redirectUrl: parsed.data.redirect_url,
        connectedAccountId: parsed.data.connected_account_id,
        expiresAt: Date.parse(parsed.data.expires_at),
      };
    },

    async revokeConnection(connectedAccountId) {
      // https://docs.composio.dev/reference/api-reference/connected-accounts/deleteConnectedAccountsByNanoid
      const path = `/connected_accounts/${encodeURIComponent(connectedAccountId)}?revoke_on_delete=true`;
      const response = await request(apiKey, path, {method: 'DELETE'});
      // An account that is already gone is the outcome revoking asks for.
      if (response.status === 404) return;
      if (!response.ok) throw httpError('revoke', response.status);
    },
  };
}
