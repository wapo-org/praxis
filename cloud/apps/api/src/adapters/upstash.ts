import { accountRedis, ownerAppendLua, OWNER_LEASE_LUA } from './account-redis.js';
import {createHash, randomUUID} from 'node:crypto';
import {Redis} from '@upstash/redis';
import {Ratelimit} from '@upstash/ratelimit';
import {z} from 'zod';
import {JsonObjectSchema} from '@praxis/protocol';
import type {Events, KV} from '../contracts.js';
import {EventSchema, Limit, Revision, Scope} from './validation.js';

/**
 * Atomic append: INCR the per-stream sequence, XADD with the explicit `<seq>-0` id (so the SSE id and the
 * stream id are the same safe integer), trim to bounded retention, and refresh stream/dedup TTLs.
 * An optional stable key returns the original record atomically without allocating another SSE id.
 * A cursor older than retention shows up as a gap, which the SSE route reports as `cursor_expired`.
 */
export const APPEND_EVENT_LUA = `
if ARGV[4] ~= '' then
 local prior = redis.call('HGET', KEYS[3], ARGV[4])
 if prior then return prior end
end
local n = redis.call('INCR', KEYS[1])
if n > 9007199254740991 then return redis.error_reply('event sequence exhausted') end
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], tostring(n)..'-0', 'payload', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
local record = '{"id":'..tostring(n)..',"payload":'..ARGV[1]..'}'
if ARGV[4] ~= '' then redis.call('HSET', KEYS[3], ARGV[4], record) end
redis.call('EXPIRE', KEYS[3], ARGV[3])
return record`;

/** Release only if we still hold the lease (compare-and-delete). */
export const RELEASE_LEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0`;

export interface UpstashOptions {url: string; token: string; prefix?: string; streamMaxLen?: number; streamTtlSeconds?: number; accountOwnership?: boolean; clock?: () => number}

/** The subset of the Upstash client the adapters use (lets tests run the contract suite on a fake). */
export type RedisLike = Pick<Redis, 'get' | 'set' | 'del' | 'getdel' | 'eval' | 'xrange' | 'zrange' | 'zrem'>;

/** Keys never contain user ids or other caller text: owner/channel/kv names are SHA-256 hashed. */
export const opaque = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts.map(p => Scope.parse(p)))).digest('hex').slice(0, 40);

export function createUpstashAdapters(options: UpstashOptions) {
  z.string().url().parse(options.url);
  z.string().min(1).parse(options.token);
  // Automatic deserialization is off so JSON-looking strings survive roundtrips unchanged.
  const redis = new Redis({url: options.url, token: options.token, automaticDeserialization: false});
  return {redis, ...upstashFromRedis(redis, options)};
}

export function upstashFromRedis(redis: RedisLike, options: Omit<UpstashOptions, 'url' | 'token'> = {}) {
  const prefix = options.prefix ?? 'praxis:v1';
  const maxLen = String(options.streamMaxLen ?? 5000);
  const ttl = String(options.streamTtlSeconds ?? 7 * 86400);
  const ownership = accountRedis(redis, prefix, options.clock);
  const OWNED_APPEND_LUA = ownerAppendLua(APPEND_EVENT_LUA);
  const kvKey = (k: string) => `${prefix}:kv:${opaque(k)}`;
  const parse = <T>(value: string | null) => (value === null ? null : (JSON.parse(value) as T));

  const kv: KV = {
    get: async <T>(k: string) => parse<T>(await redis.get<string>(kvKey(k))),
    set: async (k, value, ttlSeconds, ownerId) => {
      const data = JSON.stringify(value);
      if (data === undefined) throw new Error('Expected JSON value');
      if (ownerId && options.accountOwnership) { await ownership.write(ownerId,kvKey(k),data,ttlSeconds); return; }
      if (ttlSeconds === undefined) await redis.set(kvKey(k), data);
      else await redis.set(kvKey(k), data, {ex: z.number().int().positive().parse(ttlSeconds)});
    },
    del: async k => {
      await redis.del(kvKey(k));
    },
  };

  /** One-time read: GETDEL is atomic, so a replayed OAuth state finds nothing. */
  const consumeOnce = async <T>(k: string): Promise<T | null> => parse<T>(await redis.getdel<string>(kvKey(k)));

  const stream = (u: string, c: string) => `${prefix}:events:${opaque(u, c)}`;
  const events: Events = {
    append: async (u, c, payload, eventKey) => {
      const k = stream(u, c);
      const owned = ownership.keys(u), keys = [`${k}:seq`, k, `${k}:dedup`], args = [JSON.stringify(JsonObjectSchema.parse(payload)), maxLen, ttl, eventKey ? opaque(eventKey) : ""];
      const raw = options.accountOwnership
        ? await redis.eval(OWNED_APPEND_LUA, [...keys, owned.active, owned.index], [...args, ownership.now()])
        : await redis.eval(APPEND_EVENT_LUA, keys, args);
      return EventSchema.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
    },
    read: async (u, c, after, limit = 100) => {
      Revision.parse(after);
      Limit.parse(limit);
      if (after === Number.MAX_SAFE_INTEGER) return [];
      const result = await redis.xrange<{payload: string}>(stream(u, c), `(${after}-0`, '+', limit);
      return Object.entries(result ?? {}).map(([id, fields]) => EventSchema.parse({id: Number(id.split('-')[0]), payload: JSON.parse(fields.payload)}));
    },
    // The per-stream sequence APPEND_EVENT_LUA increments is exactly the newest event id.
    latest: async (u, c) => Revision.parse(Number((await redis.get<string | number>(`${stream(u, c)}:seq`)) ?? 0)),
  };

  /** Fenced execution lease (SET NX PX + compare-and-delete) so duplicate continuations never run one run twice. */
  const lease = {
    acquire: async (k: string, ttlMs: number, ownerId?: string): Promise<string | null> => {
      const token = randomUUID();
      const key=`${prefix}:lease:${opaque(k)}`;
      const owned=ownerId?ownership.keys(ownerId):null;
      const ok = options.accountOwnership && owned
        ? await redis.eval(OWNER_LEASE_LUA, [key, owned.active, owned.index], [token, String(ttlMs), ownership.now()])
        : await redis.set(key, token, {nx: true, px: ttlMs});
      return ok === 'OK' ? token : null;
    },
    release: async (k: string, token: string): Promise<void> => {
      await redis.eval(RELEASE_LEASE_LUA, [`${prefix}:lease:${opaque(k)}`], [token]);
    },
  };

  return {kv, events, consumeOnce, lease, ownership};
}

/** KEYS: counter. ARGV: window ms. Fixed window in one self-expiring key; returns {count, ms left}. */
export const FIXED_WINDOW_LUA = `
local n=redis.call('INCR',KEYS[1])
local left=redis.call('PTTL',KEYS[1])
if left < 0 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) left=tonumber(ARGV[1]) end
return {n,left}`;

/**
 * Limiter shaped for `createApp({rateLimit})`. Per-user keys use one fixed-window counter each: it is never
 * owner-indexed (bounded, expires within its window), so account deletion cannot reset it and limits keep applying.
 * Other keys (per-IP) use @upstash/ratelimit's sliding window. Keys are hashed with our opaque id.
 */
export function createRateLimiter(redis: Pick<Redis, 'eval'> & Partial<Redis>, options: {requests?: number; window?: `${number} s`; prefix?: string} = {}) {
  const prefix = options.prefix ?? 'praxis:v1:ratelimit';
  const limiter = new Ratelimit({redis: redis as Redis, limiter: Ratelimit.slidingWindow(options.requests ?? 120, options.window ?? '60 s'), prefix, analytics: false});
  const fixed = async (key: string, max: number, seconds: number) => {
    const [count, left] = (await redis.eval(FIXED_WINDOW_LUA, [`${prefix}:fixed:${opaque(key)}`], [String(seconds * 1000)])) as [number, number];
    return Number(count) <= max ? {ok: true} : {ok: false, retryAfterSeconds: Math.max(1, Math.ceil(Number(left) / 1000))};
  };
  return async (key: string) => {
    if (key.startsWith('account-delete:')) return fixed(key, 5, 3600);
    if (key.startsWith('user:')) return fixed(key, options.requests ?? 120, Number.parseInt(options.window ?? '60 s'));
    const result = await limiter.limit(opaque(key));
    return result.success ? {ok: true} : {ok: false, retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000))};
  };
}
