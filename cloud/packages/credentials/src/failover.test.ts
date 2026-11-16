import {describe, expect, it, vi} from 'vitest';
import {CredentialSignalError, CredentialsUnavailableError, classifyHttp, cooldownKey, memoryCooldownStore, pool, redisCooldownStore, withCredential, type CredentialLogEvent} from './index.js';
import {fakeClock, testRedis} from './testing.js';

const KEYS = {EXA_API_KEY: 'sk-secret-one', EXA_API_KEY_2: 'sk-secret-two', EXA_API_KEY_3: 'sk-secret-three'};
const exa = () => pool('EXA_API_KEY', KEYS, {service: 'exa'});
const service = (failing: Record<string, Response | (() => Response)>) => vi.fn(async (key: string, _slot: number) => {
  const r = failing[key];
  return r ? (typeof r === 'function' ? r() : r.clone()) : new Response('ok');
});

describe('withCredential failover', () => {
  it('moves to slot 2 when slot 1 is rate limited, and returns to slot 1 after its cool-down', async () => {
    const clock = fakeClock();
    const store = memoryCooldownStore(clock.now);
    const failing: Record<string, Response> = {'sk-secret-one': new Response('slow down', {status: 429, headers: {'Retry-After': '30'}})};
    const fn = service(failing);
    const first = await withCredential(exa(), store, fn, {now: clock.now});
    expect(first.slot).toBe(2);
    expect(first.value.status).toBe(200);
    expect(fn.mock.calls.map(c => c[1])).toEqual([1, 2]);
    expect(await store.get('exa', 1)).toEqual({reason: 'rateLimited', until: clock.now() + 30_000});

    delete failing['sk-secret-one'];
    clock.advance(29_999);
    expect((await withCredential(exa(), store, fn, {now: clock.now})).slot).toBe(2);
    expect(fn).toHaveBeenCalledTimes(3);
    clock.advance(1);
    expect((await withCredential(exa(), store, fn, {now: clock.now})).slot).toBe(1);
  });

  it('keeps an exhausted slot out for the configured period', async () => {
    const clock = fakeClock();
    const store = memoryCooldownStore(clock.now);
    const fn = service({'sk-secret-one': new Response('payment required', {status: 402})});
    const classify = (r: Response) => classifyHttp(r.status, r.headers, undefined, {now: clock.now, cooldownsMs: {exhausted: 6 * 3_600_000}});
    expect((await withCredential(exa(), store, fn, {now: clock.now, classify})).slot).toBe(2);
    clock.advance(6 * 3_600_000 - 1);
    expect((await withCredential(exa(), store, fn, {now: clock.now, classify})).slot).toBe(2);
    expect(fn.mock.calls.filter(c => c[1] === 1)).toHaveLength(1);
    clock.advance(1);
    await withCredential(exa(), store, fn, {now: clock.now, classify});
    expect(fn.mock.calls.filter(c => c[1] === 1)).toHaveLength(2);
  });

  it('throws CredentialsUnavailableError with the earliest retry time when every slot is cooling', async () => {
    const clock = fakeClock();
    const store = memoryCooldownStore(clock.now);
    const fn = service({
      'sk-secret-one': new Response('', {status: 401}),
      'sk-secret-two': new Response('', {status: 429, headers: {'Retry-After': '120'}}),
      'sk-secret-three': new Response('', {status: 429, headers: {'Retry-After': '45'}}),
    });
    const error = await withCredential(exa(), store, fn, {now: clock.now}).catch(e => e);
    expect(error).toBeInstanceOf(CredentialsUnavailableError);
    expect(error.service).toBe('exa');
    expect(error.retryAt).toEqual(new Date(clock.now() + 45_000));
    expect(error.slots.map((s: {slot: number; reason: string}) => [s.slot, s.reason])).toEqual([[1, 'invalid'], [2, 'rateLimited'], [3, 'rateLimited']]);
    expect(fn).toHaveBeenCalledTimes(3);

    clock.advance(10_000);
    const again = await withCredential(exa(), store, fn, {now: clock.now}).catch(e => e);
    expect(again.retryAt).toEqual(new Date(clock.now() + 35_000));
    expect(fn).toHaveBeenCalledTimes(3);
    expect(String(error.message) + JSON.stringify(error)).not.toMatch(/sk-secret/);
  });

  it('tries each slot at most once and passes ordinary errors through', async () => {
    const store = memoryCooldownStore();
    const boom = vi.fn(async () => { throw new Error('network down'); });
    await expect(withCredential(exa(), store, boom)).rejects.toThrow('network down');
    expect(boom).toHaveBeenCalledTimes(1);
    expect(await store.get('exa', 1)).toBeNull();
    await expect(withCredential(pool('EXA_API_KEY', {}), store, boom)).rejects.toMatchObject({name: 'CredentialsUnavailableError', detail: 'unconfigured', retryAt: null});
  });

  it('accepts a thrown CredentialSignalError and a custom classifier for non-HTTP results', async () => {
    const store = memoryCooldownStore();
    const thrown = await withCredential(exa(), store, async (_key, slot) => {
      if (slot === 1) throw new CredentialSignalError({kind: 'exhausted', cooldownMs: 1000});
      return slot * 10;
    });
    expect(thrown).toEqual({value: 20, slot: 2});
    const custom = await withCredential(exa(), memoryCooldownStore(), async (_key, slot) => ({quotaLeft: slot === 1 ? 0 : 5}), {classify: v => (v.quotaLeft ? {kind: 'ok'} : {kind: 'exhausted', cooldownMs: 1000})});
    expect(custom).toEqual({value: {quotaLeft: 5}, slot: 2});
  });

  it('marks one cool-down for concurrent 429s on the same slot', async () => {
    const clock = fakeClock();
    const {redis, data, writes} = testRedis(clock.now);
    const store = redisCooldownStore(redis, {now: clock.now});
    const log = vi.fn();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const fn = async (key: string) => {
      if (key === 'sk-secret-one') await gate;
      return key === 'sk-secret-one' ? new Response('', {status: 429}) : new Response('ok');
    };
    const calls = Array.from({length: 20}, () => withCredential(exa(), store, fn, {now: clock.now, log}));
    release();
    expect((await Promise.all(calls)).map(r => r.slot)).toEqual(Array(20).fill(2));
    expect([...data.keys()]).toEqual([cooldownKey('exa', 1)]);
    expect(writes).toHaveLength(20);
    expect(log.mock.calls.filter(c => (c[0] as CredentialLogEvent).event === 'credential.cooldown')).toHaveLength(1);
  });

  it('fails open when Redis throws: calls still succeed through in-process failover', async () => {
    const onError = vi.fn();
    const broken = {get: vi.fn(async () => { throw new Error('ECONNREFUSED'); }), set: vi.fn(async () => { throw new Error('ECONNREFUSED'); })};
    const store = redisCooldownStore(broken, {onError});
    const fn = service({'sk-secret-one': new Response('', {status: 429})});
    for (let i = 0; i < 2; i++) expect((await withCredential(exa(), store, fn)).slot).toBe(2);
    expect(fn.mock.calls.map(c => c[1])).toEqual([1, 2, 1, 2]);
    expect(onError.mock.calls.map(c => c[0])).toEqual(['get', 'mark', 'get', 'get', 'mark', 'get']);
    const rejecting = {get: async () => { throw new Error('down'); }, mark: async () => { throw new Error('down'); }};
    expect((await withCredential(exa(), rejecting, fn)).slot).toBe(2);
  });

  it('never puts key material in logs or Redis', async () => {
    const clock = fakeClock();
    const {redis, data, writes} = testRedis(clock.now);
    const store = redisCooldownStore(redis, {now: clock.now});
    const events: CredentialLogEvent[] = [];
    const fn = service({'sk-secret-one': new Response('', {status: 401}), 'sk-secret-two': new Response('', {status: 402}), 'sk-secret-three': new Response('', {status: 503})});
    const error = await withCredential(exa(), store, fn, {now: clock.now, log: e => events.push(e)}).catch(e => e);
    expect(events.map(e => e.event)).toEqual(['credential.cooldown', 'credential.cooldown', 'credential.cooldown', 'credential.unavailable']);
    expect(events[0]).toEqual({event: 'credential.cooldown', service: 'exa', slot: 1, reason: 'invalid', until: clock.now() + 3_600_000});
    expect([...data.keys()]).toEqual(['pool:exa:1:cooldown', 'pool:exa:2:cooldown', 'pool:exa:3:cooldown']);
    expect(JSON.parse(data.get('pool:exa:2:cooldown')!.value)).toEqual({reason: 'exhausted', until: clock.now() + 3_600_000});
    const everything = JSON.stringify([events, writes, [...data.entries()], error.message, error.slots, exa().warnings]);
    for (const key of Object.values(KEYS)) expect(everything).not.toContain(key);
  });
});

describe('cool-down stores', () => {
  it('expire with the clock and keep the first mark (memory and Redis alike)', async () => {
    for (const make of [(now: () => number) => memoryCooldownStore(now), (now: () => number) => redisCooldownStore(testRedis(now).redis, {now, prefix: 'praxis:'})]) {
      const clock = fakeClock();
      const store = make(clock.now);
      expect(await store.get('exa', 1)).toBeNull();
      expect(await store.mark('exa', 1, {reason: 'rateLimited', until: clock.now() + 1000})).toBe(true);
      expect(await store.mark('exa', 1, {reason: 'invalid', until: clock.now() + 9000})).toBe(false);
      expect(await store.mark('exa', 2, {reason: 'invalid', until: clock.now()})).toBe(false);
      expect(await store.get('exa', 1)).toEqual({reason: 'rateLimited', until: clock.now() + 1000});
      expect(await store.get('exa', 2)).toBeNull();
      clock.advance(1000);
      expect(await store.get('exa', 1)).toBeNull();
      expect(await store.mark('exa', 1, {reason: 'invalid', until: clock.now() + 9000})).toBe(true);
    }
  });

  it('reads unparseable or foreign Redis values as healthy', async () => {
    for (const value of ['not json', '{"reason":"nope","until":1}', '42', {reason: 'invalid', until: 'x'}]) {
      expect(await redisCooldownStore({get: async () => value, set: async () => 'OK'}).get('exa', 1)).toBeNull();
    }
    const until = Date.now() + 5000;
    expect(await redisCooldownStore({get: async () => ({reason: 'invalid', until}), set: async () => 'OK'}).get('exa', 1)).toEqual({reason: 'invalid', until});
  });
});
