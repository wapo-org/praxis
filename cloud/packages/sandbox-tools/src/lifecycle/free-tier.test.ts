import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {SANDBOX_FREE_TIER as TIER, SANDBOX_RESOURCES} from '@praxis/protocol';
import {modalSandboxMicroUsd} from '@praxis/spend';
import {SANDBOX_ACTIVITY_TAIL_MS, SANDBOX_DAILY_MICRO_USD_MAX, SANDBOX_MONTHLY_MICRO_USD_MAX} from '../../../../convex/sandboxSpend.js';
import {SANDBOX_REFUSAL_MESSAGES} from './constants.js';
import {CREDENTIALS, SERVER_TOKEN, failure, setup} from './fixture.js';

const NOW = Date.UTC(2026, 10, 20, 15, 0, 0);
const NEXT_DAY = Date.UTC(2026, 10, 21);
const NEXT_MONTH = Date.UTC(2026, 11, 1);
const PERIOD = '2026-11';
const DAY = '2026-11-20';
const MINUTE_MS = 60_000;
const ONE_SLOT = {MODAL_TOKEN_ID: CREDENTIALS.MODAL_TOKEN_ID, MODAL_TOKEN_SECRET: CREDENTIALS.MODAL_TOKEN_SECRET};
const price = (ms: number) => modalSandboxMicroUsd(ms, SANDBOX_RESOURCES.CPU_CORES, SANDBOX_RESOURCES.MEMORY_MIB / 1_024);
const FULL_BOOT_MICRO_USD = price(SANDBOX_RESOURCES.LIFETIME_MS);

type Fixture = ReturnType<typeof setup>;

async function encoded(f: Fixture, userId: string, kind: string, id: string): Promise<unknown> {
  const row = await f.t.run(ctx => ctx.db.query('toolState')
    .withIndex('owner_kind_id', q => q.eq('userId', userId).eq('kind', kind).eq('id', id)).unique());
  if (!row || !('encoded' in row.value)) return undefined;
  return JSON.parse(row.value.encoded);
}

async function seedUsage(f: Fixture, userId: string, monthCharged: number, dayCharged: number) {
  const encodedValue = JSON.stringify({
    month: {chargedMicroUsd: monthCharged, reservedMicroUsd: 0},
    days: {[DAY]: {chargedMicroUsd: dayCharged, reservedMicroUsd: 0}},
  });
  await f.t.run(ctx => ctx.db.insert('toolState', {userId, kind: 'sandboxUsage', id: PERIOD, value: {encoded: encodedValue}}));
}

async function platformUsage(f: Fixture, userId: string) {
  const rows = await f.t.run(ctx => ctx.db.query('toolState').collect());
  return rows.filter(row => row.userId === userId && row.kind === 'platformUsage').map(row => row.value);
}

describe('sandbox free tier (PRA-170)', () => {
  beforeEach(() => {
    process.env.PRAXIS_CONVEX_SERVER_TOKEN = SERVER_TOKEN;
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('reserves one full lifetime at boot and settles it when the health check finds the sandbox gone', async () => {
    const f = setup();
    const userId = await f.owner();
    const first = await f.resolver.ensure(userId, 'workspace');
    const booted = (await f.row(userId))!;
    expect(booted.reservation).toMatchObject({generation: 1, period: PERIOD, day: DAY, estimateMicroUsd: FULL_BOOT_MICRO_USD});
    expect(f.modal.sandboxes[0]!.spec.timeoutMs).toBe(SANDBOX_RESOURCES.LIFETIME_MS);
    expect(await encoded(f, userId, 'sandboxUsage', PERIOD)).toMatchObject({month: {reservedMicroUsd: FULL_BOOT_MICRO_USD}});

    vi.setSystemTime(NOW + 30 * MINUTE_MS);
    f.modal.lose(first.sandboxId);
    await f.resolver.ensure(userId, 'workspace');
    // It was last used at boot, so Modal stopped billing one exec plus the idle timeout later, not 30 minutes later.
    const charged = price(SANDBOX_ACTIVITY_TAIL_MS);
    expect(await platformUsage(f, userId)).toEqual([{payer: 'platform', service: 'modal', slot: booted.slot, actualMicroUsd: charged, period: PERIOD}]);
    const second = (await f.row(userId))!.reservation!;
    expect(second.generation).toBe(2);
    // The day's cap is one lifetime, so the reboot only buys what the first boot left of it.
    expect(second.estimateMicroUsd).toBeLessThanOrEqual(SANDBOX_DAILY_MICRO_USD_MAX - charged);
    expect(f.modal.sandboxes[1]!.spec.timeoutMs).toBe(second.lifetimeMs);
    expect(await encoded(f, userId, 'sandboxUsage', PERIOD)).toMatchObject({
      month: {chargedMicroUsd: charged, reservedMicroUsd: second.estimateMicroUsd},
      days: {[DAY]: {chargedMicroUsd: charged, reservedMicroUsd: second.estimateMicroUsd}},
    });
    const ledger = await encoded(f, userId, 'platformLedger', PERIOD);
    expect(ledger).toMatchObject({spentMicroUsd: charged});
    expect(Object.keys((ledger as {reservations: object}).reservations)).toHaveLength(1);
  });

  it('settles the reservation when a failed boot releases its lock', async () => {
    const f = setup();
    const userId = await f.owner();
    f.modal.failNextCreate = true;
    await failure(f.resolver.ensure(userId, 'workspace'));
    const row = (await f.row(userId))!;
    expect(row.state.status).toBe('terminated');
    expect(row.reservation).toBeUndefined();
    expect(await platformUsage(f, userId)).toEqual([expect.objectContaining({service: 'modal', actualMicroUsd: 0})]);
    expect(await encoded(f, userId, 'sandboxUsage', PERIOD)).toMatchObject({month: {chargedMicroUsd: 0, reservedMicroUsd: 0}});
    expect(await encoded(f, 'platform:modal', 'sandboxSlot', String(row.slot))).toEqual({open: {}});
  });

  it('refuses a boot over the daily cap until the next UTC day and trims one that only part of the budget pays for', async () => {
    const f = setup();
    const capped = await f.owner();
    await seedUsage(f, capped, SANDBOX_DAILY_MICRO_USD_MAX, SANDBOX_DAILY_MICRO_USD_MAX - price(TIER.MIN_LIFETIME_MS - MINUTE_MS));
    const error = await failure(f.resolver.ensure(capped, 'workspace'));
    expect(error.detail).toMatchObject({code: 'unavailable', message: SANDBOX_REFUSAL_MESSAGES.daily_cap, retryAtMs: NEXT_DAY});
    expect(await f.row(capped)).toBeNull();
    expect(await encoded(f, capped, 'platformLedger', PERIOD)).toBeUndefined();
    expect(f.logs.at(-1)).toEqual({event: 'sandbox.unavailable', scope: 'workspace', slot: null, detail: 'daily_cap', retryAtMs: NEXT_DAY});

    const trimmed = await f.owner();
    await seedUsage(f, trimmed, 0, SANDBOX_DAILY_MICRO_USD_MAX - price(30 * MINUTE_MS));
    await f.resolver.ensure(trimmed, 'workspace');
    expect(f.modal.creates).toBe(1);
    expect(f.modal.sandboxes[0]!.spec.timeoutMs).toBe(30 * MINUTE_MS);
    expect((await f.row(trimmed))!.reservation).toMatchObject({lifetimeMs: 30 * MINUTE_MS, estimateMicroUsd: price(30 * MINUTE_MS)});
  });

  it('refuses at the monthly cap and at an exhausted platform allowance until the next UTC month', async () => {
    const f = setup();
    const monthly = await f.owner();
    await seedUsage(f, monthly, SANDBOX_MONTHLY_MICRO_USD_MAX, 0);
    expect((await failure(f.resolver.ensure(monthly, 'workspace'))).detail)
      .toMatchObject({message: SANDBOX_REFUSAL_MESSAGES.monthly_cap, retryAtMs: NEXT_MONTH});

    const granted = await f.owner();
    await f.t.run(ctx => ctx.db.insert('toolState', {userId: granted, kind: 'platformAllowance', id: PERIOD, value: {allowanceMicroUsd: 7_000}}));
    expect((await failure(f.resolver.ensure(granted, 'workspace'))).detail)
      .toMatchObject({message: SANDBOX_REFUSAL_MESSAGES.allowance, retryAtMs: NEXT_MONTH});
    expect(f.modal.creates).toBe(0);
  });

  it('allows one live sandbox per user across scopes', async () => {
    const f = setup();
    const userId = await f.owner();
    const expiresAt = NOW + SANDBOX_RESOURCES.LIFETIME_MS;
    await f.t.run(ctx => ctx.db.insert('sandboxes', {
      userId, scope: 'coding', slot: 1, volumeName: `praxis-coding-${'c'.repeat(32)}`, generation: 1,
      state: {status: 'ready', sandboxId: 'sb-coding', expiresAt}, lastUsedAt: NOW,
    }));
    const error = await failure(f.resolver.ensure(userId, 'workspace'));
    expect(error.detail).toMatchObject({message: SANDBOX_REFUSAL_MESSAGES.live_limit, retryAtMs: NOW + SANDBOX_ACTIVITY_TAIL_MS});

    vi.setSystemTime(NOW + SANDBOX_ACTIVITY_TAIL_MS);
    await f.resolver.ensure(userId, 'workspace');
    expect(f.modal.creates).toBe(1);
  });

  it('never lets parallel boots on one Modal account pass the slot cap', async () => {
    const f = setup(ONE_SLOT);
    const owners = await Promise.all(Array.from({length: TIER.SANDBOXES_PER_SLOT_MAX + 2}, () => f.owner()));
    const results = await Promise.allSettled(owners.map(userId => f.resolver.ensure(userId, 'workspace')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(TIER.SANDBOXES_PER_SLOT_MAX);
    const refused = results.filter(result => result.status === 'rejected');
    expect(refused).toHaveLength(2);
    for (const result of refused) {
      const detail = (result.reason as {detail: {message: string; retryAtMs: number}}).detail;
      expect(detail.message).toBe(SANDBOX_REFUSAL_MESSAGES.slot_busy);
      expect(detail.retryAtMs).toBeGreaterThanOrEqual(NOW + TIER.SLOT_RETRY_MS);
    }
    expect(f.modal.creates).toBe(TIER.SANDBOXES_PER_SLOT_MAX);
    const slot = await encoded(f, 'platform:modal', 'sandboxSlot', '1') as {open: object};
    expect(Object.keys(slot.open)).toHaveLength(TIER.SANDBOXES_PER_SLOT_MAX);
  });
});
