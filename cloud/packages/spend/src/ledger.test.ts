import {describe, expect, it} from 'vitest';
import {exaSearchMaxMicroUsd, firecrawlMaxMicroUsd, microUsdFromUsd, modalSandboxMaxMicroUsd} from './estimators.js';
import {availableMicroUsd, openLedger, reclaimExpired, release, reserve, settle} from './ledger.js';

const TTL_MS = 60_000;
const at = (nowMs: number) => ({nowMs, ttlMs: TTL_MS});

describe('reservation ledger', () => {
  it('reserves the worst case, settles the actual and refunds the rest', () => {
    const reserved = reserve(openLedger(10_000), {key: 'run:1:exa', service: 'exa', estimateMicroUsd: 7_000, ...at(0)});
    expect(reserved.outcome).toMatchObject({kind: 'reserved', replayed: false});
    expect(availableMicroUsd(reserved.ledger)).toBe(3_000);
    const settled = settle(reserved.ledger, {key: 'run:1:exa', actualMicroUsd: 5_000, nowMs: 10});
    expect(settled.outcome).toEqual({kind: 'settled', chargedMicroUsd: 5_000, refundedMicroUsd: 2_000, overrunMicroUsd: 0, late: false});
    expect(settled.ledger).toMatchObject({spentMicroUsd: 5_000, overrunMicroUsd: 0, reservations: {}});
    expect(availableMicroUsd(settled.ledger)).toBe(5_000);
  });

  it('refuses a reservation the allowance cannot cover, all or nothing', () => {
    const first = reserve(openLedger(10_000), {key: 'a', service: 'modal', estimateMicroUsd: 8_000, ...at(0)}).ledger;
    expect(reserve(first, {key: 'b', service: 'exa', estimateMicroUsd: 7_000, ...at(1)}).outcome).toEqual({kind: 'budget_exhausted', availableMicroUsd: 2_000, requestedMicroUsd: 7_000});
  });

  it('is idempotent by key: a replayed reserve returns the same reservation, a finished key never reserves again', () => {
    const {ledger} = reserve(openLedger(10_000), {key: 'k', service: 'exa', estimateMicroUsd: 7_000, ...at(0)});
    const replay = reserve(ledger, {key: 'k', service: 'exa', estimateMicroUsd: 7_000, ...at(5)});
    expect(replay.outcome).toMatchObject({kind: 'reserved', replayed: true});
    expect(replay.ledger).toBe(ledger);
    const settled = settle(ledger, {key: 'k', actualMicroUsd: 1, nowMs: 6}).ledger;
    expect(reserve(settled, {key: 'k', service: 'exa', estimateMicroUsd: 7_000, ...at(7)}).outcome).toMatchObject({kind: 'closed', closure: {kind: 'settled'}});
    expect(settle(settled, {key: 'k', actualMicroUsd: 1, nowMs: 8})).toMatchObject({ledger: settled, outcome: {kind: 'duplicate'}});
    expect(release(settled, {key: 'k', nowMs: 9})).toMatchObject({ledger: settled, outcome: {kind: 'duplicate'}});
    expect(settle(settled, {key: 'never', actualMicroUsd: 1, nowMs: 9}).outcome).toEqual({kind: 'unknown'});
  });

  it('releases a cancelled call in full', () => {
    const {ledger} = reserve(openLedger(10_000), {key: 'k', service: 'firecrawl', estimateMicroUsd: 9_000, ...at(0)});
    const released = release(ledger, {key: 'k', nowMs: 1});
    expect(released.outcome).toEqual({kind: 'released', refundedMicroUsd: 9_000});
    expect(availableMicroUsd(released.ledger)).toBe(10_000);
  });

  it('reclaims expired reservations, and still charges a late settle as overrun', () => {
    const {ledger} = reserve(openLedger(10_000), {key: 'slow', service: 'modal', estimateMicroUsd: 9_000, ...at(0)});
    const reclaimed = reclaimExpired(ledger, TTL_MS);
    expect(reclaimed.outcome.reclaimed).toEqual(['slow']);
    expect(availableMicroUsd(reclaimed.ledger)).toBe(10_000);
    expect(reserve(ledger, {key: 'other', service: 'exa', estimateMicroUsd: 7_000, ...at(TTL_MS)}).outcome).toMatchObject({kind: 'reserved'});
    const late = settle(reclaimed.ledger, {key: 'slow', actualMicroUsd: 4_000, nowMs: TTL_MS + 1});
    expect(late.outcome).toEqual({kind: 'settled', chargedMicroUsd: 4_000, refundedMicroUsd: 0, overrunMicroUsd: 4_000, late: true});
    expect(late.ledger).toMatchObject({spentMicroUsd: 4_000, overrunMicroUsd: 4_000});
    expect(reserve(reclaimed.ledger, {key: 'slow', service: 'modal', estimateMicroUsd: 1, ...at(TTL_MS + 2)}).outcome).toMatchObject({kind: 'closed', closure: {kind: 'expired'}});
  });

  it('records an actual above the reservation as overrun rather than hiding it', () => {
    const {ledger} = reserve(openLedger(10_000), {key: 'k', service: 'exa', estimateMicroUsd: 7_000, ...at(0)});
    expect(settle(ledger, {key: 'k', actualMicroUsd: 8_000, nowMs: 1}).ledger).toMatchObject({spentMicroUsd: 8_000, overrunMicroUsd: 1_000});
  });

  it('rejects non-integer or negative amounts', () => {
    expect(() => openLedger(-1)).toThrow(RangeError);
    expect(() => reserve(openLedger(10), {key: 'k', service: 'exa', estimateMicroUsd: 0.5, ...at(0)})).toThrow(RangeError);
    expect(() => reserve(openLedger(10), {key: '', service: 'exa', estimateMicroUsd: 1, ...at(0)})).toThrow(RangeError);
  });
});

describe('worst-case estimators', () => {
  it('prices Exa, Firecrawl and Modal from the named unit constants, rounding up', () => {
    expect(exaSearchMaxMicroUsd(10)).toBe(7_000);
    expect(exaSearchMaxMicroUsd(25)).toBe(22_000);
    expect(firecrawlMaxMicroUsd(10)).toBe(316_700);
    expect(firecrawlMaxMicroUsd(1, 3)).toBe(50_672);
    expect(modalSandboxMaxMicroUsd(1)).toBe(3_172);
    expect(modalSandboxMaxMicroUsd(10, 0.125, 0.25)).toBe(3_965);
    expect(microUsdFromUsd(0.0071)).toBe(7_100);
    expect(microUsdFromUsd(0.00000001)).toBe(1);
  });
});
