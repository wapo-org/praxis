import {internalActionGeneric} from 'convex/server';
import {ConvexError, v} from 'convex/values';
import {TurnCommitSchema, TurnFailureSchema, type TurnCommitResult, type TurnResult} from '@praxis/protocol';
import {internal} from './_generated/api.js';
import {internalMutation, internalQuery, serverMutation, serverQuery} from './functions.js';
import {ownerRunScope, runScope} from './workflows/validators.js';
import {WORKFLOW_ERRORS} from './workflows/constants.js';
import {turnState, type TurnState} from './workflows/turnState.js';
import {commitTurn, failTurn} from './workflows/turnCommit.js';
import {runConvexTurn} from './agent/turn.js';

const turnIndex = {expectedTurnIndex: v.number()};
const args = {...runScope, ...turnIndex};

export const preflight = internalQuery({
  args,
  handler: async (ctx, input): Promise<TurnState> => turnState(ctx, input),
});

/** Legacy worker pre-check, kept until the dead /api/turn worker is removed (PRA-172). */
export const state = serverQuery({
  args: {...ownerRunScope, ...turnIndex},
  handler: async (ctx, input): Promise<TurnState> => turnState(ctx, input),
});

/** Legacy worker write path, kept until the dead /api/turn worker is removed (PRA-172). */
export const commit = serverMutation({
  args: {commitJson: v.string()},
  handler: async (ctx, {userId, commitJson}): Promise<TurnCommitResult> => {
    const turn = TurnCommitSchema.parse(JSON.parse(commitJson));
    if (turn.userId !== userId) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
    return commitTurn(ctx, turn);
  },
});

/** The harness's only write path: messages, usage, taint, receipt and cursor in one fenced transaction. */
export const commitInternal = internalMutation({
  args: {commitJson: v.string()},
  handler: async (ctx, {commitJson}): Promise<TurnCommitResult> => commitTurn(ctx, TurnCommitSchema.parse(JSON.parse(commitJson))),
});

/** A revoked key, spent credit or no key: the run fails under the fence with the reason the client shows. */
export const fail = internalMutation({
  args: {...args, failureJson: v.string()},
  handler: async (ctx, {failureJson, ...scope}): Promise<TurnResult> => failTurn(ctx, scope, TurnFailureSchema.parse(JSON.parse(failureJson))),
});

export const run = internalActionGeneric({
  args,
  handler: async (ctx, input): Promise<TurnResult> => {
    const before = await ctx.runQuery(internal.turns.preflight, input);
    if (before.state === 'settled') return before.flags;
    return runConvexTurn(ctx, input, before.runTainted);
  },
});
