import {internalActionGeneric} from 'convex/server';
import {ConvexError, v} from 'convex/values';
import {TurnCommitSchema, type TurnCommitResult, type TurnResult} from '@praxis/protocol';
import {internal} from './_generated/api.js';
import {internalQuery, serverMutation, serverQuery, type ActionCtx} from './functions.js';
import {ownerRunScope, runScope} from './workflows/validators.js';
import {WORKFLOW_ERRORS} from './workflows/constants.js';
import {turnState, type TurnScope, type TurnState} from './workflows/turnState.js';
import {commitTurn} from './workflows/turnCommit.js';
import {dispatchTurn} from './workflows/turnDispatch.js';

const turnIndex = {expectedTurnIndex: v.number()};
const args = {...runScope, ...turnIndex};

export const preflight = internalQuery({
  args,
  handler: async (ctx, input): Promise<TurnState> => turnState(ctx, input),
});

/** Worker pre-check: saved flags, or the run taint that seeds the turn snapshot. */
export const state = serverQuery({
  args: {...ownerRunScope, ...turnIndex},
  handler: async (ctx, input): Promise<TurnState> => turnState(ctx, input),
});

/** The worker's only write path: messages, usage, taint, receipt and cursor in one fenced transaction. */
export const commit = serverMutation({
  args: {commitJson: v.string()},
  handler: async (ctx, {userId, commitJson}): Promise<TurnCommitResult> => {
    const turn = TurnCommitSchema.parse(JSON.parse(commitJson));
    if (turn.userId !== userId) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
    return commitTurn(ctx, turn);
  },
});

async function settledAfterConflict(ctx: ActionCtx, input: TurnScope): Promise<TurnResult> {
  const after = await ctx.runQuery(internal.turns.preflight, input);
  if (after.state === 'settled') return after.flags;
  throw new Error(WORKFLOW_ERRORS.conflict);
}

/** A rejected signature is a deployment fault no retry can fix, so the run fails instead of looping. */
async function failUnauthorizedRun(ctx: ActionCtx, input: TurnScope): Promise<TurnResult> {
  console.error('Turn worker rejected the signed turn request (HTTP 401); failing the run');
  const {expectedTurnIndex: turnIndex, ...scope} = input;
  await ctx.runMutation(internal.runs.transition, {...scope, from: 'running', to: 'failed', turnIndex});
  return {done: true, status: 'stopped', subagents: [], turnIndex};
}

export const run = internalActionGeneric({
  args,
  handler: async (ctx, input): Promise<TurnResult> => {
    const before = await ctx.runQuery(internal.turns.preflight, input);
    if (before.state === 'settled') return before.flags;
    const reply = await dispatchTurn(input);
    switch (reply.kind) {
      case 'flags': return reply.flags;
      case 'conflict': return settledAfterConflict(ctx, input);
      case 'unauthorized': return failUnauthorizedRun(ctx, input);
    }
  },
});
