import {COMPOSIO_API} from '@praxis/protocol';
import {SealedSecret, type TenantId} from '@praxis/types';
import {z} from 'zod';

// Plain fetch, not `@composio/core`: no SDK dependency, and it runs in the Convex runtime as is.
/** Followed by the upper-cased toolkit slug, e.g. `COMPOSIO_AUTH_CONFIG_GITHUB`. */
export const COMPOSIO_AUTH_CONFIG_ENV_PREFIX = 'COMPOSIO_AUTH_CONFIG_';

export const COMPOSIO_ERROR_CODES = {
  notConfigured: 'composio_not_configured',
  invalidToolkit: 'composio_invalid_toolkit',
  http: 'composio_http_error',
  invalidResponse: 'composio_invalid_response',
} as const;
export type ComposioErrorCode = (typeof COMPOSIO_ERROR_CODES)[keyof typeof COMPOSIO_ERROR_CODES];

const TOOLKIT_SLUG_PATTERN = /^[a-z0-9_]+$/i;

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
  createConnectLink(input: {
    tenantId: TenantId;
    toolkit: string;
    callbackUrl: string;
  }): Promise<{redirectUrl: string; connectedAccountId: string; expiresAt: number}>;
  revokeConnection(connectedAccountId: string): Promise<void>;
}

const ConnectLinkResponseSchema = z.object({
  redirect_url: z.url({protocol: /^https$/}),
  connected_account_id: z.string().min(1),
  expires_at: z.iso.datetime({offset: true}),
});

function notConfigured(envName: string): ComposioError {
  return new ComposioError(COMPOSIO_ERROR_CODES.notConfigured, `${envName} is not set`);
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

/** Fails closed: without the API key there is no client at all. */
export function composioFor(env: Record<string, string | undefined>): ComposioClient {
  const rawKey = env[COMPOSIO_API.KEY_ENV];
  if (!rawKey) throw notConfigured(COMPOSIO_API.KEY_ENV);
  const apiKey = SealedSecret.of(rawKey);

  return {
    async createConnectLink({tenantId, toolkit, callbackUrl}) {
      const envName = `${COMPOSIO_AUTH_CONFIG_ENV_PREFIX}${normalizeToolkit(toolkit).toUpperCase()}`;
      const authConfigId = env[envName];
      if (!authConfigId) throw notConfigured(envName);

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
