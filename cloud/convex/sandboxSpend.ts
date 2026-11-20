import {z} from 'zod';
import {
  SANDBOX_FREE_TIER as TIER,
  SANDBOX_LIFECYCLE,
  SANDBOX_RESOURCES,
  type SandboxRefusalReason,
} from '@praxis/protocol';
import {availableMicroUsd, modalSandboxAffordableMs, modalSandboxMicroUsd, reserve} from '@praxis/spend';
import type {Doc} from './_generated/dataModel.js';
import type {MutationCtx} from './functions.js';
import {closePlatformSpend, loadPlatformLedger, nextPeriodStartMs, periodFor, readEncoded, savePlatformLedger,
  writeEncoded} from './platformLedger.js';

// Free-tier sandbox admission (PRA-170): runs inside `sandboxes:claim`, so every check and the reservation are one transaction.

const MIB_PER_GIB = 1_024;
const MEMORY_GIB = SANDBOX_RESOURCES.MEMORY_MIB / MIB_PER_GIB;
const USAGE_KIND = 'sandboxUsage';
const SLOT_OWNER = 'platform:modal';
const SLOT_KIND = 'sandboxSlot';

const price = (durationMs: number) => modalSandboxMicroUsd(durationMs, SANDBOX_RESOURCES.CPU_CORES, MEMORY_GIB);
const affordableMs = (budgetMicroUsd: number) => modalSandboxAffordableMs(budgetMicroUsd, SANDBOX_RESOURCES.CPU_CORES, MEMORY_GIB);

export const SANDBOX_DAILY_MICRO_USD_MAX = price(TIER.DAILY_SANDBOX_MS_MAX);
export const SANDBOX_MONTHLY_MICRO_USD_MAX = price(TIER.MONTHLY_SANDBOX_MS_MAX);
/** After its last claim a sandbox may still run one exec and then idle out, so it can bill until this long after. */
export const SANDBOX_ACTIVITY_TAIL_MS = SANDBOX_RESOURCES.EXEC_MAX_MS + SANDBOX_RESOURCES.IDLE_TIMEOUT_MS;

const Count = z.number().int().nonnegative();
const Spend = z.object({chargedMicroUsd: Count, reservedMicroUsd: Count});
type Spend = z.infer<typeof Spend>;
/** Per owner and UTC month; charges are booked to the month and day the boot started. */
const Usage = z.object({month: Spend, days: z.record(z.string(), Spend)});
type Usage = z.infer<typeof Usage>;
/** Per Modal slot: each open boot and the latest moment its sandbox can still be running. */
const SlotState = z.object({open: z.record(z.string(), Count)});

type SandboxRow = Doc<'sandboxes'>;
export type SandboxReservation = NonNullable<SandboxRow['reservation']>;

export type Admission =
  | {kind: 'admitted'; lifetimeMs: number; reservation: SandboxReservation}
  | {kind: 'unavailable'; reason: SandboxRefusalReason; retryAtMs: number};

const EMPTY_SPEND: Spend = {chargedMicroUsd: 0, reservedMicroUsd: 0};

function dayFor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function nextDayStartMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

function reservationKey(volumeName: string, generation: number): string {
  return `sandbox:${volumeName}:${generation}`;
}

/** The latest moment a row's sandbox can still be billing, or undefined when it is certainly gone. */
function liveUntil(row: SandboxRow, now: number): number | undefined {
  const state = row.state;
  if (state.status === 'terminated') return undefined;
  const until = state.status === 'booting'
    ? state.leaseExpiresAt
    : Math.min(state.expiresAt, row.lastUsedAt + SANDBOX_ACTIVITY_TAIL_MS);
  return until > now ? until : undefined;
}

async function usageFor(ctx: MutationCtx, userId: string, period: string): Promise<Usage> {
  const saved = await readEncoded(ctx, userId, USAGE_KIND, period);
  return saved === undefined ? {month: EMPTY_SPEND, days: {}} : Usage.parse(saved);
}

async function slotState(ctx: MutationCtx, slot: number, now: number): Promise<Record<string, number>> {
  const saved = await readEncoded(ctx, SLOT_OWNER, SLOT_KIND, String(slot));
  const open = saved === undefined ? {} : SlotState.parse(saved).open;
  return Object.fromEntries(Object.entries(open).filter(([, until]) => until > now));
}

function spent(spend: Spend | undefined): number {
  return spend ? spend.chargedMicroUsd + spend.reservedMicroUsd : 0;
}

function adjust(spend: Spend | undefined, delta: {charged: number; reserved: number}): Spend {
  const base = spend ?? EMPTY_SPEND;
  return {
    chargedMicroUsd: base.chargedMicroUsd + delta.charged,
    reservedMicroUsd: Math.max(0, base.reservedMicroUsd + delta.reserved),
  };
}

async function liveLimit(ctx: MutationCtx, userId: string, scope: string, now: number): Promise<Admission | undefined> {
  const rows = await ctx.db.query('sandboxes').withIndex('by_user_scope', q => q.eq('userId', userId)).collect();
  const others = rows.filter(row => row.scope !== scope).map(row => liveUntil(row, now)).filter(until => until !== undefined);
  if (others.length < TIER.LIVE_SANDBOXES_PER_USER_MAX) return undefined;
  return {kind: 'unavailable', reason: 'live_limit', retryAtMs: Math.min(...others)};
}

interface Budget {
  reason: SandboxRefusalReason;
  leftMicroUsd: number;
  retryAtMs: number;
}

/** The time a boot may buy, or the budget that refuses it; a later renewal wins so the retry time is honest. */
function lifetimeOrRefusal(budgets: Budget[]): {lifetimeMs: number} | Admission {
  const short = budgets.filter(budget => affordableMs(budget.leftMicroUsd) < TIER.MIN_LIFETIME_MS);
  if (short.length) {
    const binding = short.reduce((a, b) => (b.retryAtMs > a.retryAtMs ? b : a));
    return {kind: 'unavailable', reason: binding.reason, retryAtMs: binding.retryAtMs};
  }
  const left = Math.min(...budgets.map(budget => budget.leftMicroUsd));
  return {lifetimeMs: Math.min(SANDBOX_RESOURCES.LIFETIME_MS, affordableMs(left))};
}

export interface BootRequest {
  userId: string;
  scope: string;
  slot: number;
  volumeName: string;
  generation: number;
  now: number;
}

/** Checks every free-tier limit and reserves the boot's worst case; a refusal writes nothing. */
export async function admitBoot(ctx: MutationCtx, boot: BootRequest): Promise<Admission> {
  const {userId, now} = boot;
  const live = await liveLimit(ctx, userId, boot.scope, now);
  if (live) return live;
  const open = await slotState(ctx, boot.slot, now);
  if (Object.keys(open).length >= TIER.SANDBOXES_PER_SLOT_MAX) {
    return {kind: 'unavailable', reason: 'slot_busy', retryAtMs: now + TIER.SLOT_RETRY_MS};
  }
  const period = periodFor(now);
  const day = dayFor(now);
  const usage = await usageFor(ctx, userId, period);
  const ledger = await loadPlatformLedger(ctx, userId, period);
  const decided = lifetimeOrRefusal([
    {reason: 'daily_cap', leftMicroUsd: SANDBOX_DAILY_MICRO_USD_MAX - spent(usage.days[day]), retryAtMs: nextDayStartMs(now)},
    {reason: 'monthly_cap', leftMicroUsd: SANDBOX_MONTHLY_MICRO_USD_MAX - spent(usage.month), retryAtMs: nextPeriodStartMs(now)},
    {reason: 'allowance', leftMicroUsd: availableMicroUsd(ledger), retryAtMs: nextPeriodStartMs(now)},
  ]);
  if ('kind' in decided) return decided;
  const {lifetimeMs} = decided;
  const estimateMicroUsd = price(lifetimeMs);
  const key = reservationKey(boot.volumeName, boot.generation);
  const step = reserve(ledger, {key, service: 'modal', estimateMicroUsd, nowMs: now, ttlMs: SANDBOX_LIFECYCLE.BOOT_LEASE_MS + lifetimeMs});
  if (step.outcome.kind !== 'reserved' || step.outcome.replayed) throw new Error(`Sandbox reservation not taken: ${step.outcome.kind}`);
  await savePlatformLedger(ctx, userId, period, step.ledger);
  await writeEncoded(ctx, userId, USAGE_KIND, period, {
    month: adjust(usage.month, {charged: 0, reserved: estimateMicroUsd}),
    days: {...usage.days, [day]: adjust(usage.days[day], {charged: 0, reserved: estimateMicroUsd})},
  });
  open[key] = now + SANDBOX_LIFECYCLE.BOOT_LEASE_MS + lifetimeMs;
  await writeEncoded(ctx, SLOT_OWNER, SLOT_KIND, String(boot.slot), {open});
  return {
    kind: 'admitted',
    lifetimeMs,
    reservation: {generation: boot.generation, period, day, startedAtMs: now, lifetimeMs, estimateMicroUsd},
  };
}

/** Modal stops an idle sandbox one exec plus the idle timeout after its last claim, so billing ended by then (live-checked). */
export async function settleBoot(ctx: MutationCtx, row: SandboxRow, at: {now: number; lastActiveAt: number}): Promise<void> {
  const reservation = row.reservation;
  if (!reservation) return;
  const {now} = at;
  const end = Math.min(now, at.lastActiveAt + SANDBOX_ACTIVITY_TAIL_MS);
  const durationMs = Math.min(reservation.lifetimeMs, Math.max(0, end - reservation.startedAtMs));
  const actualMicroUsd = Math.min(price(durationMs), reservation.estimateMicroUsd);
  const key = reservationKey(row.volumeName, reservation.generation);
  await closePlatformSpend(ctx, row.userId, reservation.period, key, {service: 'modal', slot: row.slot, actualMicroUsd});
  const usage = await usageFor(ctx, row.userId, reservation.period);
  const delta = {charged: actualMicroUsd, reserved: -reservation.estimateMicroUsd};
  await writeEncoded(ctx, row.userId, USAGE_KIND, reservation.period, {
    month: adjust(usage.month, delta),
    days: {...usage.days, [reservation.day]: adjust(usage.days[reservation.day], delta)},
  });
  const open = await slotState(ctx, row.slot, now);
  delete open[key];
  await writeEncoded(ctx, SLOT_OWNER, SLOT_KIND, String(row.slot), {open});
  await ctx.db.patch(row._id, {reservation: undefined});
}
