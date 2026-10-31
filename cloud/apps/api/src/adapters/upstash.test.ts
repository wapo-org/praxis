import {describe, expect, it} from 'vitest';
import {createUpstashAdapters, upstashFromRedis} from './upstash.js';
import {fakeRedis} from './testing/fake-redis.js';
import {eventsContract, kvContract} from './testing/contract-suite.js';

function fakeAdapters(options = {}) {
  const fake = fakeRedis();
  const adapters = upstashFromRedis(fake.redis, options);
  return {...adapters, fake, kv: Object.assign(adapters.kv, {advanceClock: fake.advance})};
}
kvContract('KV contract: Upstash adapter (offline fake client)', () => fakeAdapters().kv);
eventsContract('Events contract: Upstash adapter (offline fake client)', () => fakeAdapters().events);

const live = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? () => createUpstashAdapters({url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN!, prefix: `praxis:test:${Date.now()}`})
  : null;
if (live) {
  kvContract('KV contract: Upstash live', () => live().kv, {realTime: true});
  eventsContract('Events contract: Upstash live', () => live().events);
} else {
  describe.skip('Upstash live contract (set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN)', () => it('skipped', () => {}));
}

describe('Upstash adapter specifics', () => {
  it('never puts user ids or channel names into Redis keys', async () => {
    const a = fakeAdapters();
    await a.kv.set('bootstrap:alice@example.com', {x: 1});
    await a.events.append('alice@example.com', 'run:secret-run', {type: 'x'});
    expect(a.fake.keys().join(' ')).not.toMatch(/alice|secret-run|bootstrap/);
  });
  it('consumes one-time values exactly once', async () => {
    const a = fakeAdapters();
    await a.kv.set('mcp:oauth:abc', {userId: 'u'}, 600);
    expect(await a.consumeOnce('mcp:oauth:abc')).toEqual({userId: 'u'});
    expect(await a.consumeOnce('mcp:oauth:abc')).toBeNull();
  });
  it('trims streams to retention so an old cursor shows a gap', async () => {
    const a = fakeAdapters({streamMaxLen: 3});
    for (let i = 0; i < 5; i++) await a.events.append('u', 'run:1', {i});
    const rows = await a.events.read('u', 'run:1', 0);
    expect(rows.map(r => r.id)).toEqual([3, 4, 5]);
  });
  it('lease is exclusive and only its holder can release it', async () => {
    const a = fakeAdapters();
    const t1 = await a.lease.acquire('run:1', 60_000);
    expect(t1).toBeTruthy();
    expect(await a.lease.acquire('run:1', 60_000)).toBeNull();
    await a.lease.release('run:1', 'not-the-token');
    expect(await a.lease.acquire('run:1', 60_000)).toBeNull();
    await a.lease.release('run:1', t1!);
    expect(await a.lease.acquire('run:1', 60_000)).toBeTruthy();
  });
});
