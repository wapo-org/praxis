import type {Hono} from 'hono';
import type {User} from '@praxis/protocol';
import {createApp} from './app.js';
import type {AdapterBundle, FeatureContext} from './contracts.js';
import {createExecutionDriver, type ContinuationScheduler, type ExecutionFeatures, type RunLease} from './execution.js';
import {ContinuationAuthError} from './adapters/qstash.js';
import {ApiService} from './service.js';

/** Feature modules plugged in by the entry point (MCP, tools). */
export interface FeatureModule {
  deleteAccount?(userId:string):Promise<void>;
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
  accountDeletion?:{confirm(request:Request,password?:string):Promise<{userId:string;sessionId:string}|null>;purge(userId:string,sessionId:string):Promise<void>};
  rateLimit?: (key: string) => Promise<{ok: boolean; retryAfterSeconds?: number}>;
  scheduler?: ContinuationScheduler;
  /** Keeps background slices alive after the response (Vercel `waitUntil`). */
  defer?: (work: Promise<unknown>) => void;
  budgetMs?: number;
  /** Shared run lease (Redis in production) so one executor advances a run at a time across instances. */
  lease?: RunLease;
  /** Signed continuation callback (production): verifies a delivery and returns the run to advance. */
  continuation?: {path: string; verify: (request: Request) => Promise<{userId: string; runId: string}>};
  /** Test hook for slice budgets. */
  clock?: () => number;
  /** Feature modules, or a factory that receives the service (modules need provider resolution). */
  modules?: FeatureModule[] | ((service: ApiService) => FeatureModule[]);
  log?: (record: {requestId: string; method: string; path: string; status: number; durationMs: number}) => void;
}

/** One composition root for the local dev server, tests and the Vercel entry. */
export function createPraxisApp(deps: PraxisDeps) {
  const service = new ApiService(deps.adapters, deps.local);
  if (deps.defer) service.defer = deps.defer;
  const modules = typeof deps.modules === 'function' ? deps.modules(service) : (deps.modules ?? []);
  const features = mergeExecutionFeatures(modules.flatMap(m => (m.execution ? [m.execution] : [])));
  const driver = createExecutionDriver({
    service,
    features,
    ...(deps.scheduler ? {scheduler: deps.scheduler} : {}),
    ...(deps.budgetMs ? {budgetMs: deps.budgetMs} : {}),
    ...(deps.lease ? {lease: deps.lease} : {}),
    ...(deps.clock ? {clock: deps.clock} : {}),
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
    ...(deps.accountDeletion ? {accountDeletion:deps.accountDeletion} : deps.local ? {accountDeletion:{purge:async(userId:string)=>{for(const module of modules)await module.deleteAccount?.(userId);await deps.adapters.purgeOwner?.(userId);}}} : {}),
    ...(deps.rateLimit ? {rateLimit: deps.rateLimit} : {}),
    ...(deps.log ? {log: deps.log} : {}),
    publicPaths: modules.flatMap(m => m.publicPaths ?? []),
    mount: (root, contextFor) => {
      for (const m of modules) if (m.routes) root.route('/v1', m.routes(contextFor));
    },
  });
  if (deps.continuation) {
    const {path, verify} = deps.continuation;
    // Outside /v1: no session; authenticity comes only from the signed delivery. The slice runs inside this
    // request so a failure returns 5xx and QStash redelivers (duplicates are fenced by the run lease + CAS).
    app.post(path, async c => {
      let message: {userId: string; runId: string};
      try {
        message = await verify(c.req.raw);
      } catch (error) {
        if (error instanceof ContinuationAuthError) return c.json({type: 'error', code: 'unauthorized', message: 'Invalid continuation signature'}, 401);
        return c.json({type: 'error', code: 'invalid_continuation', message: 'Invalid continuation'}, 400);
      }
      await driver.continue(message.userId, message.runId);
      return c.json({type: 'ok'});
    });
  }
  return {app, service, driver, session};
}

function mergeExecutionFeatures(list: ExecutionFeatures[]): ExecutionFeatures {
  return {
    tools: async (ctx, input) => (await Promise.all(list.map(f => f.tools?.(ctx, input) ?? []))).flat(),
    agentTools: async (ctx, input) => (await Promise.all(list.map(f => f.agentTools?.(ctx, input) ?? []))).flat(),
    skills: async ctx => (await Promise.all(list.map(f => f.skills?.(ctx) ?? []))).flat(),
    toolNotes: async (ctx, chat) => (await Promise.all(list.map(f => f.toolNotes?.(ctx, chat) ?? []))).flat(),
    media: async (ctx, part, capabilities) => {
      let current = part;
      for (const f of list) if (f.media) current = await f.media(ctx, current, capabilities);
      return current;
    },
    turnNotes: async (ctx, chat, previous) => (await Promise.all(list.map(f => f.turnNotes?.(ctx, chat, previous) ?? []))).flat(),
  };
}

/** Request log line: never bodies, queries, cookies or credentials. */
export function jsonLog(record: {requestId: string; method: string; path: string; status: number; durationMs: number}) {
  console.info(JSON.stringify({type: 'request', ...record, path: record.path.replace(/[A-Za-z0-9_-]{40,}/g, '[id]')}));
}
