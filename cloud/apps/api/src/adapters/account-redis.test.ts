import { expect, it } from 'vitest';
import type { Redis } from '@upstash/redis';
import { fakeRedis } from './testing/fake-redis.js';
import { createRateLimiter, upstashFromRedis } from './upstash.js';

function owned() {
  const memory = fakeRedis();
  const redis = upstashFromRedis(memory.redis, { accountOwnership: true, clock: memory.now });
  return { memory, redis, index: (u: string) => memory.index(redis.ownership.keys(u).index) };
}

it('keeps the owner index bounded: expired entries are pruned and rate limits are never indexed', async () => {
  const { memory, redis, index } = owned();
  await redis.ownership.activate('u');
  for (let i = 0; i < 300; i++) await redis.kv.set(`cache:${i}`, { i }, 1, 'u');
  expect(index('u')).toHaveLength(300);
  memory.advance(120_000);
  await redis.kv.set('fresh', {}, 60, 'u');
  expect(index('u')).toHaveLength(1);
  await redis.lease.acquire('run:1', 1000, 'u');
  await redis.events.append('u', 'run:1', { x: 1 });
  expect(index('u')).toHaveLength(5);
  const limit = createRateLimiter(memory.redis as unknown as Redis, { requests: 1000 });
  for (let minute = 0; minute < 120; minute++) {
    await limit('user:u');
    memory.advance(60_000);
  }
  // Two hours of per-minute windows reuse one self-expiring counter and add nothing to the index.
  expect(index('u').length).toBeLessThanOrEqual(5);
  expect(memory.keys().filter((k) => k.includes(':fixed:'))).toHaveLength(1);
});

it('resumes an interrupted purge from the persisted index instead of restarting', async () => {
  const { memory, redis, index } = owned();
  await redis.ownership.activate('u');
  for (let i = 0; i < 250; i++) await redis.kv.set(`k:${i}`, { i }, 600, 'u');
  const del = memory.redis.del.bind(memory.redis);
  let calls = 0;
  (memory.redis as any).del = async (...keys: string[]) => {
    if (keys.length > 1 && ++calls === 2) throw Error('transient');
    return del(...keys);
  };
  await expect(redis.ownership.purge('u')).rejects.toThrow('transient');
  expect(index('u')).toHaveLength(150);
  (memory.redis as any).del = del;
  await redis.ownership.purge('u');
  expect(index('u')).toHaveLength(0);
  expect(memory.keys().filter((k) => k.includes(':kv:'))).toEqual([]);
});

it('keeps limiting deletion attempts after the account is frozen and purged', async () => {
  const { memory, redis } = owned();
  await redis.ownership.activate('u');
  const limit = createRateLimiter(memory.redis as unknown as Redis);
  for (let i = 0; i < 3; i++) expect((await limit('account-delete:u')).ok).toBe(true);
  await redis.ownership.freeze('u');
  await redis.ownership.purge('u');
  for (let i = 0; i < 2; i++) expect((await limit('account-delete:u')).ok).toBe(true);
  expect(await limit('account-delete:u')).toEqual({ ok: false, retryAfterSeconds: 3600 });
  memory.advance(3_600_000);
  expect((await limit('account-delete:u')).ok).toBe(true);
});
