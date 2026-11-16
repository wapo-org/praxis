import {SealedSecret} from '@praxis/types';
import type {RedisLike} from './cooldown.js';
import type {CredentialPool} from './pool.js';

type Sealed = SealedSecret | Record<string, SealedSecret>;

/** Test-only: the key values behind a credential, so assertions can compare them. */
export function revealed(credential: Sealed): string | Record<string, string> {
  if (credential instanceof SealedSecret) return credential.reveal();
  return Object.fromEntries(Object.entries(credential).map(([name, part]) => [name, part.reveal()]));
}

export function revealedSlots(pool: CredentialPool<Sealed>) {
  return pool.slots.map(({slot, credential}) => ({slot, credential: revealed(credential)}));
}

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
