import {ConvexError, v} from 'convex/values';
import {vResultValidator, vWorkflowId} from '@convex-dev/workflow';
import {z} from 'zod';
import {IdSchema, TURN_INDEX_MAX} from '@praxis/protocol';
import {internal} from './_generated/api.js';
import {authedMutation, authenticatedOwner, internalMutation, internalQuery, query, type QueryCtx} from './functions.js';
import {workflow} from './workflows/agentRun.js';
import {ownedChat, ownedRun} from './domainRecords.js';
import {activeOwner} from './accountOwner.js';
import {runScope} from './workflows/validators.js';
import {STUB_TURNS_MAX, WORKFLOW_ERRORS} from './workflows/constants.js';
import type {Id} from './_generated/dataModel.js';

const indexSchema = z.number().int().nonnegative().max(TURN_INDEX_MAX - STUB_TURNS_MAX);
type RunScope = {userId: string; chatId: string; runId: Id<'runs'>; generation: number};

async function scopedRun(ctx: QueryCtx, args: RunScope) {
  if (!await activeOwner(ctx, args.userId)) return null;
  const run = await ownedRun(ctx, args.userId, args.runId);
  if (!run?.workflow || run.chatId !== args.chatId || run.workflow.generation !== args.generation) return null;
  return {...run, workflow: run.workflow};
}

export async function liveScopedRun(ctx: QueryCtx, args: RunScope) {
  const run = await scopedRun(ctx, args);
  if (!run) return null;
  const chat = await ownedChat(ctx, args.userId, args.chatId);
  return chat && !chat.value.deletedAt ? run : null;
}

export const get = query({
  args: {runId: v.string()},
  handler: async (ctx, {runId}) => {
    const userId = await authenticatedOwner(ctx);
    const run = await ownedRun(ctx, userId, IdSchema.parse(runId));
    if (!run) return null;
    const chat = await ownedChat(ctx, userId, run.chatId);
    return chat && !chat.value.deletedAt ? run.value : null;
  },
});

export const start = authedMutation({
  args: {chatId: v.string(), startTurnIndex: v.optional(v.number())},
  handler: async (ctx, userId, args): Promise<Id<'runs'>> => {
    const chatId = IdSchema.parse(args.chatId);
    const startTurnIndex = indexSchema.parse(args.startTurnIndex ?? 0);
    const chat = await ownedChat(ctx, userId, chatId);
    if (!chat || chat.value.deletedAt) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
    const updatedAt = new Date().toISOString();
    const value = {type: 'run' as const, id: '', chatId, status: 'running' as const,
      createdAt: updatedAt, updatedAt, lastEventId: 0};
    const state = {startTurnIndex, nextTurnIndex: startTurnIndex, generation: 0, status: 'running' as const};
    const runId = await ctx.db.insert('runs', {userId, id: '', chatId, updatedAt, revision: 0, value, workflow: state});
    const scope = {userId, chatId, runId, generation: 0};
    const workflowId = await workflow.start(ctx, internal.workflows.agentRun.agentRun, {...scope, startTurnIndex}, {
      onComplete: internal.runs.onComplete, context: scope,
    });
    await ctx.db.patch(runId, {id: runId, value: {...value, id: runId}, workflow: {...state, id: workflowId}});
    return runId;
  },
});

export const cancel = authedMutation({
  args: {runId: v.id('runs')},
  handler: async (ctx, userId, {runId}) => {
    const run = await ownedRun(ctx, userId, runId);
    if (!run?.workflow) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
    if (run.workflow.status === 'running') {
      await ctx.db.patch(run._id, {workflow: {...run.workflow, status: 'cancelling'}});
    }
  },
});

export const status = internalQuery({
  args: runScope,
  handler: async (ctx, args) => (await liveScopedRun(ctx, args))?.workflow.status ?? null,
});

export const onComplete = internalMutation({
  args: {workflowId: vWorkflowId, result: vResultValidator, context: v.object(runScope)},
  handler: async (ctx, {workflowId, result, context}) => {
    const run = await scopedRun(ctx, context);
    if (!run || run.workflow.id !== workflowId || !['running', 'cancelling'].includes(run.workflow.status)) return;
    const chat = await ownedChat(ctx, context.userId, context.chatId);
    const cancelled = !chat || !!chat.value.deletedAt || run.workflow.status === 'cancelling' || result.kind === 'canceled';
    const status = cancelled ? 'cancelled'
      : result.kind === 'success' ? completionStatus(result.returnValue) : 'failed';
    const updatedAt = new Date().toISOString();
    await ctx.db.patch(run._id, {updatedAt, value: {...run.value, status, updatedAt},
      workflow: {...run.workflow, status}});
  },
});

function completionStatus(value: unknown): 'completed' | 'cancelled' | 'failed' {
  return value === 'completed' || value === 'cancelled' || value === 'failed' ? value : 'failed';
}
