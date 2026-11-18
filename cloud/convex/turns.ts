import {internalActionGeneric} from 'convex/server';
import {ConvexError, v} from 'convex/values';
import {TurnRequestSchema, TurnResultSchema, type TurnResult} from '@praxis/protocol';
import {internal} from './_generated/api.js';
import {internalMutation} from './functions.js';
import {scopedRun} from './runs.js';
import {runScope} from './workflows/validators.js';
import {STUB_TURNS_MAX, WORKFLOW_ERRORS} from './workflows/constants.js';

const args = {...runScope, expectedTurnIndex: v.number()};
export const run = internalActionGeneric({
  args,
  handler: async (ctx, input): Promise<TurnResult> => {
    TurnRequestSchema.parse({userId: input.userId, chatId: input.chatId, runId: input.runId,
      expectedTurnIndex: input.expectedTurnIndex});
    return TurnResultSchema.parse(await ctx.runMutation(internal.turns.commitStub, input));
  },
});

export const commitStub = internalMutation({
  args,
  handler: async (ctx, input): Promise<TurnResult> => {
    const run = await scopedRun(ctx, input);
    if (!run) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
    const saved = await ctx.db.query('turns').withIndex('by_user_run_turn', q =>
      q.eq('userId', input.userId).eq('runId', input.runId).eq('generation', input.generation).eq('turnIndex', input.expectedTurnIndex)).unique();
    if (saved) return TurnResultSchema.parse({done: saved.done, status: saved.status, subagents: [], turnIndex: saved.turnIndex});
    if (input.expectedTurnIndex !== run.workflow.nextTurnIndex) throw new ConvexError(WORKFLOW_ERRORS.index);
    if (run.workflow.status !== 'running') {
      return {done: true, status: 'stopped', subagents: [], turnIndex: input.expectedTurnIndex};
    }
    const done = run.workflow.nextTurnIndex - run.workflow.startTurnIndex + 1 >= STUB_TURNS_MAX;
    const flags = TurnResultSchema.parse({done, status: done ? 'completed' : 'ready', subagents: [], turnIndex: run.workflow.nextTurnIndex});
    await ctx.db.insert('turns', {userId: input.userId, runId: run._id, generation: run.workflow.generation,
      turnIndex: flags.turnIndex, done: flags.done, status: done ? 'completed' : 'ready'});
    await ctx.db.patch(run._id, {workflow: {...run.workflow, nextTurnIndex: run.workflow.nextTurnIndex + 1}});
    return flags;
  },
});
