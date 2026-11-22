import { describe, expect, it } from 'vitest';
import { calculate } from './stream-io.mjs';

describe('stream I/O model', () => {
  it('accounts for patches, cursor reads, final assembly, indexes and cleanup by hand', () => {
    const result = calculate({ durationMs: 2_000, tokensPerSecond: 1, token: 'é', flushMs: 1_000,
      documentOverheadBytes: 10, indexCount: 2, indexEntryBytes: 3, subscribers: 2, budgetBytes: 1_000 });
    expect(result.totalTokens).toBe(2);
    expect(result.payloadBytes).toBe(4);
    expect(result.rows).toEqual([
      { strategy: 'cumulative', readBytes: 106, writeBytes: 64, writes: 4, redisPayloadBytes: 0, totalBytes: 170, responsesPerMonth: 5 },
      { strategy: 'deltas', readBytes: 136, writeBytes: 68, writes: 5, redisPayloadBytes: 0, totalBytes: 204, responsesPerMonth: 4 },
      { strategy: 'redis', readBytes: 28, writeBytes: 20, writes: 1, redisPayloadBytes: 12, totalBytes: 48, responsesPerMonth: 20 },
    ]);
  });

  it('flushes a partial interval once and conserves the deterministic payload', () => {
    const result = calculate({ durationMs: 1_200, tokensPerSecond: 5, flushMs: 500, token: 'abc' });
    expect(result.totalTokens).toBe(6);
    expect(result.payloadBytes).toBe(18);
    expect(result.flushes).toBe(3);
  });

  it('does not bill a cached subscriber as another database read', () => {
    const one = calculate({ subscribers: 1, shareQueryCache: true });
    const three = calculate({ subscribers: 3, shareQueryCache: true });
    expect(three.rows.map(row => row.totalBytes)).toEqual(one.rows.map(row => row.totalBytes));
    const isolated = calculate({ subscribers: 3 });
    expect(isolated.rows[0].readBytes).toBeGreaterThan(three.rows[0].readBytes);
  });

  it('skips empty flushes and handles a response with no complete tokens', () => {
    expect(calculate({ durationMs: 1, tokensPerSecond: 1 }).flushes).toBe(0);
    expect(calculate({ durationMs: 2_000, tokensPerSecond: 1, flushMs: 1 }).flushes).toBe(2);
    expect(calculate({ subscribers: 0 }).rows[2].readBytes).toBe(0);
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid durations: %s', durationMs => {
    expect(() => calculate({ durationMs })).toThrow(RangeError);
  });

  it('rejects invalid counts and a missing token', () => {
    expect(() => calculate({ subscribers: 1.5 })).toThrow(RangeError);
    expect(() => calculate({ indexCount: -1 })).toThrow(RangeError);
    expect(() => calculate({ token: '' })).toThrow(TypeError);
  });
});
