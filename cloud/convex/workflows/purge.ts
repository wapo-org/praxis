import type {WorkflowId} from '@convex-dev/workflow';
import type {MutationCtx} from '../functions.js';
import {ACCOUNT_PURGE_BATCH_MAX, ACCOUNT_RUN_CHILD_ROWS} from '../accountTables.js';
import {workflow} from './agentRun.js';

/** Erases one owned run per call (workflow, journal, child rows, row); returns false once none remain. */
export async function purgeOwnedRun(ctx: MutationCtx, userId: string): Promise<boolean> {
  const run = await ctx.db.query('runs').withIndex('by_user_chat', q => q.eq('userId', userId)).first();
  if (!run) {
    const turns = await ctx.db.query('turns')
      .withIndex('by_user_run_turn', q => q.eq('userId', userId)).take(ACCOUNT_PURGE_BATCH_MAX);
    for (const turn of turns) await ctx.db.delete(turn._id);
    return turns.length > 0;
  }
  if (run.workflow?.id) {
    const workflowId = run.workflow.id as WorkflowId;
    const status = await workflow.status(ctx, workflowId);
    if (status.type === 'inProgress') await workflow.cancel(ctx, workflowId);
    await workflow.cleanup(ctx, workflowId);
    // Persist cleanup progress before batching child rows so retries never address a deleted workflow.
    await ctx.db.patch(run._id, {workflow: {...run.workflow, id: undefined}});
  }
  for (const rowsOf of Object.values(ACCOUNT_RUN_CHILD_ROWS)) {
    const rows = await rowsOf(ctx, {userId, runId: run._id}, ACCOUNT_PURGE_BATCH_MAX);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === ACCOUNT_PURGE_BATCH_MAX) return true;
  }
  await ctx.db.delete(run._id);
  return true;
}
