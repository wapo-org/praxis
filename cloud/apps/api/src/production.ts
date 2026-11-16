import {pool, redisCooldownStore, type CredentialLogEvent} from '@praxis/credentials';
import {accountEraser} from './account-deletion.js';
import {createConvexRPC} from './adapters/convex.js';
import {createAuth, parseOrigins} from './adapters/auth.js';
import {createConvexStore} from './adapters/convex.js';
import {createQStashScheduler, createQStashVerifier} from './adapters/qstash.js';
import {createSafeFetch} from './adapters/security.js';
import {createRateLimiter, createUpstashAdapters} from './adapters/upstash.js';
import {createConvexToolsStorage} from './features/tools/convex-storage.js';
import {GROQ_POOL} from './features/tools/transcribe.js';
import {featureModules} from './modules.js';
import {createPraxisApp, jsonLog} from './server.js';
import {productionEmbedder} from './embedding.js';
import {convexVectorIndex} from './search-index.js';

/** Required production env vars; any missing/invalid stops startup. */
export const PRODUCTION_ENV = [
  'PRAXIS_API_URL',
  'PRAXIS_WEB_ORIGINS',
  'CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
  'CLERK_JWT_KEY',
  'CONVEX_URL',
  'PRAXIS_CONVEX_SERVER_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'QSTASH_TOKEN',
  'QSTASH_CURRENT_SIGNING_KEY',
  'QSTASH_NEXT_SIGNING_KEY',
] as const;

export type ProductionEnv = Record<(typeof PRODUCTION_ENV)[number], string> & {PRAXIS_ENCRYPTION_KEYS?: string; PRAXIS_ENCRYPTION_KEY?: string; PRAXIS_RUN_BUDGET_MS?: string; PRAXIS_COOKIE_SAMESITE?: string; GROQ_API_KEY?: string};

export const CONTINUATION_PATH = '/internal/continue';

/** Optional pooled platform keys using un-gapped _2, _3, ... suffixes. */
export const PLATFORM_POOLS: readonly PoolSpec[] = [{service: 'groq', names: GROQ_POOL}];
export interface PoolSpec {service: string; names: string | readonly string[]}
export interface ReadEnvOptions {pools?: readonly PoolSpec[]; warn?: (message: string) => void}

const readPool = (spec: PoolSpec, env: Record<string, string | undefined>) => (typeof spec.names === 'string' ? pool(spec.names, env, {service: spec.service}) : pool(spec.names, env, {service: spec.service}));
const warnJson = (message: string) => console.warn(JSON.stringify({type: 'startup.warning', message}));
/** Pool events carry the service name and slot numbers only. */
const credentialLog = (event: CredentialLogEvent) => console.warn(JSON.stringify({type: 'credentials', ...event}));

/** Keyring ordered current-first, with single PRAXIS_ENCRYPTION_KEY fallback. */
export function encryptionKeyring(env: Record<string, string | undefined>): string | undefined {
  return (env.PRAXIS_ENCRYPTION_KEYS ?? env.PRAXIS_ENCRYPTION_KEY)?.trim() || undefined;
}

export function readProductionEnv(env: Record<string, string | undefined>, options: ReadEnvOptions = {}): ProductionEnv {
  if (env.PRAXIS_LOCAL_DATA_DIR !== undefined) throw new Error('PRAXIS_LOCAL_DATA_DIR is only supported by dev:local');
  const problems: string[] = [];
  for (const name of PRODUCTION_ENV) if (!env[name]?.trim()) problems.push(`${name} is missing`);
  const https = (name: string) => {
    const v = env[name];
    if (!v) return;
    try {
      if (new URL(v).protocol !== 'https:') problems.push(`${name} must be an https URL`);
    } catch {
      problems.push(`${name} must be a URL`);
    }
  };
  for (const name of ['PRAXIS_API_URL', 'CONVEX_URL', 'UPSTASH_REDIS_REST_URL']) https(name);
  if (env.PRAXIS_API_URL && /\/.+/.test(new URL(env.PRAXIS_API_URL, 'https://x').pathname)) problems.push('PRAXIS_API_URL must be an origin without a path');
  const ring = encryptionKeyring(env);
  if (!ring) problems.push('PRAXIS_ENCRYPTION_KEYS is missing (comma-separated base64 32-byte keys, current first; PRAXIS_ENCRYPTION_KEY is accepted for a single key)');
  else if (ring.split(',').some(k => Buffer.from(k.trim(), 'base64').length !== 32)) problems.push('PRAXIS_ENCRYPTION_KEYS must list base64 keys of exactly 32 random bytes each');
  for (const name of ['PRAXIS_CONVEX_SERVER_TOKEN']) if (env[name] && env[name]!.length < 32) problems.push(`${name} must be at least 32 characters`);
  if (env.PRAXIS_RUN_BUDGET_MS && !(Number(env.PRAXIS_RUN_BUDGET_MS) >= 10_000)) problems.push('PRAXIS_RUN_BUDGET_MS must be a number of milliseconds ≥ 10000');
  if (env.PRAXIS_WEB_ORIGINS) {
    try {
      parseOrigins(env.PRAXIS_WEB_ORIGINS);
    } catch {
      problems.push('PRAXIS_WEB_ORIGINS must be a comma-separated list of https origins');
    }
  }
  // Half-defined credential slots fail closed; post-gap slots warn.
  const warnings: string[] = [];
  for (const spec of options.pools ?? PLATFORM_POOLS) {
    try {
      warnings.push(...readPool(spec, env).warnings);
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  if (problems.length) throw new Error(`Praxis API cannot start in production:\n- ${problems.join('\n- ')}\nSee cloud/DEPLOY.md.`);
  for (const warning of warnings) (options.warn ?? warnJson)(warning);
  return env as ProductionEnv;
}

export function createProductionApp(rawEnv: Record<string, string | undefined>, hooks: {defer?: (work: Promise<unknown>) => void} = {}) {
  if (rawEnv.PRAXIS_LOCAL_SMOKE) throw new Error('PRAXIS_LOCAL_SMOKE must not be set in production');
  if (rawEnv.PRAXIS_LOCAL_DATA_DIR) throw new Error('PRAXIS_LOCAL_DATA_DIR is only supported by dev:local');
  const env = readProductionEnv(rawEnv);
  const origin = new URL(env.PRAXIS_API_URL).origin;
  const webOrigins = parseOrigins(env.PRAXIS_WEB_ORIGINS);
  const upstash = createUpstashAdapters({url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN,accountOwnership:true});
  const store = createConvexStore({url: env.CONVEX_URL, serverToken: env.PRAXIS_CONVEX_SERVER_TOKEN});
  const storage = createConvexToolsStorage({url: env.CONVEX_URL, serverToken: env.PRAXIS_CONVEX_SERVER_TOKEN, baseUrl: origin});
  const accountRPC=createConvexRPC({url:env.CONVEX_URL,serverToken:env.PRAXIS_CONVEX_SERVER_TOKEN});
  const auth = createAuth(rawEnv, upstash.kv,{isActive:upstash.ownership.isActive,activate:userId=>upstash.ownership.activate(userId,async()=>!!await accountRPC.query('account:active',{userId}))});
  const egress = createSafeFetch();
  // Semantic search: off unless an embedder is configured (PRAXIS_EMBEDDER / PRAXIS_OPENAI_EMBEDDINGS_KEY).
  const embedder = productionEmbedder(rawEnv);
  const callbackUrl = `${origin}${CONTINUATION_PATH}`;
  return createPraxisApp({
    adapters: {store, kv: upstash.kv, events: upstash.events},
    local: false,
    encryptionKey: encryptionKeyring(env)!,
    // Provider base URLs are user-supplied, so model calls use the same SSRF guard as tools and MCP.
    fetcher: egress,
    allowedOrigins: webOrigins,
    resolveSession: request => auth.resolveSession(request),
    authHandler: request => auth.handler(request),
    accountDeletion:{confirm:auth.confirmDeletion,purge:accountEraser(accountRPC,upstash.ownership,auth.deleteExternal)},
    rateLimit: createRateLimiter(upstash.redis),
    scheduler: createQStashScheduler({token: env.QSTASH_TOKEN, callbackUrl}),
    lease: upstash.lease,
    continuation: {path: CONTINUATION_PATH, verify: createQStashVerifier({currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY, nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY, callbackUrl})},
    ...(env.PRAXIS_RUN_BUDGET_MS ? {budgetMs: Number(env.PRAXIS_RUN_BUDGET_MS)} : {}),
    ...(hooks.defer ? {defer: hooks.defer} : {}),
    ...(embedder ? {search: {embedder, vectors: convexVectorIndex(accountRPC)}} : {}),
    log: jsonLog,
    modules: service => featureModules(service, {
      storage,
      platformVoice: {pool: pool(GROQ_POOL, rawEnv, {service: 'groq'}), cooldowns: redisCooldownStore(upstash.redis), log: credentialLog},
      mcp: {publicOrigin: origin, webReturnOrigins: webOrigins, safeFetch: egress, consumeOAuthState: key => upstash.consumeOnce(key), lease: upstash.lease},
    }),
  });
}
