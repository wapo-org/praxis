import {makeFunctionReference, type GenericActionCtx} from 'convex/server';
import {v} from 'convex/values';
import {z} from 'zod';
import {openLedger, release as releaseSpend, reserve as reserveSpend, settle as settleSpend, type Ledger} from '@praxis/spend';
import {WEB_TOOL_LIMITS as LIMITS, WebSpendAdmissionSchema, WebSpendRequestSchema, WebSpendSettlementSchema,
  type WebSpendAdmission, type WebSpendRequest, type WebSpendSettlement} from '@praxis/protocol';
import {requireServer} from './access.js';
import {internalMutation, action, type DataModel, type MutationCtx} from './functions.js';
import {convexValidator} from './zodValidator.js';

const KIND = 'webAccounting';
const GLOBAL_OWNER = 'platform:web-tools';
const GLOBAL_ID = 'admission';
const CALL_KIND = 'webSpendCall';
const ALLOWANCE_KIND = 'platformAllowance';
// The reservation outlives the bounded HTTP request so uncertain attempts remain held for reconciliation.
const RESERVATION_TTL_MS = 300_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;
const Count = z.number().int().nonnegative();
const Reservation = z.object({key: z.string(), service: z.enum(['exa', 'firecrawl', 'modal']), estimateMicroUsd: Count,
  createdAtMs: Count, expiresAtMs: Count, orphaned: z.boolean()});
const Closure = z.object({key: z.string(), kind: z.enum(['settled', 'released']), chargedMicroUsd: Count, late: z.boolean(), atMs: Count});
const LedgerSchema: z.ZodType<Ledger> = z.object({allowanceMicroUsd: Count, spentMicroUsd: Count, overrunMicroUsd: Count,
  reservations: z.record(z.string(), Reservation), closed: z.record(z.string(), Closure)});
const UserState = z.object({ledger: LedgerSchema, searches: z.array(Count), reads: z.array(Count)});
const GlobalState = z.object({searches: z.array(Count), reads: z.array(Count), inFlight: z.record(z.string(), Count)});
const requestArgs = {serverToken: v.string(), request: convexValidator(WebSpendRequestSchema)};
const settlementArgs = {serverToken: v.string(), request: convexValidator(WebSpendSettlementSchema)};
const keyFor = (a: {runId: string; callId: string; service: string}) => JSON.stringify([a.runId, a.callId, a.service]);
const periodFor = (now: number) => new Date(now).toISOString().slice(0, 7);
async function row(ctx: MutationCtx, userId: string, kind: string, id: string) {
  return ctx.db.query('toolState').withIndex('owner_kind_id', q => q.eq('userId', userId).eq('kind', kind).eq('id', id)).unique();
}
async function write(ctx: MutationCtx, userId: string, id: string, value: unknown) {
  const existing = await row(ctx, userId, KIND, id);
  const encoded = JSON.stringify(value);
  if (existing) await ctx.db.patch(existing._id, {value: {encoded}});
  else await ctx.db.insert('toolState', {userId, kind: KIND, id, value: {encoded}});
}
function decode(value: unknown): unknown {
  return JSON.parse(z.object({encoded: z.string()}).parse(value).encoded);
}
export const reserveInternal = internalMutation({
  args: requestArgs,
  handler: async (ctx, args): Promise<WebSpendAdmission> => {
    await requireServer(args.serverToken);
    const a = WebSpendRequestSchema.parse(args.request);
    const now = Date.now();
    const owner = await ctx.db.query('authDocuments').withIndex('model_id', q => q.eq('model', 'user').eq('id', a.userId)).unique();
    if (!owner || owner.data.deleting) return 'denied' as const;
    if (a.period !== periodFor(now)) return 'denied' as const;
    const allowance = await row(ctx, a.userId, ALLOWANCE_KIND, a.period);
    if (!allowance) return 'denied' as const;
    const grant = z.object({allowanceMicroUsd: Count}).parse(allowance.value);
    const saved = await row(ctx, a.userId, KIND, a.period);
    const state = saved ? UserState.parse(decode(saved.value)) : {ledger: openLedger(grant.allowanceMicroUsd), searches: [], reads: []};
    if (!saved) {
      const previousPeriod = periodFor(now - LIMITS.HOUR_MS);
      if (previousPeriod !== a.period) {
        const previous = await row(ctx, a.userId, KIND, previousPeriod);
        if (previous) {
          const previousState = UserState.parse(decode(previous.value));
          state.searches = previousState.searches;
          state.reads = previousState.reads;
        }
      }
    }
    state.ledger.allowanceMicroUsd = grant.allowanceMicroUsd;
    const key = keyFor(a);
    if (await row(ctx, a.userId, CALL_KIND, key)) return 'duplicate' as const;
    const reservation = reserveSpend(state.ledger, {key, service: a.service, estimateMicroUsd: a.estimateMicroUsd, nowMs: now, ttlMs: RESERVATION_TTL_MS});
    if (reservation.outcome.kind !== 'reserved') return reservation.outcome.kind === 'budget_exhausted' ? 'denied' as const : 'duplicate' as const;
    if (reservation.outcome.replayed) return 'duplicate' as const;
    state.searches = state.searches.filter(at => at > now - LIMITS.HOUR_MS);
    state.reads = state.reads.filter(at => at > now - LIMITS.HOUR_MS);
    if (a.service === 'exa') {
      if (state.searches.length >= LIMITS.SEARCHES_PER_HOUR_MAX) return 'denied' as const;
      state.searches.push(now);
    } else {
      if (state.reads.length >= LIMITS.READS_PER_HOUR_MAX) return 'denied' as const;
      state.reads.push(now);
    }
    await ctx.db.insert('toolState', {userId: a.userId, kind: CALL_KIND, id: key, value: {period: a.period, state: 'reserved'}});
    state.ledger = reservation.ledger;
    await write(ctx, a.userId, a.period, state);
    return 'reserved' as const;
  },
});
export const attemptInternal = internalMutation({
  args: requestArgs,
  handler: async (ctx, args): Promise<boolean> => {
    await requireServer(args.serverToken);
    const a = WebSpendRequestSchema.parse(args.request);
    const now = Date.now();
    const owner = await ctx.db.query('authDocuments').withIndex('model_id', q => q.eq('model', 'user').eq('id', a.userId)).unique();
    if (!owner || owner.data.deleting) return false;
    const saved = await row(ctx, a.userId, KIND, a.period);
    if (!saved) return false;
    const state = UserState.parse(decode(saved.value));
    const reservation = state.ledger.reservations[keyFor(a)];
    if (!reservation || reservation.expiresAtMs <= now) return false;
    const globalRow = await row(ctx, GLOBAL_OWNER, KIND, GLOBAL_ID);
    const global = globalRow ? GlobalState.parse(decode(globalRow.value)) : {searches: [], reads: [], inFlight: {}};
    global.searches = global.searches.filter(at => at > now - SECOND_MS);
    global.reads = global.reads.filter(at => at > now - MINUTE_MS);
    global.inFlight = Object.fromEntries(Object.entries(global.inFlight).filter(([, expires]) => expires > now));
    const flightKey = JSON.stringify([a.userId, keyFor(a)]);
    if (a.service === 'exa') {
      if (global.searches.length >= LIMITS.EXA_SEARCHES_PER_SECOND_MAX) return false;
      global.searches.push(now);
    } else {
      const active = Object.keys(global.inFlight).filter(key => key !== flightKey).length;
      if (global.reads.length >= LIMITS.FIRECRAWL_READS_PER_MINUTE_MAX || active >= LIMITS.FIRECRAWL_IN_FLIGHT_MAX) return false;
      global.reads.push(now);
      global.inFlight[flightKey] = now + RESERVATION_TTL_MS;
    }
    await write(ctx, GLOBAL_OWNER, GLOBAL_ID, global);
    return true;
  },
});
// A settlement records the provider charge; a release is only for calls that provably never billed.
async function close(ctx: MutationCtx, a: WebSpendRequest, charge?: WebSpendSettlement) {
  const saved = await row(ctx, a.userId, KIND, a.period);
  if (!saved) throw new Error('Missing web spend reservation');
  const state = UserState.parse(decode(saved.value));
  const key = keyFor(a);
  const nowMs = Date.now();
  const call = await row(ctx, a.userId, CALL_KIND, key);
  if (!call) throw new Error('Missing web call receipt');
  const receipt = z.object({state: z.enum(['reserved', 'closed']), period: z.string()}).parse(call.value);
  if (receipt.state === 'closed') return;
  const result = charge ? settleSpend(state.ledger, {key, nowMs, actualMicroUsd: charge.actualMicroUsd})
    : releaseSpend(state.ledger, {key, nowMs});
  if (result.outcome.kind === 'unknown') throw new Error('Missing web spend reservation');
  const ledger = {...result.ledger, closed: {}};
  await write(ctx, a.userId, a.period, {...state, ledger});
  await ctx.db.patch(call._id, {value: {period: a.period, state: 'closed'}});
  if (charge && result.outcome.kind === 'settled') {
    await ctx.db.insert('toolState', {userId: a.userId, kind: 'platformUsage', id: key,
      value: {payer: 'platform', service: a.service, slot: charge.slot, actualMicroUsd: charge.actualMicroUsd, period: a.period}});
  }
  const globalRow = await row(ctx, GLOBAL_OWNER, KIND, GLOBAL_ID);
  if (globalRow) {
    const global = GlobalState.parse(decode(globalRow.value));
    delete global.inFlight[JSON.stringify([a.userId, key])];
    await write(ctx, GLOBAL_OWNER, GLOBAL_ID, global);
  }
}
export const settleInternal = internalMutation({
  args: settlementArgs,
  handler: async (ctx, args) => {
    await requireServer(args.serverToken);
    const charge = WebSpendSettlementSchema.parse(args.request);
    await close(ctx, charge, charge);
  },
});
export const releaseInternal = internalMutation({
  args: requestArgs,
  handler: async (ctx, args) => {
    await requireServer(args.serverToken);
    await close(ctx, WebSpendRequestSchema.parse(args.request));
  },
});

async function forward(ctx: GenericActionCtx<DataModel>, name: string, args: {serverToken: string; request: unknown}): Promise<unknown> {
  await requireServer(args.serverToken);
  return ctx.runMutation(makeFunctionReference<'mutation'>(`webTools:${name}`), args);
}
export const reserve = action({
  args: requestArgs,
  handler: async (ctx, args): Promise<WebSpendAdmission> => WebSpendAdmissionSchema.parse(await forward(ctx, 'reserveInternal', args)),
});
export const attempt = action({
  args: requestArgs,
  handler: async (ctx, args): Promise<boolean> => z.boolean().parse(await forward(ctx, 'attemptInternal', args)),
});
export const settle = action({
  args: settlementArgs,
  handler: async (ctx, args): Promise<null> => {
    await forward(ctx, 'settleInternal', args);
    return null;
  },
});
export const release = action({
  args: requestArgs,
  handler: async (ctx, args): Promise<null> => {
    await forward(ctx, 'releaseInternal', args);
    return null;
  },
});
