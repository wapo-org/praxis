export interface RunLease {
  acquire(key: string, ttlMs: number, ownerId?: string): Promise<string | null>;
  release(key: string, token: string): Promise<void>;
}

/** Process-local lease for dev/tests; production injects the Redis lease. */
export function memoryLease(clock: () => number = Date.now): RunLease {
  const held = new Map<string, {token: string; expires: number}>();
  return {
    async acquire(key, ttlMs) {
      const current = held.get(key);
      if (current && current.expires > clock()) return null;
      const token = crypto.randomUUID();
      held.set(key, {token, expires: clock() + ttlMs});
      return token;
    },
    async release(key, token) {
      if (held.get(key)?.token === token) held.delete(key);
    },
  };
}
