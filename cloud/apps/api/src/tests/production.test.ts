import {afterEach, describe, expect, it, vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {CONTINUATION_PATH, PRODUCTION_ENV, createProductionApp, readProductionEnv} from '../production.js';
import {createSmokeApp} from '../smoke.js';
import {createLocalAdapters} from '../local-memory.js';
import {createPraxisApp, jsonLog} from '../server.js';

const env = (): Record<string, string> => ({
  PRAXIS_API_URL: 'https://api.praxis.test',
  PRAXIS_WEB_ORIGINS: 'https://app.praxis.test',
  PRAXIS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  BETTER_AUTH_SECRET: 'b'.repeat(40),
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
    const bad = {...env(), PRAXIS_API_URL: 'http://api.praxis.test', PRAXIS_ENCRYPTION_KEY: 'short', BETTER_AUTH_SECRET: 'tiny'};
    expect(() => readProductionEnv(bad)).toThrow(/PRAXIS_API_URL must be an https URL[\s\S]*PRAXIS_ENCRYPTION_KEY must be base64 of exactly 32 random bytes[\s\S]*BETTER_AUTH_SECRET must be at least 32 characters/);
  });

  it('composes with Convex/Upstash/QStash/Better Auth without touching the network, and serves health + the signed continuation route', async () => {
    const {app, service} = createProductionApp(env());
    expect(service.local).toBe(false);
    expect(await (await app.request('/health')).json()).toMatchObject({mode: 'production'});
    expect((await app.request('/v1/auth/dev', {method: 'POST', body: '{}'})).status).toBe(404);
    expect((await app.request(CONTINUATION_PATH, {method: 'POST', body: '{}'})).status).toBe(401);
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
    const {app} = createPraxisApp({adapters: createLocalAdapters(), local: true, encryptionKey: randomBytes(32).toString('base64'), log: jsonLog});
    await app.request('/v1/bootstrap?token=sk-live-secret', {headers: {Authorization: 'Bearer dev-local', Cookie: 'praxis_session=abc'}});
    await app.request('/v1/providers', {method: 'POST', headers: {Authorization: 'Bearer dev-local', 'Content-Type': 'application/json'}, body: JSON.stringify({type: 'provider.input', name: 'P', flavor: 'openAIChat', baseUrl: 'https://p.example/v1', apiKey: 'sk-very-secret-key'})});
    spy.mockRestore();
    const all = lines.join('\n');
    expect(all).toContain('"path":"/v1/bootstrap"');
    for (const secret of ['sk-live-secret', 'dev-local', 'praxis_session', 'sk-very-secret-key', 'token=']) expect(all).not.toContain(secret);
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
