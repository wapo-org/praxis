import type {RedisLike} from './cooldown.js';

export function testRedis(now: () => number) {
  const data = new Map<string, {value: string; expires: number}>();
  const writes: {key: string; value: string}[] = [];
  const redis: RedisLike = {
    async get(key) {
      const entry = data.get(key);
      return entry && entry.expires > now() ? entry.value : null;
    },
    async set(key, value, options) {
      writes.push({key, value});
      const entry = data.get(key);
      if (entry && entry.expires > now()) return null;
      data.set(key, {value, expires: now() + options.px});
      return 'OK';
    },
  };
  return {redis, data, writes};
}

export function fakeClock(start = Date.parse('2026-11-15T12:00:00Z')) {
  let t = start;
  return {now: () => t, advance: (ms: number) => { t += ms; }};
}
