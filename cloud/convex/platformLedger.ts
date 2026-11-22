import {z} from 'zod';
import {
  FREE_TIER_PLATFORM_ALLOWANCE_MICRO_USD,
  openLedger,
  release as releaseSpend,
  settle as settleSpend,
  type Ledger,
  type PlatformService,
  type ReleaseOutcome,
  type SettleOutcome,
} from '@praxis/spend';
import type {MutationCtx} from './functions.js';

// One platform ledger per owner and UTC month, shared by every platform-paid service (web tools, Modal sandboxes).

const LEDGER_KIND = 'platformLedger';
const ALLOWANCE_KIND = 'platformAllowance';
const USAGE_KIND = 'platformUsage';
const Count = z.number().int().nonnegative();
const Reservation = z.object({key: z.string(), service: z.enum(['exa', 'firecrawl', 'modal', 'celeris']), estimateMicroUsd: Count,
  createdAtMs: Count, expiresAtMs: Count, orphaned: z.boolean()});
const Closure = z.object({key: z.string(), kind: z.enum(['settled', 'released']), chargedMicroUsd: Count, late: z.boolean(), atMs: Count});
const LedgerSchema: z.ZodType<Ledger> = z.object({allowanceMicroUsd: Count, spentMicroUsd: Count, overrunMicroUsd: Count,
  reservations: z.record(z.string(), Reservation), closed: z.record(z.string(), Closure)});
const Encoded = z.object({encoded: z.string()});

/** The UTC billing month, `YYYY-MM`. */
export function periodFor(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 7);
}

/** The first millisecond of the UTC month after `nowMs`: when a monthly cap renews. */
export function nextPeriodStartMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

export async function toolStateRow(ctx: MutationCtx, userId: string, kind: string, id: string) {
  return ctx.db.query('toolState').withIndex('owner_kind_id', q => q.eq('userId', userId).eq('kind', kind).eq('id', id)).unique();
}

/** Reads a JSON-encoded `toolState` value; callers parse the result with their own schema. */
export async function readEncoded(ctx: MutationCtx, userId: string, kind: string, id: string): Promise<unknown> {
  const existing = await toolStateRow(ctx, userId, kind, id);
  return existing ? JSON.parse(Encoded.parse(existing.value).encoded) : undefined;
}

export async function writeEncoded(ctx: MutationCtx, userId: string, kind: string, id: string, value: unknown): Promise<void> {
  const existing = await toolStateRow(ctx, userId, kind, id);
  const encoded = JSON.stringify(value);
  if (existing) await ctx.db.patch(existing._id, {value: {encoded}});
  else await ctx.db.insert('toolState', {userId, kind, id, value: {encoded}});
}

/** A provisioned grant wins; without one every active owner gets the free-tier allowance (PRA-170 owner decision). */
async function allowanceFor(ctx: MutationCtx, userId: string, period: string): Promise<number> {
  const grant = await toolStateRow(ctx, userId, ALLOWANCE_KIND, period);
  if (!grant) return FREE_TIER_PLATFORM_ALLOWANCE_MICRO_USD;
  return z.object({allowanceMicroUsd: Count}).parse(grant.value).allowanceMicroUsd;
}

/** The owner's ledger for `period` with the current allowance applied; the caller saves it in the same mutation. */
export async function loadPlatformLedger(ctx: MutationCtx, userId: string, period: string): Promise<Ledger> {
  const allowanceMicroUsd = await allowanceFor(ctx, userId, period);
  const saved = await readEncoded(ctx, userId, LEDGER_KIND, period);
  const ledger = saved === undefined ? openLedger(allowanceMicroUsd) : LedgerSchema.parse(saved);
  return {...ledger, allowanceMicroUsd};
}

/** Closed keys are not kept: each service's own receipt (call row, sandbox generation) already makes a close happen once. */
export async function savePlatformLedger(ctx: MutationCtx, userId: string, period: string, ledger: Ledger): Promise<void> {
  await writeEncoded(ctx, userId, LEDGER_KIND, period, {...ledger, closed: {}});
}

export interface PlatformCharge {
  service: PlatformService;
  slot: number;
  actualMicroUsd: number;
}

/** Settles with a charge, or releases without one, and books the `platformUsage` row for a charge. */
export async function closePlatformSpend(
  ctx: MutationCtx,
  userId: string,
  period: string,
  key: string,
  charge?: PlatformCharge,
): Promise<SettleOutcome | ReleaseOutcome> {
  const ledger = await loadPlatformLedger(ctx, userId, period);
  const nowMs = Date.now();
  const result = charge
    ? settleSpend(ledger, {key, nowMs, actualMicroUsd: charge.actualMicroUsd})
    : releaseSpend(ledger, {key, nowMs});
  if (result.outcome.kind === 'unknown') return result.outcome;
  await savePlatformLedger(ctx, userId, period, result.ledger);
  if (charge && result.outcome.kind === 'settled') {
    await ctx.db.insert('toolState', {userId, kind: USAGE_KIND, id: key, value: {
      payer: 'platform', service: charge.service, slot: charge.slot, actualMicroUsd: charge.actualMicroUsd, period,
    }});
  }
  return result.outcome;
}
