import {pool, redisCooldownStore, type CredentialLog, type RedisLike} from '@praxis/credentials';
import {COMPOSIO_API, ComposioConnectedAccountsSchema, ComposioOwnerRequestSchema, ComposioUsageRequestSchema} from '@praxis/protocol';
import {deriveTenantId, SealedSecret, TENANT_SECRET_MIN_BYTES} from '@praxis/types';
import type {FeatureContext} from '../../contracts.js';
import type {ConvexRPC} from '../../adapters/convex.js';
import {spillWebOutput} from '../web/output.js';
import {toolRouterClient} from './client.js';
import {COMPOSIO_POOL_SERVICE} from './constants.js';
import type {ComposioPorts} from './ports.js';

/** Startup check: an API key without the tenant secret could not derive Composio user ids, so startup stops. */
export function composioEnvProblems(env: Record<string, string | undefined>): string[] {
  if (!env[COMPOSIO_API.KEY_ENV]?.trim()) return [];
  const secret = env[COMPOSIO_API.TENANT_ID_SECRET_ENV] ?? '';
  return new TextEncoder().encode(secret).byteLength < TENANT_SECRET_MIN_BYTES
    ? [`${COMPOSIO_API.TENANT_ID_SECRET_ENV} must be at least ${TENANT_SECRET_MIN_BYTES} bytes when ${COMPOSIO_API.KEY_ENV} is set`]
    : [];
}

/** App tools are offered only when a Composio key is configured; there is no keyless fallback. */
export function productionComposioPorts(context: FeatureContext, rpc: ConvexRPC, redis: RedisLike,
  env: Record<string, string | undefined>, log?: CredentialLog): ComposioPorts | undefined {
  const keys = pool(COMPOSIO_API.KEY_ENV, env, {service: COMPOSIO_POOL_SERVICE});
  if (!keys.slots.length) return undefined;
  const secret = SealedSecret.of(env[COMPOSIO_API.TENANT_ID_SECRET_ENV] ?? '');
  return {
    router: toolRouterClient({pool: keys, cooldowns: redisCooldownStore(redis), fetch: context.fetch, ...(log ? {log} : {})}),
    tenantId: userId => deriveTenantId(userId, secret),
    async connectedAccounts(userId) {
      const request = ComposioOwnerRequestSchema.parse({userId});
      return ComposioConnectedAccountsSchema.parse(await rpc.query('composio/server:connectedAccounts', {request}));
    },
    async recordUsage(usage) {
      await rpc.mutation('composio/server:recordUsage', {request: ComposioUsageRequestSchema.parse(usage)});
    },
    spill: input => spillWebOutput(context.store, input),
  };
}
