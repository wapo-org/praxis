import {ConvexError, v} from 'convex/values';
import {z} from 'zod';
import {ToolInvocationSchema} from '@praxis/protocol';
import {SavedResponseSchema, type CallClaim, type SavedCall, type SavedResponse, type TurnLedger} from '@praxis/agent/harness';
import {internal} from '../_generated/api.js';
import {internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx} from '../functions.js';
import {liveScopedRun} from '../runs.js';
import {runScope} from '../workflows/validators.js';
import type {TurnScope} from '../workflows/turnState.js';
import {AGENT_ERRORS, LEDGER_KIND, LEDGER_VALUE_BYTES_MAX} from './constants.js';

const turnArgs = {...runScope, expectedTurnIndex: v.number()};
const Started = z.object({started: z.literal(true)});
const Saved = z.object({call: ToolInvocationSchema, result: z.record(z.string(), z.unknown())});

/** Rows of one turn share this prefix, so the commit can clear them in one range scan. */
export function ledgerPrefix(scope: TurnScope): string {
  return `${scope.runId}/${scope.generation}/${scope.expectedTurnIndex}/`;
}

const responseId = (scope: TurnScope) => `${ledgerPrefix(scope)}response`;
const callId = (scope: TurnScope, id: string) => `${ledgerPrefix(scope)}call/${id}`;

function row(ctx: QueryCtx, userId: string, id: string) {
  return ctx.db.query('toolState').withIndex('owner_kind_id', q => q.eq('userId', userId).eq('kind', LEDGER_KIND).eq('id', id)).unique();
}

function decoded(value: {encoded?: string} | object): unknown {
  return 'encoded' in value && typeof value.encoded === 'string' ? JSON.parse(value.encoded) : undefined;
}

function encoded(value: unknown): {encoded: string} {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).byteLength > LEDGER_VALUE_BYTES_MAX) throw new ConvexError(AGENT_ERRORS.ledger);
  return {encoded: text};
}

/** The run still holds this turn: running, same generation, and the cursor still at this index. */
export async function turnIsLive(ctx: QueryCtx, scope: TurnScope): Promise<boolean> {
  const run = await liveScopedRun(ctx, scope);
  return run?.value.status === 'running' && run.workflow.nextTurnIndex === scope.expectedTurnIndex;
}

async function requireLiveTurn(ctx: MutationCtx, scope: TurnScope) {
  if (!await turnIsLive(ctx, scope)) throw new ConvexError(AGENT_ERRORS.fenced);
}

/** Deletes one turn's rows; the commit calls it in its own transaction. */
export async function clearLedger(ctx: MutationCtx, scope: TurnScope): Promise<void> {
  const prefix = ledgerPrefix(scope);
  const rows = await ctx.db.query('toolState').withIndex('owner_kind_id', q => q
    .eq('userId', scope.userId).eq('kind', LEDGER_KIND).gte('id', prefix).lt('id', `${prefix}￿`)).collect();
  for (const stale of rows) await ctx.db.delete(stale._id);
}

export const live = internalQuery({
  args: turnArgs,
  handler: async (ctx, scope): Promise<boolean> => turnIsLive(ctx, scope),
});

export const response = internalQuery({
  args: turnArgs,
  handler: async (ctx, scope): Promise<string | null> => {
    const saved = await row(ctx, scope.userId, responseId(scope));
    return saved ? JSON.stringify(decoded(saved.value)) : null;
  },
});

export const saveResponse = internalMutation({
  args: {...turnArgs, responseJson: v.string()},
  handler: async (ctx, {responseJson, ...scope}) => {
    await requireLiveTurn(ctx, scope);
    if (await row(ctx, scope.userId, responseId(scope))) return;
    const value = SavedResponseSchema.parse(JSON.parse(responseJson));
    await ctx.db.insert('toolState', {userId: scope.userId, kind: LEDGER_KIND, id: responseId(scope), value: encoded(value)});
  },
});

/** Atomic claim: a call is marked started before its effect, so a lost reply can never be replayed blindly. */
export const startCall = internalMutation({
  args: {...turnArgs, callId: v.string(), callJson: v.string()},
  handler: async (ctx, {callId: id, callJson, ...scope}): Promise<string> => {
    await requireLiveTurn(ctx, scope);
    const existing = await row(ctx, scope.userId, callId(scope, id));
    if (existing) {
      const value = decoded(existing.value);
      return JSON.stringify(Started.safeParse(value).success ? {state: 'uncertain'} : {state: 'saved', value: Saved.parse(value)});
    }
    ToolInvocationSchema.parse(JSON.parse(callJson));
    await ctx.db.insert('toolState', {userId: scope.userId, kind: LEDGER_KIND, id: callId(scope, id), value: encoded({started: true})});
    return JSON.stringify({state: 'new'});
  },
});

export const saveCall = internalMutation({
  args: {...turnArgs, callId: v.string(), savedJson: v.string()},
  handler: async (ctx, {callId: id, savedJson, ...scope}) => {
    await requireLiveTurn(ctx, scope);
    const existing = await row(ctx, scope.userId, callId(scope, id));
    if (!existing || !Started.safeParse(decoded(existing.value)).success) throw new ConvexError(AGENT_ERRORS.fenced);
    await ctx.db.patch(existing._id, {value: encoded(Saved.parse(JSON.parse(savedJson)))});
  },
});

/** The harness's ledger port over Convex rows; values cross the action boundary as JSON strings. */
export function convexLedger(ctx: ActionCtx, scope: TurnScope): TurnLedger {
  return {
    async response(): Promise<SavedResponse | undefined> {
      const text = await ctx.runQuery(internal.agent.ledger.response, scope);
      return text === null ? undefined : SavedResponseSchema.parse(JSON.parse(text));
    },
    async saveResponse(saved) {
      await ctx.runMutation(internal.agent.ledger.saveResponse, {...scope, responseJson: JSON.stringify(saved)});
    },
    async startCall(id, call): Promise<CallClaim> {
      const text = await ctx.runMutation(internal.agent.ledger.startCall, {...scope, callId: id, callJson: JSON.stringify(call)});
      return JSON.parse(text) as CallClaim;
    },
    async saveCall(id, saved: SavedCall) {
      await ctx.runMutation(internal.agent.ledger.saveCall, {...scope, callId: id, savedJson: JSON.stringify(saved)});
    },
    active() {
      return ctx.runQuery(internal.agent.ledger.live, scope);
    },
  };
}
