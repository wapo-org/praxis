import type {CooldownReason} from './classify.js';

export interface Cooldown {
  reason: CooldownReason;
  until: number;
}

/** Shared slot health store; never stores key material. */
export interface CooldownStore {
  get(service: string, slot: number): Promise<Cooldown | null>;
  /** Idempotently sets cooldown; resolves true only for the winning caller. */
  mark(service: string, slot: number, cooldown: Cooldown): Promise<boolean>;
}

const REASONS: readonly string[] = ['invalid', 'exhausted', 'rateLimited', 'serverError'];

export const cooldownKey = (service: string, slot: number, prefix = '') => `${prefix}pool:${service}:${slot}:cooldown`;

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

/** NX TTL cooldown store; fails open so calls fail over in-process on Redis error. */
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
