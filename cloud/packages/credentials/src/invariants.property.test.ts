import {expect, it} from 'vitest';
import fc from 'fast-check';
import {CredentialsUnavailableError, memoryCooldownStore, withCredential, type CredentialPool} from './index.js';

const RUNS_MAX = 100;
const SLOTS_MAX = 12;
const COOLDOWN_MS = 100;
const SERVICE = 'property-service';

it('OneRetryRound / NoSlotStarved: failures visit every eligible slot once and expired slots return', async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.boolean(), {minLength: 1, maxLength: SLOTS_MAX}),
    fc.integer({min: 0, max: COOLDOWN_MS - 1}),
    async (cooling, elapsedMs) => {
      let nowMs = 0;
      const now = () => nowMs;
      const store = memoryCooldownStore(now);
      const pool: CredentialPool<number> = {
        service: SERVICE, names: [], warnings: [],
        slots: cooling.map((_, i) => ({slot: i + 1, credential: i + 1})),
      };
      for (const [i, skip] of cooling.entries()) {
        if (skip) await store.mark(SERVICE, i + 1, {reason: 'rateLimited', until: COOLDOWN_MS});
      }
      const attempts: number[] = [];
      const fail = async (_credential: number, slot: number) => {
        attempts.push(slot);
        return {status: 429};
      };
      nowMs = elapsedMs;
      const options = {now, classify: () => ({kind: 'rateLimited' as const, cooldownMs: COOLDOWN_MS})};
      await expect(withCredential(pool, store, fail, options)).rejects.toBeInstanceOf(CredentialsUnavailableError);
      expect(attempts).toEqual(cooling.flatMap((skip, i) => skip ? [] : [i + 1]));
      expect(new Set(attempts).size).toBe(attempts.length);
      attempts.length = 0;
      nowMs += COOLDOWN_MS;
      await expect(withCredential(pool, store, fail, options)).rejects.toBeInstanceOf(CredentialsUnavailableError);
      expect(attempts).toEqual(pool.slots.map(s => s.slot));
    },
  ), {numRuns: RUNS_MAX});
});

it('HealthyFailover: the first eligible successful slot wins without extra attempts', async () => {
  await fc.assert(fc.asyncProperty(fc.integer({min: 1, max: SLOTS_MAX}), async winner => {
    const pool: CredentialPool<number> = {
      service: SERVICE, names: [], warnings: [],
      slots: Array.from({length: SLOTS_MAX}, (_, i) => ({slot: i + 1, credential: i + 1})),
    };
    const attempts: number[] = [];
    const result = await withCredential(pool, memoryCooldownStore(), async (_credential, slot) => {
      attempts.push(slot);
      return {status: slot === winner ? 200 : 429};
    });
    expect(result.slot).toBe(winner);
    expect(attempts).toEqual(Array.from({length: winner}, (_, i) => i + 1));
  }), {numRuns: RUNS_MAX});
});
