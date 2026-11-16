import { describe, expect, it } from 'vitest';
import { createUpstashEvents, createUpstashKV, createUpstashRedis, eventKeys, ownerKey, cached, invalidateOwnerCaches } from './upstash.js';
import { FakeRedis } from './testing/fake-redis.js';
import { eventsContract, kvContract } from './testing/contract-suite.js';

for (const automaticDeserialization of [true, false]) {
  const mode = automaticDeserialization ? 'auto-deserialize' : 'raw';
  kvContract(`KV contract: Upstash client over fake REST (${mode})`, () => {
    const fake = new FakeRedis();
    return Object.assign(createUpstashKV(fake.client({ automaticDeserialization })), { advanceClock: fake.advanceClock });
  });
  eventsContract(`Events contract: Upstash client over fake REST (${mode})`, () =>
    createUpstashEvents(new FakeRedis().client({ automaticDeserialization })),
  );
}

describe('Upstash key hygiene and stream semantics', () => {
  it('never puts user ids, emails or caller keys into Redis keys', async () => {
    const fake = new FakeRedis();
    const redis = fake.client();
    const user = 'alice@example.com';
    await createUpstashKV(redis).set(`bootstrap:${user}`, { ok: true });
    await createUpstashEvents(redis).append(user, 'run:abc', { type: 'x' });
    const keys = fake.keys();
    expect(keys.length).toBe(3);
    for (const key of keys) {
      expect(key.startsWith('praxis:v1:')).toBe(true);
      expect(key).not.toContain('alice');
      expect(key).not.toContain('bootstrap');
    }
    expect(eventKeys(user, 'run:abc').stream).toContain(ownerKey(user));
    expect(ownerKey(user)).toBe(ownerKey(user));
    expect(ownerKey(user)).not.toBe(ownerKey('bob'));
  });

  it('uses explicit <seq>-0 ids through one atomic script and trims to MAXLEN', async () => {
    const fake = new FakeRedis();
    const events = createUpstashEvents(fake.client(), { maxLen: 100 });
    for (let n = 1; n <= 130; n++) await events.append('u', 'run:1', { n });
    const appends = fake.commands.filter((c) => c[0]!.toUpperCase() === 'EVAL');
    expect(appends).toHaveLength(130);
    const all = await events.read('u', 'run:1', 0, 1000);
    // Trimmed history starts after the cursor: callers detect `first.id > after + 1` as cursor_expired.
    expect(all[0]!.id).toBeGreaterThan(1);
    expect(all.at(-1)!.id).toBe(130);
    expect(fake.commands.some((c) => c[0]!.toUpperCase() === 'XRANGE' && c[2] === '(0-0')).toBe(true);
  });

  it('keeps ids monotonic when the counter key is lost but the stream survives', async () => {
    const fake = new FakeRedis();
    const redis = fake.client();
    const events = createUpstashEvents(redis);
    await events.append('u', 'c', { n: 1 });
    await events.append('u', 'c', { n: 2 });
    await redis.del(eventKeys('u', 'c').sequence);
    expect((await events.append('u', 'c', { n: 3 })).id).toBe(3);
  });

  it('validates input at the boundary', async () => {
    const events = createUpstashEvents(new FakeRedis().client());
    await expect(events.read('u', 'c', -1)).rejects.toThrow();
    await expect(events.read('u', 'c', 0, 0)).rejects.toThrow();
    await expect(events.append('', 'c', {})).rejects.toThrow();
    const kv = createUpstashKV(new FakeRedis().client());
    await expect(kv.set('k', undefined)).rejects.toThrow();
    await expect(kv.set('k', 1, 0)).rejects.toThrow();
  });

  it('read-through cache and owner cache invalidation', async () => {
    const kv = createUpstashKV(new FakeRedis().client());
    let calls = 0;
    const compute = async () => ({ n: ++calls });
    expect(await cached(kv, 'bootstrap:u1', 30, compute)).toEqual({ n: 1 });
    expect(await cached(kv, 'bootstrap:u1', 30, compute)).toEqual({ n: 1 });
    await invalidateOwnerCaches(kv, 'u1');
    expect(await cached(kv, 'bootstrap:u1', 30, compute)).toEqual({ n: 2 });
  });
});

const liveUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
if (!liveUpstash) console.info('[upstash] live suite skipped: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN');
describe.skipIf(!liveUpstash)('live Upstash Redis', () => {
  const redis = () =>
    createUpstashRedis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! });
  const prefix = `praxis:test:${crypto.randomUUID()}`;
  kvContract('KV contract: live Upstash', () => createUpstashKV(redis(), { prefix }), { realTime: true });
  eventsContract('Events contract: live Upstash', () => createUpstashEvents(redis(), { prefix, retentionSeconds: 600 }));
});
