import {makeFunctionReference} from 'convex/server';
import {v} from 'convex/values';
import {z} from 'zod';
import {openLedger, release as releaseSpend, reserve as reserveSpend, settle as settleSpend, type Ledger} from '@praxis/spend';
import {WEB_TOOL_LIMITS as LIMITS} from '@praxis/protocol';
import {requireServer} from './access.js';
import {internalMutation, action, type MutationCtx} from './functions.js';

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
const binding = {serverToken: v.string(), userId: v.string(), runId: v.string(), callId: v.string(),
  service: v.union(v.literal('exa'), v.literal('firecrawl')), estimateMicroUsd: v.number(), period: v.string()};
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
  args: binding,
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    const now = Date.now();
    const owner = await ctx.db.query('authDocuments').withIndex('model_id', q => q.eq('model', 'user').eq('id', a.userId)).unique();
    if (!owner || owner.data.deleting) return 'denied' as const;
    if (a.period !== periodFor(now)) return 'denied' as const;
    Count.parse(a.estimateMicroUsd);
    const allowance = await row(ctx, a.userId, ALLOWANCE_KIND, a.period);
    if (!allowance) return 'denied' as const;
    const grant = z.object({allowanceMicroUsd: Count}).parse(allowance.value);
    const saved = await row(ctx, a.userId, KIND, a.period);
    const state = saved ? UserState.parse(decode(saved.value)) : {ledger: openLedger(grant.allowanceMicroUsd), searches: [], reads: []};
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
  args: binding,
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
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
export const finishInternal = internalMutation({
  args: {...binding, actualMicroUsd: v.optional(v.number()), slot: v.optional(v.number())},
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    const saved = await row(ctx, a.userId, KIND, a.period);
    if (!saved) throw new Error('Missing web spend reservation');
    const state = UserState.parse(decode(saved.value));
    const key = keyFor(a);
    const nowMs = Date.now();
    const call = await row(ctx, a.userId, CALL_KIND, key);
    if (!call) throw new Error('Missing web call receipt');
    const receipt = z.object({state: z.enum(['reserved', 'closed']), period: z.string()}).parse(call.value);
    if (receipt.state === 'closed') return;
    const result = a.actualMicroUsd === undefined ? releaseSpend(state.ledger, {key, nowMs})
      : settleSpend(state.ledger, {key, nowMs, actualMicroUsd: a.actualMicroUsd});
    if (result.outcome.kind === 'unknown') throw new Error('Missing web spend reservation');
    const ledger = {...result.ledger, closed: {}};
    await write(ctx, a.userId, a.period, {...state, ledger});
    await ctx.db.patch(call._id, {value: {period: a.period, state: 'closed'}});
    if (a.actualMicroUsd !== undefined && result.outcome.kind === 'settled') {
      await ctx.db.insert('toolState', {userId: a.userId, kind: 'platformUsage', id: key,
        value: {payer: 'platform', service: a.service, slot: a.slot, actualMicroUsd: a.actualMicroUsd, period: a.period}});
    }
    const globalRow = await row(ctx, GLOBAL_OWNER, KIND, GLOBAL_ID);
    if (globalRow) {
      const global = GlobalState.parse(decode(globalRow.value));
      delete global.inFlight[JSON.stringify([a.userId, key])];
      await write(ctx, GLOBAL_OWNER, GLOBAL_ID, global);
    }
  },
});

const request = {userId: v.string(), runId: v.string(), callId: v.string(),
  service: v.union(v.literal('exa'), v.literal('firecrawl')), estimateMicroUsd: v.number(), period: v.string()};
export const reserve = action({
  args: {serverToken: v.string(), request: v.object(request)},
  handler: async (ctx, a): Promise<string> => {
    await requireServer(a.serverToken);
    return ctx.runMutation(makeFunctionReference<'mutation'>('webTools:reserveInternal'), {...a.request, serverToken: a.serverToken});
  },
});
export const finish = action({
  args: {serverToken: v.string(), request: v.object({...request, actualMicroUsd: v.optional(v.number()), slot: v.optional(v.number())})},
  handler: async (ctx, a): Promise<null> => {
    await requireServer(a.serverToken);
    await ctx.runMutation(makeFunctionReference<'mutation'>('webTools:finishInternal'), {...a.request, serverToken: a.serverToken});
    return null;
  },
});

export const attempt = action({
  args: {serverToken: v.string(), request: v.object(request)},
  handler: async (ctx, a): Promise<boolean> => {
    await requireServer(a.serverToken);
    return ctx.runMutation(makeFunctionReference<'mutation'>('webTools:attemptInternal'), {...a.request, serverToken: a.serverToken});
  },
});
