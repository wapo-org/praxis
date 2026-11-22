import {v} from 'convex/values';
import {z} from 'zod';
import {openLedger, reserve as reserveSpend, settle as settleSpend, release as releaseSpend, type Ledger} from '@praxis/spend';
import {internalMutation, type MutationCtx} from '../functions.js';

const KIND = 'platformLedger';
const ALLOWANCE_KIND = 'platformAllowance';
const TTL_MS = 300_000;
const KEY_MAX_CHARS = 256;
const LEDGER_MAX_CHARS = 900_000;
const amount = v.number();

const nonNegativeInt = z.number().int().nonnegative();
const allowanceValueSchema = z.object({allowanceMicroUsd: nonNegativeInt});
const encodedValueSchema = z.object({encoded: z.string()});
const reservationSchema = z.object({
  key: z.string(),
  service: z.enum(['exa', 'firecrawl', 'modal', 'celeris']),
  estimateMicroUsd: nonNegativeInt,
  createdAtMs: z.number(),
  expiresAtMs: z.number(),
  orphaned: z.boolean(),
});
const closureSchema = z.object({
  key: z.string(),
  kind: z.enum(['settled', 'released']),
  chargedMicroUsd: nonNegativeInt,
  late: z.boolean(),
  atMs: z.number(),
});
const ledgerSchema: z.ZodType<Ledger> = z.object({
  allowanceMicroUsd: nonNegativeInt,
  spentMicroUsd: nonNegativeInt,
  overrunMicroUsd: nonNegativeInt,
  reservations: z.record(z.string(), reservationSchema),
  closed: z.record(z.string(), closureSchema),
});

async function row(ctx: MutationCtx, userId: string, kind: string, id: string) {
  // Querying the owner_kind_id index range serializes concurrent mutations on the same (userId, kind, id) key.
  return ctx.db.query('toolState').withIndex('owner_kind_id', q => q.eq('userId', userId).eq('kind', kind).eq('id', id)).first();
}

async function load(ctx: MutationCtx, userId: string, period: string): Promise<Ledger | null> {
  const allowanceRow = await row(ctx, userId, ALLOWANCE_KIND, period);
  if (!allowanceRow) return null;
  const allowance = allowanceValueSchema.parse(allowanceRow.value);
  const saved = await row(ctx, userId, KIND, period);
  if (!saved) return openLedger(allowance.allowanceMicroUsd);
  const {encoded} = encodedValueSchema.parse(saved.value);
  const parsed = ledgerSchema.parse(JSON.parse(encoded));
  return {...parsed, allowanceMicroUsd: allowance.allowanceMicroUsd};
}

async function write(ctx: MutationCtx, userId: string, period: string, ledger: Ledger) {
  const encoded = JSON.stringify(ledger);
  if (encoded.length > LEDGER_MAX_CHARS) throw new Error('Platform ledger exceeds document size limit');
  const existing = await row(ctx, userId, KIND, period);
  const value = {encoded};
  if (existing) await ctx.db.patch(existing._id, {value});
  else await ctx.db.insert('toolState', {userId, kind: KIND, id: period, value});
}

export const reserve = internalMutation({
  args: {userId: v.string(), period: v.string(), key: v.string(), estimateMicroUsd: amount},
  handler: async (ctx, args) => {
    if (!args.key || args.key.length > KEY_MAX_CHARS) throw new Error('Invalid reservation key');
    const ledger = await load(ctx, args.userId, args.period);
    if (!ledger) return false;
    const result = reserveSpend(ledger, {key: args.key, service: 'celeris', estimateMicroUsd: args.estimateMicroUsd, nowMs: Date.now(), ttlMs: TTL_MS});
    if (result.outcome.kind !== 'reserved' || result.outcome.replayed) return false;
    await write(ctx, args.userId, args.period, result.ledger);
    return true;
  },
});

export const close = internalMutation({
  args: {userId: v.string(), period: v.string(), key: v.string(), actualMicroUsd: v.optional(amount)},
  handler: async (ctx, args) => {
    const ledger = await load(ctx, args.userId, args.period);
    if (!ledger) return false;
    const result = args.actualMicroUsd === undefined
      ? releaseSpend(ledger, {key: args.key, nowMs: Date.now()})
      : settleSpend(ledger, {key: args.key, actualMicroUsd: args.actualMicroUsd, nowMs: Date.now()});
    if (result.outcome.kind === 'unknown') return false;
    await write(ctx, args.userId, args.period, result.ledger);
    return true;
  },
});
