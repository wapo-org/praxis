import {expect, it, vi, afterEach} from 'vitest';
import {convexHarness} from '../../adapters/testing/convex-harness.js';
import {WEB_TOOL_LIMITS as LIMITS} from '@praxis/protocol';

const NOW = Date.UTC(2026, 10, 17);
async function fixture(allowanceMicroUsd = 1_000_000) {
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(NOW);
  const {t, rpc} = convexHarness();
  await t.run(ctx => ctx.db.insert('authDocuments', {model: 'user', id: 'user', data: {id: 'user'}}));
  await t.run(ctx => ctx.db.insert('toolState', {userId: 'user', kind: 'platformAllowance', id: '2026-11', value: {allowanceMicroUsd}}));
  let id = 0;
  const input = (service: 'exa' | 'firecrawl' = 'exa', userId = 'user') => ({userId, runId: 'run', callId: String(id++), service,
    estimateMicroUsd: service === 'exa' ? 7000 : 5000, period: '2026-11'});
  const reserve = (args = input()) => rpc.action('webTools:reserve', {request: args});
  const finish = (args: ReturnType<typeof input>, actualMicroUsd?: number) => actualMicroUsd === undefined
    ? rpc.action('webTools:release', {request: args}) : rpc.action('webTools:settle', {request: {...args, actualMicroUsd, slot: 1}});
  const attempt = (args: ReturnType<typeof input>) => rpc.action('webTools:attempt', {request: args});
  return {t, rpc, input, reserve, finish, attempt};
}
afterEach(() => vi.useRealTimers());
it('fails closed without a provisioned allowance and atomically prevents parallel spend overshoot', async () => {
  const f = await fixture(7000);
  expect(await f.reserve(f.input('exa', 'other'))).toBe('denied');
  const results = await Promise.all([f.reserve(), f.reserve()]);
  expect(results.sort()).toEqual(['denied', 'reserved']);
});
it('deduplicates call IDs and settles a platform ledger row once', async () => {
  const f = await fixture();
  const input = f.input();
  expect(await f.reserve(input)).toBe('reserved');
  expect(await f.reserve(input)).toBe('duplicate');
  await f.finish(input, 7000);
  await f.finish(input, 7000);
  expect(await f.reserve(input)).toBe('duplicate');
  const rows = await f.t.run(ctx => ctx.db.query('toolState').collect());
  expect(rows.filter(row => row.kind === 'platformUsage')).toHaveLength(1);
  expect(rows.find(row => row.kind === 'platformUsage')?.value).toMatchObject({payer: 'platform', actualMicroUsd: 7000, slot: 1});
});
it.each(['exa', 'firecrawl'] as const)('enforces the sliding hourly %s limit independently and renews after one hour', async service => {
  const f = await fixture();
  const limit = service === 'exa' ? LIMITS.SEARCHES_PER_HOUR_MAX : LIMITS.READS_PER_HOUR_MAX;
  for (let i = 0; i < limit; i++) {
    vi.setSystemTime(NOW + i * 2000);
    const input = f.input(service);
    expect(await f.reserve(input)).toBe('reserved');
    await f.finish(input, input.estimateMicroUsd);
  }
  expect(await f.reserve(f.input(service))).toBe('denied');
  vi.setSystemTime(NOW + LIMITS.HOUR_MS + 1);
  expect(await f.reserve(f.input(service))).toBe('reserved');
});
it('enforces the Exa global second cap across distinct users', async () => {
  const f = await fixture();
  const input = f.input();
  expect(await f.reserve(input)).toBe('reserved');
  for (let i = 0; i < LIMITS.EXA_SEARCHES_PER_SECOND_MAX; i++) expect(await f.attempt(input)).toBe(true);
  expect(await f.attempt(input)).toBe(false);
  vi.setSystemTime(NOW + 1001);
  expect(await f.attempt(input)).toBe(true);
});
it('enforces Firecrawl concurrency and releases slots on failures', async () => {
  const f = await fixture();
  const first = f.input('firecrawl');
  expect(await f.reserve(first)).toBe('reserved');
  expect(await f.attempt(first)).toBe(true);
  for (let i = 1; i < LIMITS.FIRECRAWL_IN_FLIGHT_MAX; i++) {
    const next = f.input('firecrawl');
    expect(await f.reserve(next)).toBe('reserved');
    expect(await f.attempt(next)).toBe(true);
  }
  const blocked = f.input('firecrawl');
  expect(await f.reserve(blocked)).toBe('reserved');
  expect(await f.attempt(blocked)).toBe(false);
  await f.finish(first);
  expect(await f.attempt(blocked)).toBe(true);
});
it('counts every Firecrawl failover attempt against the global minute cap', async () => {
  const f = await fixture();
  const input = f.input('firecrawl');
  expect(await f.reserve(input)).toBe('reserved');
  for (let i = 0; i < LIMITS.FIRECRAWL_READS_PER_MINUTE_MAX; i++) expect(await f.attempt(input)).toBe(true);
  expect(await f.attempt(input)).toBe(false);
  vi.setSystemTime(NOW + 60_001);
  expect(await f.attempt(input)).toBe(true);
});
it('denies new reservations after account deletion starts', async () => {
  const f = await fixture();
  await f.t.run(async ctx => {
    const user = await ctx.db.query('authDocuments').first();
    await ctx.db.patch(user!._id, {data: {id: 'user', deleting: true}});
  });
  expect(await f.reserve()).toBe('denied');
});
it('preserves sliding hourly limits when a new monthly allowance starts', async () => {
  const f = await fixture();
  const endOfMonth = Date.UTC(2026, 10, 30, 23, 59);
  for (let i = 0; i < LIMITS.SEARCHES_PER_HOUR_MAX; i++) {
    vi.setSystemTime(endOfMonth + i * 1001);
    const input = f.input();
    expect(await f.reserve(input)).toBe('reserved');
    await f.finish(input, 7000);
  }
  vi.setSystemTime(Date.UTC(2026, 11, 1));
  await f.t.run(ctx => ctx.db.insert('toolState', {userId: 'user', kind: 'platformAllowance', id: '2026-12', value: {allowanceMicroUsd: 1_000_000}}));
  expect(await f.reserve({...f.input(), period: '2026-12'})).toBe('denied');
});
it('rejects settlements that break the shared protocol contract', async () => {
  const f = await fixture();
  const input = f.input();
  expect(await f.reserve(input)).toBe('reserved');
  await expect(f.rpc.action('webTools:settle', {request: {...input, actualMicroUsd: 7000}})).rejects.toThrow();
  await expect(f.rpc.action('webTools:settle', {request: {...input, actualMicroUsd: -1, slot: 1}})).rejects.toThrow();
  await expect(f.rpc.action('webTools:reserve', {request: {...f.input(), period: 'November'}})).rejects.toThrow();
});
