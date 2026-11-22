import {makeFunctionReference, type GenericActionCtx} from 'convex/server';
import {v} from 'convex/values';
import {z} from 'zod';
import {reserve as reserveSpend} from '@praxis/spend';
import {WEB_TOOL_LIMITS as LIMITS, WebSpendAdmissionSchema, WebSpendRequestSchema, WebSpendSettlementSchema,
  type WebSpendAdmission, type WebSpendRequest, type WebSpendSettlement} from '@praxis/protocol';
import {requireServer} from './access.js';
import {activeOwner} from './accountOwner.js';
import {internalMutation, action, type DataModel, type MutationCtx} from './functions.js';
import {closePlatformSpend, loadPlatformLedger, periodFor, readEncoded, savePlatformLedger, toolStateRow as row,
  writeEncoded} from './platformLedger.js';
import {convexValidator} from './zodValidator.js';

const KIND = 'webAccounting';
const GLOBAL_OWNER = 'platform:web-tools';
const GLOBAL_ID = 'admission';
const CALL_KIND = 'webSpendCall';
// The reservation outlives the bounded HTTP request so uncertain attempts remain held for reconciliation.
const RESERVATION_TTL_MS = 300_000;
const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;
const Count = z.number().int().nonnegative();
/** Sliding hourly admission windows; the money lives in the shared platform ledger (`platformLedger.ts`). */
const UserState = z.object({searches: z.array(Count), reads: z.array(Count)});
const GlobalState = z.object({searches: z.array(Count), reads: z.array(Count), inFlight: z.record(z.string(), Count)});
const requestArgs = {serverToken: v.string(), request: convexValidator(WebSpendRequestSchema)};
const settlementArgs = {serverToken: v.string(), request: convexValidator(WebSpendSettlementSchema)};
const keyFor = (a: {runId: string; callId: string; service: string}) => JSON.stringify([a.runId, a.callId, a.service]);

async function write(ctx: MutationCtx, userId: string, id: string, value: unknown) {
  await writeEncoded(ctx, userId, KIND, id, value);
}

async function readState<T>(ctx: MutationCtx, userId: string, id: string, schema: z.ZodType<T>): Promise<T | undefined> {
  const saved = await readEncoded(ctx, userId, KIND, id);
  return saved === undefined ? undefined : schema.parse(saved);
}

/** Hourly windows carry across a month boundary, so a new period cannot reset them. */
async function admissionWindows(ctx: MutationCtx, userId: string, period: string, now: number) {
  const current = await readState(ctx, userId, period, UserState);
  if (current) return current;
  const previousPeriod = periodFor(now - LIMITS.HOUR_MS);
  if (previousPeriod === period) return {searches: [], reads: []};
  return await readState(ctx, userId, previousPeriod, UserState) ?? {searches: [], reads: []};
}

export const reserveInternal = internalMutation({
  args: requestArgs,
  handler: async (ctx, args): Promise<WebSpendAdmission> => {
    await requireServer(args.serverToken);
    const a = WebSpendRequestSchema.parse(args.request);
    const now = Date.now();
    if (!await activeOwner(ctx, a.userId)) return 'denied' as const;
    if (a.period !== periodFor(now)) return 'denied' as const;
    const ledger = await loadPlatformLedger(ctx, a.userId, a.period);
    const state = await admissionWindows(ctx, a.userId, a.period, now);
    const key = keyFor(a);
    if (await row(ctx, a.userId, CALL_KIND, key)) return 'duplicate' as const;
    const reservation = reserveSpend(ledger, {key, service: a.service, estimateMicroUsd: a.estimateMicroUsd, nowMs: now, ttlMs: RESERVATION_TTL_MS});
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
    await savePlatformLedger(ctx, a.userId, a.period, reservation.ledger);
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
    if (!await activeOwner(ctx, a.userId)) return false;
    const ledger = await loadPlatformLedger(ctx, a.userId, a.period);
    const reservation = Object.hasOwn(ledger.reservations, keyFor(a)) ? ledger.reservations[keyFor(a)] : undefined;
    if (!reservation || reservation.expiresAtMs <= now) return false;
    const global = await readState(ctx, GLOBAL_OWNER, GLOBAL_ID, GlobalState) ?? {searches: [], reads: [], inFlight: {}};
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
  const key = keyFor(a);
  const call = await row(ctx, a.userId, CALL_KIND, key);
  if (!call) throw new Error('Missing web call receipt');
  const receipt = z.object({state: z.enum(['reserved', 'closed']), period: z.string()}).parse(call.value);
  if (receipt.state === 'closed') return;
  const priced = charge ? {service: a.service, slot: charge.slot, actualMicroUsd: charge.actualMicroUsd} : undefined;
  const outcome = await closePlatformSpend(ctx, a.userId, a.period, key, priced);
  if (outcome.kind === 'unknown') throw new Error('Missing web spend reservation');
  await ctx.db.patch(call._id, {value: {period: a.period, state: 'closed'}});
  const global = await readState(ctx, GLOBAL_OWNER, GLOBAL_ID, GlobalState);
  if (global) {
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
