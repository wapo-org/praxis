import {ConvexError} from 'convex/values';
import {TurnResultSchema, type TurnResult} from '@praxis/protocol';
import type {Doc, Id} from '../_generated/dataModel.js';
import type {QueryCtx} from '../functions.js';
import {liveScopedRun} from '../runs.js';
import {WORKFLOW_ERRORS} from './constants.js';

export type TurnScope = {
  userId: string;
  chatId: string;
  runId: Id<'runs'>;
  generation: number;
  expectedTurnIndex: number;
};
/** `settled` flags are final for this index; `open` means the worker still has to run it. */
export type TurnState =
  | {state: 'settled'; flags: TurnResult}
  | {state: 'open'; runTainted: boolean};

export function turnReceipt(ctx: QueryCtx, scope: TurnScope) {
  return ctx.db.query('turns').withIndex('by_user_run_turn', q => q
    .eq('userId', scope.userId)
    .eq('runId', scope.runId)
    .eq('generation', scope.generation)
    .eq('turnIndex', scope.expectedTurnIndex)).unique();
}

export function receiptFlags(receipt: Doc<'turns'>): TurnResult {
  return TurnResultSchema.parse({
    done: receipt.done, status: receipt.status, subagents: [], turnIndex: receipt.turnIndex,
  });
}

/** Reads the receipt before the cursor, so a lost response after commit returns the saved flags. */
export async function turnState(ctx: QueryCtx, scope: TurnScope): Promise<TurnState> {
  const run = await liveScopedRun(ctx, scope);
  if (!run) throw new ConvexError(WORKFLOW_ERRORS.unavailable);
  const receipt = await turnReceipt(ctx, scope);
  if (receipt) return {state: 'settled', flags: receiptFlags(receipt)};
  const turnIndex = scope.expectedTurnIndex;
  const status = run.value.status;
  if (status === 'paused' || status === 'queued') {
    return {state: 'settled', flags: {done: false, status: 'busy', subagents: [], turnIndex}};
  }
  if (status !== 'running') {
    return {state: 'settled', flags: {done: true, status: 'stopped', subagents: [], turnIndex}};
  }
  if (turnIndex !== run.workflow.nextTurnIndex) throw new ConvexError(WORKFLOW_ERRORS.index);
  return {state: 'open', runTainted: run.value.taint !== undefined};
}
