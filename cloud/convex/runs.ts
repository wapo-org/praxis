import {ConvexError, v} from 'convex/values';
import {vResultValidator, vWorkflowId, type WorkflowId} from '@convex-dev/workflow';
import {z} from 'zod';
import {IdSchema, RUN_START_CONFLICT_CODE, TURN_INDEX_MAX, WorkflowRunStatusSchema, type WorkflowRunStatus} from '@praxis/protocol';
import {internal} from './_generated/api.js';
import {authedMutation, authedQuery, internalMutation, internalQuery, type MutationCtx, type QueryCtx} from './functions.js';
import {workflow} from './workflows/agentRun.js';
import {ownedChat, ownedRun} from './domainRecords.js';
import {activeOwner} from './accountOwner.js';
import {runScope} from './workflows/validators.js';
import {RUN_UNPARK_EVENT, STUB_TURNS_MAX, WORKFLOW_ERRORS} from './workflows/constants.js';
import {convexValidator} from './zodValidator.js';
import type {Doc, Id} from './_generated/dataModel.js';

const startIndex = z.number().int().nonnegative().max(TURN_INDEX_MAX - STUB_TURNS_MAX);
const turnIndexSchema = z.number().int().nonnegative().max(TURN_INDEX_MAX);
const startInput = z.object({
  chatId: IdSchema,
  idempotencyKey: IdSchema.optional(),
  startTurnIndex: startIndex.default(0),
});
type RunScope = {userId: string; chatId: string; runId: Id<'runs'>; generation: number};
type ScopedRun = Doc<'runs'> & {workflow: NonNullable<Doc<'runs'>['workflow']>};

const transitions: Record<WorkflowRunStatus, readonly WorkflowRunStatus[]> = {
  queued: ['running', 'failed'],
  running: ['paused', 'cancelling', 'completed', 'failed'],
  paused: ['running', 'cancelling', 'failed'],
  cancelling: ['cancelled', 'failed'],
  completed: [],
  cancelled: [],
  failed: [],
};
const activeStatuses = WorkflowRunStatusSchema.options.filter(status => transitions[status].length > 0);

async function scopedRun(ctx: QueryCtx, args: RunScope): Promise<ScopedRun | null> {
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

async function activeRun(ctx: QueryCtx, userId: string, chatId: string): Promise<ScopedRun | null> {
  const runs = await Promise.all(activeStatuses.map(status => ctx.db.query('runs')
    .withIndex('by_user_chat_status', q => q.eq('userId', userId).eq('chatId', chatId).eq('value.status', status))
    .filter(q => q.neq(q.field('workflow.generation'), undefined)).first()));
  const run = runs.find(row => row?.workflow);
  return run?.workflow ? {...run, workflow: run.workflow} : null;
}

async function applyTransition(
  ctx: MutationCtx, run: ScopedRun, from: WorkflowRunStatus, to: WorkflowRunStatus, turnIndex: number,
): Promise<boolean> {
  if (run.value.status !== from || run.workflow.nextTurnIndex !== turnIndex || !transitions[from].includes(to)) {
    return false;
  }
  const updatedAt = new Date().toISOString();
  await ctx.db.patch(run._id, {updatedAt, value: {...run.value, status: to, updatedAt}});
  return true;
}

async function wakeParkedRun(ctx: MutationCtx, run: ScopedRun) {
  if ((run.value.status === 'paused' || run.value.status === 'queued') && run.workflow.id) {
    await workflow.sendEvent(ctx, {workflowId: run.workflow.id as WorkflowId, name: RUN_UNPARK_EVENT});
  }
}

async function requestCancellation(ctx: MutationCtx, run: ScopedRun) {
  const from = WorkflowRunStatusSchema.parse(run.value.status);
  if (await applyTransition(ctx, run, from, 'cancelling', run.workflow.nextTurnIndex)) {
    await wakeParkedRun(ctx, run);
  }
}

export async function cancelChatRun(ctx: MutationCtx, userId: string, chatId: string) {
  const run = await activeRun(ctx, userId, chatId);
  if (run) await requestCancellation(ctx, run);
}

export const transition = internalMutation({
  args: {...runScope, from: convexValidator(WorkflowRunStatusSchema), to: convexValidator(WorkflowRunStatusSchema), turnIndex: v.number()},
  handler: async (ctx, args): Promise<{applied: boolean}> => {
    const from = WorkflowRunStatusSchema.parse(args.from);
    const to = WorkflowRunStatusSchema.parse(args.to);
    const turnIndex = turnIndexSchema.parse(args.turnIndex);
    const run = await liveScopedRun(ctx, args);
    if (!run || !await applyTransition(ctx, run, from, to, turnIndex)) return {applied: false};
    await wakeParkedRun(ctx, run);
    return {applied: true};
  },
});

export const get = authedQuery({
  args: {runId: v.string()},
  handler: async (ctx, {userId, runId}) => {
    const run = await ownedRun(ctx, userId, IdSchema.parse(runId));
    if (!run) return null;
    const chat = await ownedChat(ctx, userId, run.chatId);
    return chat && !chat.value.deletedAt ? run.value : null;
  },
});

async function createRun(ctx: MutationCtx, userId: string, chatId: string, startTurnIndex: number): Promise<Id<'runs'>> {
  const updatedAt = new Date().toISOString();
  const value = {
    type: 'run' as const, id: '', chatId, status: 'running' as const, createdAt: updatedAt, updatedAt, lastEventId: 0,
  };
  const state = {startTurnIndex, nextTurnIndex: startTurnIndex, generation: 0};
  const runId = await ctx.db.insert('runs', {userId, id: '', chatId, updatedAt, revision: 0, value, workflow: state});
  const scope = {userId, chatId, runId, generation: state.generation};
  const workflowId = await workflow.start(ctx, internal.workflows.agentRun.agentRun, {...scope, startTurnIndex}, {
    onComplete: internal.runs.onComplete, context: scope,
  });
  await ctx.db.patch(runId, {id: runId, value: {...value, id: runId}, workflow: {...state, id: workflowId}});
  return runId;
}

export const start = authedMutation({
  args: {chatId: v.string(), startTurnIndex: v.optional(v.number()), idempotencyKey: v.optional(v.string())},
  handler: async (ctx, {userId, ...args}): Promise<Id<'runs'>> => {
    const {chatId, startTurnIndex, idempotencyKey: key} = startInput.parse(args);
    const chat = await ownedChat(ctx, userId, chatId);
    if (!chat || chat.value.deletedAt) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
    if (key !== undefined) {
      const prior = await ctx.db.query('runStarts').withIndex('by_user_chat_key', q =>
        q.eq('userId', userId).eq('chatId', chatId).eq('key', key)).unique();
      if (prior) {
        if (prior.startTurnIndex !== startTurnIndex) {
          throw new ConvexError({code: RUN_START_CONFLICT_CODE, status: 409, message: 'This turn ID was used with different content'});
        }
        return prior.runId;
      }
    }
    const active = await activeRun(ctx, userId, chatId);
    const runId = active?._id ?? await createRun(ctx, userId, chatId, startTurnIndex);
    if (key !== undefined) await ctx.db.insert('runStarts', {userId, chatId, key, startTurnIndex, runId});
    return runId;
  },
});

export const cancel = authedMutation({
  args: {runId: v.id('runs')},
  handler: async (ctx, {userId, runId}) => {
    const run = await ownedRun(ctx, userId, runId);
    if (!run?.workflow) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
    await requestCancellation(ctx, {...run, workflow: run.workflow});
  },
});

export const status = internalQuery({
  args: runScope,
  handler: async (ctx, args): Promise<WorkflowRunStatus | null> => {
    const run = await liveScopedRun(ctx, args);
    return run ? WorkflowRunStatusSchema.parse(run.value.status) : null;
  },
});

export const onComplete = internalMutation({
  args: {workflowId: vWorkflowId, result: vResultValidator, context: v.object(runScope)},
  handler: async (ctx, {workflowId, result, context}) => {
    const run = await scopedRun(ctx, context);
    if (!run || run.workflow.id !== workflowId) return;
    const from = WorkflowRunStatusSchema.parse(run.value.status);
    if (transitions[from].length === 0) return;
    const turnIndex = run.workflow.nextTurnIndex;
    if (from === 'cancelling') {
      await applyTransition(ctx, run, from, 'cancelled', turnIndex);
      return;
    }
    const cancelled = result.kind === 'canceled' || (result.kind === 'success' && result.returnValue === 'cancelled');
    if (cancelled && await applyTransition(ctx, run, from, 'cancelling', turnIndex)) {
      await applyTransition(ctx, {...run, value: {...run.value, status: 'cancelling'}}, 'cancelling', 'cancelled', turnIndex);
      return;
    }
    // Successful work finalizes inside the workflow while it still owns the turn.
    await applyTransition(ctx, run, from, 'failed', turnIndex);
  },
});
