import type {Hono} from 'hono';
import type {User} from '@praxis/protocol';
import {createApp} from './app.js';
import type {AdapterBundle, FeatureContext} from './contracts.js';
import {createExecutionDriver, type ContinuationScheduler, type ExecutionFeatures} from './execution.js';
import {ApiService} from './service.js';

/** Feature modules plugged in by the entry point (MCP, tools). */
export interface FeatureModule {
  /** Mounted under /v1 after auth. */
  routes?(contextFor: (request: Request) => Promise<FeatureContext>): Hono<any>;
  /** /v1 paths that must skip session auth (OAuth callbacks). */
  publicPaths?: string[];
  execution?: ExecutionFeatures;
}

export interface PraxisDeps {
  adapters: AdapterBundle;
  local: boolean;
  encryptionKey?: string;
  fetcher?: typeof fetch;
  allowedOrigins?: string[];
  resolveSession?: (request: Request) => Promise<{user: User; expiresAt: string} | null>;
  authHandler?: (request: Request) => Promise<Response>;
  rateLimit?: (key: string) => Promise<{ok: boolean; retryAfterSeconds?: number}>;
  scheduler?: ContinuationScheduler;
  /** Keeps background slices alive after the response (Vercel `waitUntil`). */
  defer?: (work: Promise<unknown>) => void;
  budgetMs?: number;
  modules?: FeatureModule[];
  log?: (record: {requestId: string; method: string; path: string; status: number; durationMs: number}) => void;
}

/** One composition root for the local dev server, tests and the Vercel entry. */
export function createPraxisApp(deps: PraxisDeps) {
  const service = new ApiService(deps.adapters, deps.local);
  if (deps.defer) service.defer = deps.defer;
  const modules = deps.modules ?? [];
  const features = mergeExecutionFeatures(modules.flatMap(m => (m.execution ? [m.execution] : [])));
  const driver = createExecutionDriver({
    service,
    features,
    ...(deps.scheduler ? {scheduler: deps.scheduler} : {}),
    ...(deps.budgetMs ? {budgetMs: deps.budgetMs} : {}),
    ...(deps.encryptionKey ? {encryptionKey: deps.encryptionKey} : {}),
    ...(deps.fetcher ? {fetcher: deps.fetcher} : {}),
  });
  service.driver = driver;
  const {app, session} = createApp({
    service,
    ...(deps.encryptionKey ? {encryptionKey: deps.encryptionKey} : {}),
    ...(deps.fetcher ? {fetcher: deps.fetcher} : {}),
    ...(deps.allowedOrigins ? {allowedOrigins: deps.allowedOrigins} : {}),
    ...(deps.resolveSession ? {resolveSession: deps.resolveSession} : {}),
    ...(deps.authHandler ? {authHandler: deps.authHandler} : {}),
    ...(deps.rateLimit ? {rateLimit: deps.rateLimit} : {}),
    ...(deps.log ? {log: deps.log} : {}),
    publicPaths: modules.flatMap(m => m.publicPaths ?? []),
    mount: (root, contextFor) => {
      for (const m of modules) if (m.routes) root.route('/v1', m.routes(contextFor));
    },
  });
  return {app, service, driver, session};
}

function mergeExecutionFeatures(list: ExecutionFeatures[]): ExecutionFeatures {
  return {
    tools: async (ctx, input) => (await Promise.all(list.map(f => f.tools?.(ctx, input) ?? []))).flat(),
    skills: async ctx => (await Promise.all(list.map(f => f.skills?.(ctx) ?? []))).flat(),
    toolNotes: async (ctx, chat) => (await Promise.all(list.map(f => f.toolNotes?.(ctx, chat) ?? []))).flat(),
  };
}

/** Request log line: never bodies, queries, cookies or credentials. */
export function jsonLog(record: {requestId: string; method: string; path: string; status: number; durationMs: number}) {
  console.info(JSON.stringify({type: 'request', ...record, path: record.path.replace(/[A-Za-z0-9_-]{40,}/g, '[id]')}));
}
