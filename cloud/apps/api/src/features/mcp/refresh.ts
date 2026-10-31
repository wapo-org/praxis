import {refreshAuthorization} from '@modelcontextprotocol/sdk/client/auth.js';
import type {AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {Connector} from '@praxis/protocol';
import type {FeatureContext} from '../../contracts.js';
import {guardedFetch, now, readSecret, writeSecret, type McpOptions} from './shared.js';

/** What finishOAuth persists so later refreshes need no interactive discovery. */
export interface SavedDiscovery {authorizationServerUrl: string; metadata?: AuthorizationServerMetadata; resource: string}

const EARLY_MS = 60_000;
const inflight = new Map<string, Promise<OAuthTokens | undefined>>();

function expired(tokens: OAuthTokens, savedAt: string | undefined): boolean {
  if (!tokens.expires_in || !savedAt) return false;
  return Date.parse(savedAt) + tokens.expires_in * 1000 - EARLY_MS <= Date.now();
}

/**
 * Returns usable OAuth tokens for a connector, refreshing them shortly before expiry (or when `force`d after
 * a 401). Single-flight per connector: concurrent callers in this process share one refresh, and across
 * instances `options.lease` (Redis in production) lets only one instance spend the refresh token; the others
 * wait briefly and re-read the tokens it saved. Returns undefined when no refresh is possible.
 */
export async function ensureFreshTokens(ctx: FeatureContext, value: Connector, options: McpOptions, force = false): Promise<OAuthTokens | undefined> {
  const tokens = await readSecret<OAuthTokens>(ctx, value.id, 'tokens');
  if (!tokens) return undefined;
  if (!force && !expired(tokens, await readSecret<string>(ctx, value.id, 'tokenSavedAt'))) return tokens;
  if (!tokens.refresh_token) return force ? undefined : tokens;
  const key = `${ctx.userId}:${value.id}`;
  const running = inflight.get(key);
  if (running) return running;
  const work = refresh(ctx, value, options, tokens).finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

async function refresh(ctx: FeatureContext, value: Connector, options: McpOptions, stale: OAuthTokens): Promise<OAuthTokens | undefined> {
  const leaseKey = `mcp:refresh:${ctx.userId}:${value.id}`;
  const token = options.lease ? await options.lease.acquire(leaseKey, 30_000) : 'local';
  if (!token) {
    // Another instance holds the refresh: wait for the tokens it saves instead of spending the refresh token twice.
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 300));
      const current = await readSecret<OAuthTokens>(ctx, value.id, 'tokens');
      if (current && current.access_token !== stale.access_token) return current;
    }
    return undefined;
  }
  try {
    const current = await readSecret<OAuthTokens>(ctx, value.id, 'tokens');
    if (current && current.access_token !== stale.access_token) return current;
    const discovery = await readSecret<SavedDiscovery>(ctx, value.id, 'discovery');
    const client = await readSecret<OAuthClientInformationMixed>(ctx, value.id, 'client');
    if (!discovery || !client || !stale.refresh_token) return undefined;
    const next = await refreshAuthorization(discovery.authorizationServerUrl, {
      ...(discovery.metadata ? {metadata: discovery.metadata} : {}),
      clientInformation: client,
      refreshToken: stale.refresh_token,
      resource: discovery.resource,
      fetchFn: guardedFetch(ctx, options),
    });
    const saved = {...next, refresh_token: next.refresh_token ?? stale.refresh_token};
    await writeSecret(ctx, value.id, 'tokens', saved);
    await writeSecret(ctx, value.id, 'tokenSavedAt', now());
    return saved;
  } catch {
    return undefined;
  } finally {
    if (options.lease && token !== 'local') await options.lease.release(leaseKey, token);
  }
}
