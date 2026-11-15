import {createHash} from 'node:crypto';
import type {CooldownStore} from './cooldown.js';
import {CredentialsUnavailableError} from './failover.js';
import type {CredentialPool} from './pool.js';

/** Healthy slots; store errors treat all slots as healthy. */
export async function healthySlots(pool: CredentialPool<unknown>, store: CooldownStore, now: () => number = Date.now): Promise<number[]> {
  const states = await Promise.all(pool.slots.map(s => store.get(pool.service, s.slot).catch(() => null)));
  return pool.slots.filter((_, i) => !(states[i] && states[i]!.until > now())).map(s => s.slot);
}

const score = (service: string, slot: number, ownerId: string) => createHash('sha256').update(JSON.stringify([service, slot, ownerId])).digest().readBigUInt64BE(0);

/** Rendezvous hashing for new owners; caller must persist the returned slot. */
export function placeOwner(pool: CredentialPool<unknown>, ownerId: string, healthy: readonly number[]): number {
  const candidates = pool.slots.map(s => s.slot).filter(slot => healthy.includes(slot));
  if (!candidates.length) throw new CredentialsUnavailableError(pool.service, [], pool.slots.length ? 'cooling' : 'unconfigured');
  let best = candidates[0]!;
  let bestScore = score(pool.service, best, ownerId);
  for (const slot of candidates.slice(1)) {
    const s = score(pool.service, slot, ownerId);
    if (s > bestScore) [best, bestScore] = [slot, s];
  }
  return best;
}

/** Uses stored slot without migration; throws if removed or cooling. */
export async function credentialFor<C>(pool: CredentialPool<C>, storedSlot: number, store?: CooldownStore, now: () => number = Date.now): Promise<C> {
  const entry = pool.slots.find(s => s.slot === storedSlot);
  if (!entry) throw new CredentialsUnavailableError(pool.service, [], 'missing');
  const cooldown = store ? await store.get(pool.service, storedSlot).catch(() => null) : null;
  if (cooldown && cooldown.until > now()) throw new CredentialsUnavailableError(pool.service, [{slot: storedSlot, ...cooldown}]);
  return entry.credential;
}

/** Reports stored slots no longer configured; never auto-migrates. */
export function orphanedSlots(pool: CredentialPool<unknown>, storedSlots: Iterable<number>): number[] {
  const configured = new Set(pool.slots.map(s => s.slot));
  return [...new Set(storedSlots)].filter(slot => !configured.has(slot)).sort((a, b) => a - b);
}
