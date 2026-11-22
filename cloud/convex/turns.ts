import {internalActionGeneric} from 'convex/server';
import {v} from 'convex/values';
import {TurnCommitSchema, TurnFailureSchema, type TurnCommitResult, type TurnResult} from '@praxis/protocol';
import {internal} from './_generated/api.js';
import {assertActiveOwner, internalMutation, internalQuery} from './functions.js';
import {runScope} from './workflows/validators.js';
import {turnState, type TurnState} from './workflows/turnState.js';
import {commitTurn, failTurn} from './workflows/turnCommit.js';
import {runConvexTurn} from './agent/turn.js';

const turnIndex = {expectedTurnIndex: v.number()};
const args = {...runScope, ...turnIndex};

export const preflight = internalQuery({
  args,
  handler: async (ctx, input): Promise<TurnState> => turnState(ctx, input),
});

/** The harness's only write path: messages, usage, taint, receipt and cursor in one fenced transaction. */
export const commitInternal = internalMutation({
  args: {commitJson: v.string()},
  handler: async (ctx, {commitJson}): Promise<TurnCommitResult> => {
    const turn = TurnCommitSchema.parse(JSON.parse(commitJson));
    // A turn still running when account deletion begins must not write rows the purge has already drained.
    await assertActiveOwner(ctx, turn.userId);
    return commitTurn(ctx, turn);
  },
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
