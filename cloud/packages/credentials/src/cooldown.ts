import type {CooldownReason} from './classify.js';

export interface Cooldown {
  reason: CooldownReason;
  /** Epoch milliseconds when the slot may be used again. */
  until: number;
}

/** Shared, disposable health state per (service, slot). Holds reasons and times, never key material. */
export interface CooldownStore {
  /** The active cool-down of a slot, or null when it is healthy. */
  get(service: string, slot: number): Promise<Cooldown | null>;
  /**
   * Marks a slot cooling. Idempotent: while a cool-down is active, further marks change nothing.
   * Resolves true only for the call that created the cool-down.
   */
  mark(service: string, slot: number, cooldown: Cooldown): Promise<boolean>;
}

const REASONS: readonly string[] = ['invalid', 'exhausted', 'rateLimited', 'serverError'];

export const cooldownKey = (service: string, slot: number, prefix = '') => `${prefix}pool:${service}:${slot}:cooldown`;

/** In-process store: tests, local development, and the fallback behaviour when Redis is unreachable. */
export function memoryCooldownStore(now: () => number = Date.now): CooldownStore {
  const entries = new Map<string, Cooldown>();
  const active = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.until <= now()) entries.delete(key);
    return entries.get(key) ?? null;
  };
  return {
    get: async (service, slot) => active(cooldownKey(service, slot)),
    mark: async (service, slot, cooldown) => {
      const key = cooldownKey(service, slot);
      if (active(key) || cooldown.until <= now()) return false;
      entries.set(key, {reason: cooldown.reason, until: cooldown.until});
      return true;
    },
  };
}

/** The two commands the Redis store needs. The Upstash client and the API's fake Redis both fit. */
export interface RedisLike {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options: {px: number; nx: true}): Promise<unknown>;
}

function parse(raw: unknown): Cooldown | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const {reason, until} = value as {reason?: unknown; until?: unknown};
  if (typeof reason !== 'string' || !REASONS.includes(reason) || typeof until !== 'number' || !Number.isFinite(until)) return null;
  return {reason: reason as CooldownReason, until};
}

/**
 * Redis store: `pool:<service>:<slot>:cooldown` = `{"reason","until"}` with a TTL of the cool-down length,
 * written with NX so concurrent marks produce one cool-down. Fails open: when Redis errors, every slot reads
 * as healthy and marks are dropped, so calls keep failing over in-process.
 */
export function redisCooldownStore(redis: RedisLike, options: {prefix?: string; now?: () => number; onError?: (operation: 'get' | 'mark') => void} = {}): CooldownStore {
  const now = options.now ?? Date.now;
  const key = (service: string, slot: number) => cooldownKey(service, slot, options.prefix);
  return {
    get: async (service, slot) => {
      try {
        const cooldown = parse(await redis.get(key(service, slot)));
        return cooldown && cooldown.until > now() ? cooldown : null;
      } catch {
        options.onError?.('get');
        return null;
      }
    },
    mark: async (service, slot, cooldown) => {
      const px = Math.ceil(cooldown.until - now());
      if (px <= 0) return false;
      try {
        const set = await redis.set(key(service, slot), JSON.stringify({reason: cooldown.reason, until: cooldown.until}), {px, nx: true});
        return set !== null && set !== undefined;
      } catch {
        options.onError?.('mark');
        return false;
      }
    },
  };
}
