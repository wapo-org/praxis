import {afterEach, describe, expect, it, vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {Hono} from 'hono';
import {memoryCooldownStore, pool, redisCooldownStore, type CredentialLogEvent} from '@praxis/credentials';
import {fakeRedis} from '../adapters/testing/fake-redis.js';
import {createApp} from '../app.js';
import type {FeatureContext} from '../contracts.js';
import {createToolsRoutes} from '../features/tools/index.js';
import type {ToolsPorts} from '../features/tools/ports.js';
import {createLocalAdapters} from '../local-memory.js';
import {PLATFORM_POOLS, readProductionEnv} from '../production.js';
import {seal} from '../secrets.js';
import {ApiService} from '../service.js';
import {fixtures} from './fixture.js';

afterEach(() => vi.unstubAllEnvs());

const KEYS = {GROQ_API_KEY: 'gsk_first-secret', GROQ_API_KEY_2: 'gsk_second-secret'};
const AUDIO = {type: 'transcribe.request', audioBase64: 'AAAA'};

/** The tools routes in production mode with a pooled platform Groq credential and a scripted Groq. */
function voice(groq: (bearer: string) => Response, env: Record<string, string> = KEYS, ports: ToolsPorts = {}) {
  const events: CredentialLogEvent[] = [];
  const bearers: string[] = [];
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get('Authorization') ?? '';
    bearers.push(bearer);
    return groq(bearer);
  });
  const ctx: FeatureContext = {...createLocalAdapters(), userId: 'alice', local: false, fetch: fetcher as unknown as typeof fetch, egress: vi.fn(), encryptionKey: Buffer.alloc(32, 3).toString('base64')};
  const cooldowns = memoryCooldownStore();
  const app = new Hono().route('/v1', createToolsRoutes(async () => ctx, {platformVoice: {pool: pool('GROQ_API_KEY', env, {service: 'groq'}), cooldowns, log: e => events.push(e)}, ...ports}));
  const transcribe = () => app.request('http://localhost:8788/v1/transcribe', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(AUDIO)});
  return {ctx, cooldowns, events, bearers, transcribe};
}
const ok = () => Response.json({text: 'hello'});

describe('Groq transcription with pooled platform keys', () => {
  it('uses the second key when the first is rate limited, and skips the cooling key on the next call', async () => {
    const f = voice(bearer => (bearer === 'Bearer gsk_first-secret' ? new Response('rate limited gsk_first-secret', {status: 429, headers: {'Retry-After': '20'}}) : ok()));
    const res = await f.transcribe();
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe('hello');
    expect(f.bearers).toEqual(['Bearer gsk_first-secret', 'Bearer gsk_second-secret']);
    expect(await f.cooldowns.get('groq', 1)).toMatchObject({reason: 'rateLimited'});

    expect((await f.transcribe()).status).toBe(200);
    expect(f.bearers.slice(2)).toEqual(['Bearer gsk_second-secret']);
    expect(f.events).toEqual([expect.objectContaining({event: 'credential.cooldown', service: 'groq', slot: 1, reason: 'rateLimited'})]);
    expect(JSON.stringify(f.events)).not.toMatch(/gsk_/);
  });

  it.each([401, 402, 503])('fails over on %i as well', async status => {
    const f = voice(bearer => (bearer.endsWith('first-secret') ? new Response('', {status}) : ok()));
    expect((await f.transcribe()).status).toBe(200);
    expect(f.bearers).toEqual(['Bearer gsk_first-secret', 'Bearer gsk_second-secret']);
  });

  it('reports 429 when every key is rate limited and 502 otherwise, without leaking keys or calling again', async () => {
    const limited = voice(() => new Response('gsk_first-secret', {status: 429}));
    for (let i = 0; i < 2; i++) {
      const res = await limited.transcribe();
      expect(res.status).toBe(429);
      expect(await res.text()).not.toMatch(/gsk_/);
    }
    expect(limited.bearers).toHaveLength(2);
    const invalid = voice(bearer => new Response('', {status: bearer.endsWith('first-secret') ? 401 : 429}));
    expect((await invalid.transcribe()).status).toBe(502);
  });

  it('does not fail over on a request the provider rejects for other reasons', async () => {
    const f = voice(() => new Response('bad audio', {status: 400}));
    expect((await f.transcribe()).status).toBe(502);
    expect(f.bearers).toHaveLength(1);
    expect(await f.cooldowns.get('groq', 1)).toBeNull();
  });

  it("never pools or cools a user's own key", async () => {
    const f = voice(() => new Response('', {status: 429}));
    await f.ctx.store.put('alice', 'voiceSecret', 'current', {key: seal('user-own-key', 'alice', 'voice', f.ctx.encryptionKey!)});
    expect((await f.transcribe()).status).toBe(429);
    expect(f.bearers).toEqual(['Bearer user-own-key']);
    expect(await f.cooldowns.get('groq', 1)).toBeNull();
  });

  it('is unconfigured with no platform key and no user key', async () => {
    const f = voice(ok, {});
    const res = await f.transcribe();
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('voice_unconfigured');
    expect(f.bearers).toEqual([]);
  });

  it('reads the default pool from process.env on every call', async () => {
    vi.stubEnv('GROQ_API_KEY', 'gsk_env-secret');
    const bearers: string[] = [];
    const ctx: FeatureContext = {...createLocalAdapters(), userId: 'alice', local: false, egress: vi.fn(), fetch: (async (_u: unknown, init?: RequestInit) => { bearers.push(new Headers(init?.headers).get('Authorization')!); return ok(); }) as unknown as typeof fetch};
    const app = new Hono().route('/v1', createToolsRoutes(async () => ctx));
    const res = await app.request('http://localhost:8788/v1/transcribe', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(AUDIO)});
    expect(res.status).toBe(200);
    expect(bearers).toEqual(['Bearer gsk_env-secret']);
  });
});

describe('voice.configured', () => {
  // Production mode: local mode seeds a preferences row, and the pool only decides the default.
  const prefs = async () => {
    const service = new ApiService(fixtures(), false);
    const user = {type: 'user' as const, id: 'u1', name: 'U', email: 'u@example.test'};
    const {app} = createApp({service, encryptionKey: randomBytes(32).toString('base64'), resolveSession: async () => ({user: user as never, expiresAt: new Date(Date.now() + 60_000).toISOString()})});
    const res = await app.request('/v1/preferences', {headers: {Authorization: 'Bearer t'}});
    expect(res.status).toBe(200);
    return (await res.json()).voice.configured;
  };
  it('is true when the Groq pool has at least one slot', async () => {
    vi.stubEnv('GROQ_API_KEY', '');
    vi.stubEnv('GROQ_API_KEY_2', 'gsk_orphan');
    expect(await prefs()).toBe(false);
    vi.stubEnv('GROQ_API_KEY', 'gsk_one');
    expect(await prefs()).toBe(true);
  });
});

describe('production env pools', () => {
  const base = (): Record<string, string> => ({
    PRAXIS_API_URL: 'https://api.praxis.test', PRAXIS_WEB_ORIGINS: 'https://app.praxis.test', PRAXIS_ENCRYPTION_KEYS: randomBytes(32).toString('base64'),
    BETTER_AUTH_SECRET: 'b'.repeat(40), CONVEX_URL: 'https://example-123.convex.cloud', PRAXIS_CONVEX_SERVER_TOKEN: 's'.repeat(40),
    UPSTASH_REDIS_REST_URL: 'https://example.upstash.io', UPSTASH_REDIS_REST_TOKEN: 'redis-token', QSTASH_TOKEN: 'qstash-token', QSTASH_CURRENT_SIGNING_KEY: 'sig_current', QSTASH_NEXT_SIGNING_KEY: 'sig_next',
  });

  it('accepts no key, a single key and numbered siblings without warnings', () => {
    const warn = vi.fn();
    expect(PLATFORM_POOLS.map(p => p.names)).toContain('GROQ_API_KEY');
    readProductionEnv(base(), {warn});
    readProductionEnv({...base(), GROQ_API_KEY: 'gsk_1'}, {warn});
    readProductionEnv({...base(), GROQ_API_KEY: 'gsk_1', GROQ_API_KEY_2: 'gsk_2', GROQ_API_KEY_3: 'gsk_3'}, {warn});
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about slots after a gap, naming variables only', () => {
    const warn = vi.fn();
    readProductionEnv({...base(), GROQ_API_KEY: 'gsk_1', GROQ_API_KEY_3: 'gsk_three-secret'}, {warn});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/GROQ_API_KEY_3 is ignored: GROQ_API_KEY_2 is missing/);
    expect(warn.mock.calls[0]![0]).not.toContain('gsk_three-secret');
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => {});
    readProductionEnv({...base(), GROQ_API_KEY: 'gsk_1', GROQ_API_KEY_3: 'gsk_three-secret'});
    expect(JSON.parse(logged.mock.calls[0]![0])).toMatchObject({type: 'startup.warning'});
    expect(logged.mock.calls.join()).not.toContain('gsk_');
    logged.mockRestore();
  });

  it('refuses to start on a half-defined multi-part slot, listed with the other problems', () => {
    const pools = [...PLATFORM_POOLS, {service: 'modal', names: ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET']}];
    const env = {...base(), MODAL_TOKEN_ID: 'ak-1', MODAL_TOKEN_SECRET: 'as-1', MODAL_TOKEN_ID_2: 'ak-two-secret'};
    let message = '';
    try { readProductionEnv({...env, QSTASH_TOKEN: ''}, {pools}); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/QSTASH_TOKEN is missing[\s\S]*slot 2 of modal is half-defined: MODAL_TOKEN_SECRET_2 is missing/);
    expect(message).not.toContain('ak-two-secret');
    expect(() => readProductionEnv({...env, MODAL_TOKEN_SECRET_2: 'as-2'}, {pools})).not.toThrow();
  });
});

describe('Redis cool-down store on the API Redis interface', () => {
  it('writes pool:<service>:<slot>:cooldown with a TTL and no key material', async () => {
    const fake = fakeRedis();
    const store = redisCooldownStore(fake.redis, {now: fake.now});
    expect(await store.mark('groq', 1, {reason: 'rateLimited', until: fake.now() + 30_000})).toBe(true);
    expect(await store.mark('groq', 1, {reason: 'invalid', until: fake.now() + 90_000})).toBe(false);
    expect(fake.keys()).toEqual(['pool:groq:1:cooldown']);
    expect(await fake.redis.get('pool:groq:1:cooldown')).toBe(JSON.stringify({reason: 'rateLimited', until: 30_000}));
    expect(await store.get('groq', 1)).toEqual({reason: 'rateLimited', until: 30_000});
    fake.advance(30_000);
    expect(await store.get('groq', 1)).toBeNull();
  });
});
