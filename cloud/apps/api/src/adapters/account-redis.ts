import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from '@upstash/redis';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Index scores are key expiry ms; expired entries past skew are pruned on every owner write. */
export const INDEX_SKEW_MS = 60000;
const guard = (active: number, now: number) => `
if redis.call('GET',KEYS[${active}]) ~= 'active' then return redis.error_reply('Account unavailable') end
redis.call('ZREMRANGEBYSCORE',KEYS[${active + 1}],'-inf',tonumber(ARGV[${now}])-${INDEX_SKEW_MS})`;
/** KEYS: data, active, index; ARGV: value, ttlSec, nowMs (registers key while active). */
export const OWNER_WRITE_LUA = `${guard(2, 3)}
if ARGV[2] == '' then redis.call('ZADD',KEYS[3],'+inf',KEYS[1]) return redis.call('SET',KEYS[1],ARGV[1]) end
redis.call('ZADD',KEYS[3],tonumber(ARGV[3])+tonumber(ARGV[2])*1000,KEYS[1])
return redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2])`;
/** KEYS: lease, active, index; ARGV: token, ttlMs, nowMs. */
export const OWNER_LEASE_LUA = `${guard(2, 3)}
redis.call('ZADD',KEYS[3],tonumber(ARGV[3])+tonumber(ARGV[2]),KEYS[1])
return redis.call('SET',KEYS[1],ARGV[1],'NX','PX',ARGV[2])`;
/** Wraps event-append Lua (KEYS 1-3, ARGV 1-4) with owner keys (KEYS 4-5, ARGV 5 nowMs). */
export const ownerAppendLua = (append: string) => `${guard(4, 5)}
local expires=tonumber(ARGV[5])+tonumber(ARGV[3])*1000
redis.call('ZADD',KEYS[5],expires,KEYS[1],expires,KEYS[2],expires,KEYS[3])
${append}`;
export function accountRedis(
  redis: Pick<Redis, 'set' | 'get' | 'del' | 'eval' | 'zrange' | 'zrem'>,
  prefix = 'praxis:v1',
  clock: () => number = Date.now,
) {
  const exclusive = async <T>(u: string, fn: () => Promise<T>): Promise<T> => {
    const key = `${prefix}:owner:${hash(u)}:lock`,
      token = randomUUID();
    const acquired = await redis.set(key, token, { nx: true, px: 300000 });
    if (acquired !== 'OK') throw Error('Account operation in progress; retry');
    try {
      return await fn();
    } finally {
      await redis.eval(OWNER_UNLOCK_LUA, [key], [token]);
    }
  };
  const active = (u: string) => `${prefix}:owner:${hash(u)}:active`,
    index = (u: string) => `${prefix}:owner:${hash(u)}:index`;
  return {
    exclusive,
    now: () => String(clock()),
    activate: async (u: string, validate: () => Promise<boolean> = async () => true) =>
      exclusive(u, async () => {
        if (!(await validate())) throw Error('Account unavailable');
        await redis.set(active(u), 'active', { nx: true });
      }),
    isActive: async (u: string) => (await redis.get(active(u))) === 'active',
    freeze: async (u: string) => {
      await redis.del(active(u));
    },
    write: async (u: string, key: string, value: string, ttl?: number) => {
      await redis.eval(
        OWNER_WRITE_LUA,
        [key, active(u), index(u)],
        [value, ttl === undefined ? '' : String(ttl), String(clock())],
      );
    },
    /** Drops erased keys from index per round so interrupted purges resume. */
    async purge(u: string) {
      await redis.del(active(u));
      for (;;) {
        const keys = await redis.zrange<string[]>(index(u), 0, 99);
        if (!keys.length) break;
        await redis.del(...keys);
        await redis.zrem(index(u), ...keys);
      }
      await redis.del(index(u));
    },
    keys: (u: string) => ({ active: active(u), index: index(u) }),
  };
}

export const OWNER_UNLOCK_LUA =
  "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0";
