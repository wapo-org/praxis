import {mutation} from './_generated/server.js';
import {ConvexError, v} from 'convex/values';
import {vResultValidator, vWorkflowId} from '@convex-dev/workflow';
import {z} from 'zod';
import {IdSchema, TURN_INDEX_MAX} from '@praxis/protocol';
import {internal} from './_generated/api.js';
import {internalMutation, internalQuery, type QueryCtx} from './functions.js';
import {workflow} from './workflows/agentRun.js';
import {runScope} from './workflows/validators.js';
import {STUB_TURNS_MAX, WORKFLOW_ERRORS} from './workflows/constants.js';
import type {Id} from './_generated/dataModel.js';

const indexSchema = z.number().int().nonnegative().max(TURN_INDEX_MAX - STUB_TURNS_MAX);
export async function scopedRun(ctx: QueryCtx, args: {userId: string; chatId: string; runId: Id<'runs'>; generation: number}) {
  const run = await ctx.db.get(args.runId);
  return run && run.userId === args.userId && run.chatId === args.chatId && run.generation === args.generation ? run : null;
}

export const start = mutation({
  args: {chatId: v.string(), startTurnIndex: v.optional(v.number())},
  handler: async (ctx, args): Promise<Id<'runs'>> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError(WORKFLOW_ERRORS.unauthenticated);
    const userId = identity.subject;
    const chatId = IdSchema.parse(args.chatId);
    const startTurnIndex = indexSchema.parse(args.startTurnIndex ?? 0);
    const chat = await ctx.db.query('records').withIndex('owner_kind_id', q =>
      q.eq('userId', userId).eq('kind', 'chat').eq('id', chatId)).unique();
    if (!chat || chat.deleted) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
    const runId = await ctx.db.insert('runs', {
      userId, chatId, startTurnIndex, nextTurnIndex: startTurnIndex, generation: 0, status: 'running',
    });
    const scope = {userId, chatId, runId, generation: 0};
    const workflowId = await workflow.start(ctx, internal.workflows.agentRun.agentRun, {...scope, startTurnIndex}, {
      onComplete: internal.runs.onComplete, context: scope,
    });
    await ctx.db.patch(runId, {workflowId});
    return runId;
  },
});

export const cancel = mutation({
  args: {runId: v.id('runs')},
  handler: async (ctx, {runId}) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError(WORKFLOW_ERRORS.unauthenticated);
    const run = await ctx.db.get(runId);
    if (!run || run.userId !== identity.subject) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
    if (run.status === 'running') await ctx.db.patch(runId, {status: 'cancelling'});
  },
});

export const status = internalQuery({
  args: runScope,
  handler: async (ctx, args) => (await scopedRun(ctx, args))?.status ?? null,
});

export const onComplete = internalMutation({
  args: {workflowId: vWorkflowId, result: vResultValidator, context: v.object(runScope)},
  handler: async (ctx, {workflowId, result, context}) => {
    const run = await scopedRun(ctx, context);
    if (!run || run.workflowId !== workflowId || !['running', 'cancelling'].includes(run.status)) return;
    const status = run.status === 'cancelling' || result.kind === 'canceled' ? 'cancelled'
      : result.kind === 'success' ? completionStatus(result.returnValue) : 'failed';
    await ctx.db.patch(run._id, {status});
  },
});

function completionStatus(value: unknown): 'completed' | 'cancelled' | 'failed' {
  return value === 'completed' || value === 'cancelled' || value === 'failed' ? value : 'failed';
}
