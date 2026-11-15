import {describe, expect, it} from 'vitest';
import {CredentialsUnavailableError, credentialFor, healthySlots, memoryCooldownStore, orphanedSlots, placeOwner, pool} from './index.js';
import {fakeClock} from './testing.js';

const NAMES = ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET'];
function modal(slots: number) {
  const env: Record<string, string> = {};
  for (let n = 1; n <= slots; n++) {
    const suffix = n === 1 ? '' : `_${n}`;
    env[`MODAL_TOKEN_ID${suffix}`] = `id-${n}`;
    env[`MODAL_TOKEN_SECRET${suffix}`] = `secret-${n}`;
  }
  return pool(NAMES, env, {service: 'modal'});
}
const owners = Array.from({length: 1000}, (_, i) => `user_${i}`);
const all = (n: number) => Array.from({length: n}, (_, i) => i + 1);

describe('sticky placement', () => {
  it('spreads 1000 owners over 4 slots evenly and deterministically', () => {
    const four = modal(4);
    const counts = new Map<number, number>();
    for (const owner of owners) {
      const slot = placeOwner(four, owner, all(4));
      expect(placeOwner(four, owner, [4, 3, 2, 1])).toBe(slot);
      counts.set(slot, (counts.get(slot) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([1, 2, 3, 4]);
    // Independent hashing has ~13.7 sd at n=1000, so this fixed set only checks +-10%.
    for (const count of counts.values()) expect(Math.abs(count - 250)).toBeLessThanOrEqual(250 * 0.1);
  });

  it('stays within ±5% of an equal share at a sample size where that bound is meaningful', () => {
    const four = modal(4);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 40_000; i++) counts[placeOwner(four, `user_${i}`, all(4)) - 1]!++;
    for (const count of counts) expect(Math.abs(count - 10_000)).toBeLessThanOrEqual(10_000 * 0.05);
  });

  it('keeps every stored assignment when a fifth slot is added, and moves about 1/5 of fresh placements', async () => {
    const four = modal(4), five = modal(5);
    const stored = new Map(owners.map(o => [o, placeOwner(four, o, all(4))]));
    let moved = 0;
    for (const [owner, slot] of stored) {
      expect(await credentialFor(five, slot)).toEqual({MODAL_TOKEN_ID: `id-${slot}`, MODAL_TOKEN_SECRET: `secret-${slot}`});
      const fresh = placeOwner(five, owner, all(5));
      if (fresh !== slot) {
        moved++;
        expect(fresh).toBe(5);
      }
    }
    expect(moved).toBeGreaterThan(150);
    expect(moved).toBeLessThan(250);
  });

  it('places new owners only on healthy slots and throws when there are none', async () => {
    const clock = fakeClock();
    const store = memoryCooldownStore(clock.now);
    const four = modal(4);
    await store.mark('modal', 2, {reason: 'exhausted', until: clock.now() + 60_000});
    const healthy = await healthySlots(four, store, clock.now);
    expect(healthy).toEqual([1, 3, 4]);
    for (const owner of owners.slice(0, 200)) expect(placeOwner(four, owner, healthy)).not.toBe(2);
    expect(() => placeOwner(four, 'user_1', [])).toThrow(CredentialsUnavailableError);
    expect(() => placeOwner(four, 'user_1', [9])).toThrow(CredentialsUnavailableError);
    const failing = {get: async () => { throw new Error('redis down'); }, mark: async () => false};
    expect(await healthySlots(four, failing)).toEqual([1, 2, 3, 4]);
  });

  it('does not move an owner whose stored slot is cooling or gone', async () => {
    const clock = fakeClock();
    const store = memoryCooldownStore(clock.now);
    const four = modal(4);
    await store.mark('modal', 3, {reason: 'exhausted', until: clock.now() + 60_000});
    const cooling = await credentialFor(four, 3, store, clock.now).catch(e => e);
    expect(cooling).toBeInstanceOf(CredentialsUnavailableError);
    expect(cooling).toMatchObject({service: 'modal', detail: 'cooling', retryAt: new Date(clock.now() + 60_000)});
    expect(await credentialFor(four, 3)).toMatchObject({MODAL_TOKEN_ID: 'id-3'});
    clock.advance(60_000);
    expect(await credentialFor(four, 3, store, clock.now)).toMatchObject({MODAL_TOKEN_ID: 'id-3'});
    await expect(credentialFor(modal(2), 3, store, clock.now)).rejects.toMatchObject({name: 'CredentialsUnavailableError', detail: 'missing', retryAt: null});
  });

  it('reports stored slots that are no longer configured', () => {
    expect(orphanedSlots(modal(2), [1, 2, 4, 3, 4, 2])).toEqual([3, 4]);
    expect(orphanedSlots(modal(4), [1, 2, 3, 4])).toEqual([]);
  });
});
