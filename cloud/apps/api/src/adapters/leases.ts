import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, ownerKey, DEFAULT_PREFIX, type RedisClient } from './upstash.js';
import { Scope } from './validation.js';

/**
 * Execution leases for runs, with a monotonically increasing fence per run.
 * A lease is a compare-and-set token: renew/release only succeed for the current holder.
 */
export interface Lease {
  userId: string;
  runId: string;
  token: string;
  fence: number;
}

export interface Leases {
  /** Returns null while another holder's lease is live. */
  acquire(userId: string, runId: string, ttlMs: number): Promise<Lease | null>;
  /** Extends the lease if still held; false if it expired or was taken over. */
  renew(lease: Lease, ttlMs: number): Promise<boolean>;
  release(lease: Lease): Promise<boolean>;
}

const Ttl = z.number().int().min(100).max(15 * 60_000);

/** KEYS[1] = lease, KEYS[2] = fence counter; ARGV[1] = token, ARGV[2] = ttl ms, ARGV[3] = counter ttl ms. */
export const ACQUIRE_LEASE_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 then return false end
local fence = redis.call('INCR', KEYS[2])
redis.call('SET', KEYS[1], ARGV[1] .. '|' .. fence, 'PX', ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return fence
`;

/** KEYS[1] = lease; ARGV[1] = expected holder value, ARGV[2] = ttl ms. */
export const RENEW_LEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

/** KEYS[1] = lease; ARGV[1] = expected holder value. */
export const RELEASE_LEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

export function leaseKeys(userId: string, runId: string, prefix = DEFAULT_PREFIX) {
  const base = `${prefix}:${ownerKey(userId)}:{lease:${digest(Scope.parse(runId))}}`;
  return { lease: `${base}:holder`, fence: `${base}:fence` };
}

export function createRedisLeases(redis: RedisClient, options: { prefix?: string } = {}): Leases {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const holder = (lease: Lease) => `${lease.token}|${lease.fence}`;
  return {
    async acquire(userId, runId, ttlMs) {
      const keys = leaseKeys(userId, runId, prefix);
      const token = randomUUID();
      const fence = await redis.eval(ACQUIRE_LEASE_LUA, [keys.lease, keys.fence], [token, String(Ttl.parse(ttlMs)), String(30 * 86_400_000)]);
      if (fence === null || fence === undefined || fence === false) return null;
      return { userId, runId, token, fence: z.coerce.number().int().positive().parse(fence) };
    },
    async renew(lease, ttlMs) {
      const keys = leaseKeys(lease.userId, lease.runId, prefix);
      return Number(await redis.eval(RENEW_LEASE_LUA, [keys.lease], [holder(lease), String(Ttl.parse(ttlMs))])) === 1;
    },
    async release(lease) {
      const keys = leaseKeys(lease.userId, lease.runId, prefix);
      return Number(await redis.eval(RELEASE_LEASE_LUA, [keys.lease], [holder(lease)])) === 1;
    },
  };
}

/** Single-process leases for local development and tests. */
export function createMemoryLeases(now: () => number = Date.now): Leases {
  const held = new Map<string, { token: string; fence: number; expiresAt: number }>();
  const fences = new Map<string, number>();
  const key = (userId: string, runId: string) => JSON.stringify([userId, runId]);
  const live = (k: string, lease: Lease) => {
    const h = held.get(k);
    return !!h && h.expiresAt > now() && h.token === lease.token && h.fence === lease.fence;
  };
  return {
    async acquire(userId, runId, ttlMs) {
      const k = key(userId, runId);
      const current = held.get(k);
      if (current && current.expiresAt > now()) return null;
      const fence = (fences.get(k) ?? 0) + 1;
      fences.set(k, fence);
      const token = randomUUID();
      held.set(k, { token, fence, expiresAt: now() + Ttl.parse(ttlMs) });
      return { userId, runId, token, fence };
    },
    async renew(lease, ttlMs) {
      const k = key(lease.userId, lease.runId);
      if (!live(k, lease)) return false;
      held.get(k)!.expiresAt = now() + Ttl.parse(ttlMs);
      return true;
    },
    async release(lease) {
      const k = key(lease.userId, lease.runId);
      if (!live(k, lease)) return false;
      held.delete(k);
      return true;
    },
  };
}
