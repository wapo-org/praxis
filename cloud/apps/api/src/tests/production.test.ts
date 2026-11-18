import {afterEach, describe, expect, it, vi} from 'vitest';
import {createHmac, randomBytes} from 'node:crypto';
import {ACCOUNT_DELETE_RECOVERY_SIGNATURE_HEADER} from '@praxis/protocol';
import type {Redis} from '@upstash/redis';
import {CONTINUATION_PATH, PRODUCTION_ENV, createProductionApp, readProductionEnv} from '../production.js';
import * as upstash from '../adapters/upstash.js';
import {fakeRedis} from '../adapters/testing/fake-redis.js';
import {createSmokeApp} from '../smoke.js';
import {createLocalAdapters} from '../local-memory.js';
import {createPraxisApp, jsonLog} from '../server.js';

const env = () => ({
  PRAXIS_TURN_CURRENT_SIGNING_KEY: 't'.repeat(32),
  PRAXIS_API_URL: 'https://api.praxis.test',
  PRAXIS_WEB_ORIGINS: 'https://app.praxis.test',
  PRAXIS_ENCRYPTION_KEYS: `${randomBytes(32).toString('base64')},${randomBytes(32).toString('base64')}`,
  CONVEX_URL: 'https://example-123.convex.cloud',
  PRAXIS_CONVEX_SERVER_TOKEN: 's'.repeat(40),
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'redis-token',
  QSTASH_TOKEN: 'qstash-token',
  QSTASH_CURRENT_SIGNING_KEY: 'sig_current',
  QSTASH_NEXT_SIGNING_KEY: 'sig_next',
});
afterEach(() => vi.unstubAllEnvs());

describe('production startup', () => {
  it('fails at startup listing every missing or malformed variable, never falling back', () => {
    let message = '';
    try { readProductionEnv({}); } catch (e) { message = (e as Error).message; }
    for (const name of PRODUCTION_ENV) expect(message).toContain(`${name} is missing`);
    expect(message).toContain('PRAXIS_ENCRYPTION_KEYS is missing');
    const bad = {...env(), PRAXIS_API_URL: 'http://api.praxis.test', PRAXIS_ENCRYPTION_KEYS: `${randomBytes(32).toString('base64')},short`, PRAXIS_CONVEX_SERVER_TOKEN: 'tiny'};
    expect(() => readProductionEnv(bad)).toThrow(/PRAXIS_API_URL must be an https URL[\s\S]*PRAXIS_ENCRYPTION_KEYS must list base64 keys of exactly 32 random bytes each[\s\S]*PRAXIS_CONVEX_SERVER_TOKEN must be at least 32 characters/);
  });

  it('composes with Convex Auth, Upstash and QStash without touching the network, and serves health + the signed continuation route', async () => {
    const {app, service} = createProductionApp(env());
    expect(service.local).toBe(false);
    expect(await (await app.request('/health')).json()).toMatchObject({mode: 'production'});
    expect((await app.request('/v1/auth/dev', {method: 'POST', body: '{}'})).status).toBe(404);
    expect((await app.request('/api/turn', {method: 'POST', body: '{}', headers: {cookie: 'praxis_session=fake'}})).status).toBe(401);
    expect((await app.request('/api/turn', {method: 'OPTIONS'})).status).toBe(405);
    expect((await app.request(CONTINUATION_PATH, {method: 'POST', body: '{}'})).status).toBe(401);
  });

  it('purges the verified owner and resumes committed work in a fresh app without the initiating bearer', async () => {
    const config = env();
    const userId = 'verified-owner';
    const sessionId = 'session-for-test';
    const memory = fakeRedis();
    const redis = upstash.upstashFromRedis(memory.redis, {accountOwnership: true});
    const redisFactory = vi.spyOn(upstash, 'createUpstashAdapters').mockReturnValue({redis: memory.redis as Redis, ...redis});
    const calls: string[] = [];
    let deleting = false;
    let erased = false;
    let committedBatches = 0;
    const convexFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const {path, args: [args]} = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      calls.push(path);
      let value: unknown;
      switch (path) {
        case 'account:deletionOwner':
          expect(headers.get('authorization')).toBe(`Bearer ${sessionId}`);
          value = erased ? null : {userId, pending: deleting};
          break;
        case 'account:confirmDeletion':
          expect(headers.get('authorization')).toBe(`Bearer ${sessionId}`);
          value = args.password === 'verified-test-password' || deleting ? {userId, sessionId} : null;
          break;
        case 'account:begin':
          expect(args).toEqual({userId, keepSessionId: sessionId, serverToken: config.PRAXIS_CONVEX_SERVER_TOKEN});
          deleting = true;
          value = null;
          break;
        case 'account:pending':
          expect(args).toEqual({userId, serverToken: config.PRAXIS_CONVEX_SERVER_TOKEN});
          value = deleting && !erased;
          break;
        case 'account:purge': {
          const call = calls.filter(item => item === path).length;
          expect(args).toEqual({
            userId, serverToken: config.PRAXIS_CONVEX_SERVER_TOKEN,
            ...(call <= 2 ? {keepSessionId: sessionId} : {}),
          });
          if (call === 2) return new Response('temporary failure', {status: 503});
          committedBatches++;
          erased = call >= 3;
          value = {done: erased};
          break;
        }
        case 'auth:currentUser':
          value = deleting ? null : userId;
          break;
        default:
          throw new Error(`Unexpected Convex function: ${path}`);
      }
      return Response.json({status: 'success', value});
    });
    vi.stubGlobal('fetch', convexFetch);
    try {
      const {app} = createProductionApp(config);
      const headers = {authorization: `Bearer ${sessionId}`, 'content-type': 'application/json'};
      const erase = (password?: string) => app.request('/v1/account', {
        method: 'DELETE', headers, body: JSON.stringify({password, userId: 'attacker-controlled-owner'}),
      });
      expect((await app.request('/v1/account', {method: 'DELETE'})).status).toBe(401);
      expect((await erase('incorrect-test-password')).status).toBe(403);
      expect(calls).toEqual(['account:deletionOwner', 'account:confirmDeletion']);
      expect((await erase('verified-test-password')).status).toBe(503);
      expect(committedBatches).toBe(1);
      expect((await app.request('/v1/bootstrap', {headers})).status).toBe(401);

      const freshApp = createProductionApp(config).app;
      const body = JSON.stringify({type: 'account.delete.resume', userId});
      const signature = createHmac('sha256', config.PRAXIS_CONVEX_SERVER_TOKEN).update(body).digest('hex');
      const recover = (payload: string) => freshApp.request(CONTINUATION_PATH, {
        method: 'POST', headers: {[ACCOUNT_DELETE_RECOVERY_SIGNATURE_HEADER]: signature}, body: payload,
      });
      expect((await recover(body.replace(userId, 'forged-owner'))).status).toBe(401);
      expect(committedBatches).toBe(1);
      expect((await recover(body)).status).toBe(200);
      expect(committedBatches).toBe(2);
      expect((await recover(body)).status).toBe(200);
      expect(committedBatches).toBe(2);
      expect((await erase()).status).toBe(401);
      expect((await freshApp.request('/v1/bootstrap', {headers})).status).toBe(401);
    } finally {
      redisFactory.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('refuses the smoke flag and the smoke app in production', () => {
    expect(() => createProductionApp({...env(), PRAXIS_LOCAL_SMOKE: '1'})).toThrow('PRAXIS_LOCAL_SMOKE');
    vi.stubEnv('VERCEL', '1');
    expect(() => createSmokeApp()).toThrow('not allowed in production');
  });
});

describe('request logging', () => {
  it('logs method, path, status and duration only: no query string, headers or body', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'info').mockImplementation((line: string) => { lines.push(line); });
    const openRouter = (async () => Response.json({data: {label: 'sk-or-v1-ver...key', limit: null, limit_remaining: null}})) as typeof fetch;
    const {app} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), log: jsonLog, fetcher: openRouter});
    await app.request('/v1/bootstrap?token=sk-live-secret', {headers: {Authorization: 'Bearer dev-local', Cookie: 'praxis_session=abc'}});
    const connected = await app.request('/v1/model-key', {method: 'POST', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, body: JSON.stringify({method: 'paste', apiKey: 'sk-or-v1-very-secret-key'})});
    expect(connected.status).toBe(200);
    spy.mockRestore();
    const all = lines.join('\n');
    expect(all).toContain('"path":"/v1/bootstrap"');
    for (const secret of ['sk-live-secret', 'dev-local', 'praxis_session', 'sk-or-v1-very-secret-key', 'very-secret', 'token=']) expect(all).not.toContain(secret);
  });
});

describe('rate limits', () => {
  it('limits per verified user after auth and per IP on public paths, answering 429 with Retry-After', async () => {
    const keys: string[] = [];
    const {app} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), rateLimit: async key => { keys.push(key); return keys.length > 1 ? {ok: false, retryAfterSeconds: 7} : {ok: true}; }});
    expect((await app.request('/v1/bootstrap', {headers: {Authorization: 'Bearer dev-local'}})).status).toBe(200);
    const limited = await app.request('/v1/bootstrap', {headers: {Authorization: 'Bearer dev-local'}});
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBeTruthy();
    expect(keys).toEqual(['user:local-user', 'user:local-user']);
  });
});
