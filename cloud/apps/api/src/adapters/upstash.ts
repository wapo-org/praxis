import { createHash } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { z } from 'zod';
import { JsonObjectSchema } from '@praxis/protocol';
import type { EventRecord, Events, KV } from '../contracts.js';
import { Limit, Revision, Scope } from './validation.js';

/**
 * Upstash Redis adapters. Key namespace: `praxis:v1:...`.
 * Owner parts of keys are opaque digests of the userId; caller KV keys are digested whole,
 * so no user id, email or token ever appears in a Redis key.
 */
export const DEFAULT_PREFIX = 'praxis:v1';

/** The subset of the @upstash/redis client these adapters use (lets tests inject a requester). */
export type RedisClient = Pick<Redis, 'get' | 'set' | 'del' | 'eval' | 'xrange'>;

export function createUpstashRedis(options: { url: string; token: string }): Redis {
  z.url().parse(options.url);
  z.string().min(1).parse(options.token);
  return new Redis({ url: options.url, token: options.token, enableTelemetry: false });
}

/** Opaque digest used for key components (base64url SHA-256, truncated). */
export const digest = (value: string, length = 22) =>
  createHash('sha256').update(value).digest('base64url').slice(0, length);

/** Opaque, stable owner component for Redis keys. */
export function ownerKey(userId: string): string {
  return `u.${digest(Scope.parse(userId))}`;
}

/** Channels like `run:<id>` or `user` stay readable; anything else is digested. */
function channelKey(channel: string): string {
  Scope.parse(channel);
  return /^[A-Za-z0-9_:-]{1,120}$/.test(channel) ? channel : `h.${digest(channel)}`;
}

/** Values may come back raw (JSON text) or pre-parsed, depending on client deserialization settings. */
function fromRedisJson(raw: unknown): unknown {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// ---------------------------------------------------------------- KV

const Envelope = z.object({ v: z.json() });

export interface UpstashKVOptions {
  prefix?: string;
}

/**
 * KV with JSON values. Values are wrapped in `{"v":...}` so a stored string that looks
 * like JSON survives the client's automatic deserialization unchanged.
 */
export function createUpstashKV(redis: RedisClient, options: UpstashKVOptions = {}): KV {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const key = (k: string) => `${prefix}:kv:${digest(Scope.parse(k), 43)}`;
  return {
    async get<T>(k: string) {
      const raw = await redis.get<unknown>(key(k));
      if (raw === null || raw === undefined) return null;
      return Envelope.parse(fromRedisJson(raw)).v as T;
    },
    async set(k, value, ttlSeconds) {
      const data = JSON.stringify({ v: value });
      if (data === '{}') throw new Error('Expected a JSON value');
      if (ttlSeconds === undefined) await redis.set(key(k), data);
      else await redis.set(key(k), data, { ex: z.number().int().positive().parse(ttlSeconds) });
    },
    async del(k) {
      await redis.del(key(k));
    },
  };
}

// ---------------------------------------------------------------- Events

/**
 * Atomically allocates the next per-stream sequence and appends `<seq>-0`.
 * KEYS[1] = sequence counter, KEYS[2] = stream.
 * ARGV[1] = payload JSON, ARGV[2] = approximate MAXLEN, ARGV[3] = stream TTL seconds, ARGV[4] = counter TTL seconds.
 * If the counter was lost (eviction) the stream's last id still wins, so ids never go backwards.
 */
export const APPEND_EVENT_LUA = `
local n = redis.call('INCR', KEYS[1])
local last = redis.call('XREVRANGE', KEYS[2], '+', '-', 'COUNT', 1)
if last[1] then
  local seen = tonumber(string.match(last[1][1], '^(%d+)'))
  if n <= seen then
    n = seen + 1
    redis.call('SET', KEYS[1], n)
  end
end
if n > 9007199254740991 then return redis.error_reply('event sequence exhausted') end
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[2], tostring(n) .. '-0', 'p', ARGV[1])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return n
`;

export interface UpstashEventsOptions {
  prefix?: string;
  /** Approximate entries kept per stream (older ones are trimmed; readers get cursor_expired). */
  maxLen?: number;
  /** Stream retention after the last append. The counter is kept 4x longer so ids stay monotonic. */
  retentionSeconds?: number;
}

export function eventKeys(userId: string, channel: string, prefix = DEFAULT_PREFIX) {
  // One hash tag per (owner, channel) keeps both keys in one slot for the script.
  const base = `${prefix}:${ownerKey(userId)}:{ev:${channelKey(channel)}}`;
  return { sequence: `${base}:seq`, stream: `${base}:x` };
}

type RawRange = [string, string[]][];
type ParsedRange = Record<string, Record<string, unknown>>;

function rangeEntries(result: unknown): [string, unknown][] {
  if (!result) return [];
  if (Array.isArray(result)) {
    return (result as RawRange).map(([id, fields]) => {
      const at = fields.indexOf('p');
      return [id, at >= 0 ? fields[at + 1] : undefined];
    });
  }
  return Object.entries(result as ParsedRange).map(([id, fields]) => [id, fields.p]);
}

export function createUpstashEvents(redis: RedisClient, options: UpstashEventsOptions = {}): Events {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const maxLen = z.number().int().min(100).parse(options.maxLen ?? 10_000);
  const retention = z.number().int().positive().parse(options.retentionSeconds ?? 7 * 24 * 3600);
  return {
    async append(userId, channel, payload) {
      const data = JSON.stringify(JsonObjectSchema.parse(payload));
      const keys = eventKeys(userId, channel, prefix);
      const id = Revision.positive().parse(
        Number(
          await redis.eval(APPEND_EVENT_LUA, [keys.sequence, keys.stream], [data, String(maxLen), String(retention), String(retention * 4)]),
        ),
      );
      return { id, payload: JSON.parse(data) };
    },
    async read(userId, channel, after, limit = 100) {
      Revision.parse(after);
      Limit.parse(limit);
      if (after === Number.MAX_SAFE_INTEGER) return [];
      const { stream } = eventKeys(userId, channel, prefix);
      // Exclusive start: strictly after the cursor.
      const result = await redis.xrange(stream, `(${after}-0`, '+', limit);
      return rangeEntries(result).map(([id, payload]): EventRecord => ({
        id: Revision.positive().parse(Number(id.split('-')[0])),
        payload: JsonObjectSchema.parse(fromRedisJson(payload)),
      }));
    },
  };
}

// ---------------------------------------------------------------- Cache helpers

/** Bootstrap snapshot cache key for an owner. Call `invalidateOwnerCaches` after any bootstrap-visible write. */
export const bootstrapCacheKey = (userId: string) => `bootstrap:${Scope.parse(userId)}`;

export async function invalidateOwnerCaches(kv: KV, userId: string, extraKeys: string[] = []): Promise<void> {
  await Promise.all([bootstrapCacheKey(userId), ...extraKeys].map((k) => kv.del(k)));
}

/** Read-through cache: returns the cached value or computes, stores (with TTL) and returns it. */
export async function cached<T>(kv: KV, key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const hit = await kv.get<T>(key);
  if (hit !== null) return hit;
  const value = await compute();
  await kv.set(key, value, ttlSeconds);
  return value;
}
