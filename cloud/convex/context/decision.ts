import {v} from 'convex/values';
import {openLedger, reserve as reserveSpend, settle as settleSpend, release as releaseSpend, type Ledger} from '@praxis/spend';
import {internalMutation, type MutationCtx} from '../functions.js';

const KIND = 'contextDecisionLedger';
const ALLOWANCE_KIND = 'platformAllowance';
const TTL_MS = 300_000;
const amount = v.number();

async function row(ctx: MutationCtx, userId: string, kind: string, id: string) {
  return ctx.db.query('toolState').withIndex('owner_kind_id', q => q.eq('userId', userId).eq('kind', kind).eq('id', id)).unique();
}

async function load(ctx: MutationCtx, userId: string, period: string): Promise<Ledger | null> {
  const allowanceRow = await row(ctx, userId, ALLOWANCE_KIND, period);
  if (!allowanceRow) return null;
  const allowance = allowanceRow.value as {allowanceMicroUsd?: number};
  if (!Number.isSafeInteger(allowance.allowanceMicroUsd) || allowance.allowanceMicroUsd! < 0) throw new Error('Invalid platform allowance');
  const saved = await row(ctx, userId, KIND, period);
  if (!saved) return openLedger(allowance.allowanceMicroUsd!);
  const encoded = (saved.value as {encoded?: unknown}).encoded;
  if (typeof encoded !== 'string') throw new Error('Invalid context decision ledger');
  return {...JSON.parse(encoded) as Ledger, allowanceMicroUsd: allowance.allowanceMicroUsd!};
}

async function write(ctx: MutationCtx, userId: string, period: string, ledger: Ledger) {
  const existing = await row(ctx, userId, KIND, period);
  const value = {encoded: JSON.stringify(ledger)};
  if (existing) await ctx.db.patch(existing._id, {value});
  else await ctx.db.insert('toolState', {userId, kind: KIND, id: period, value});
}

export const reserve = internalMutation({
  args: {userId: v.string(), period: v.string(), key: v.string(), estimateMicroUsd: amount},
  handler: async (ctx, args) => {
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
