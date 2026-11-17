import type {WorkflowId} from '@convex-dev/workflow';
import type {MutationCtx} from '../functions.js';
import {ACCOUNT_OWNER_QUERIES, ACCOUNT_PURGE_BATCH_MAX, ACCOUNT_RUN_CHILD_QUERIES} from '../accountTables.js';
import {workflow} from './agentRun.js';

export async function purgeOwnedRun(ctx: MutationCtx, userId: string): Promise<boolean> {
  const run = await ACCOUNT_OWNER_QUERIES.runs(ctx, userId).first();
  if (!run) return false;
  if (run.workflowId) {
    const workflowId = run.workflowId as WorkflowId;
    const status = await workflow.status(ctx, workflowId);
    if (status.type === 'inProgress') await workflow.cancel(ctx, workflowId);
    await workflow.cleanup(ctx, workflowId);
    // Persist cleanup progress before batching child rows so retries never address a deleted workflow.
    await ctx.db.patch(run._id, {workflowId: undefined, status: 'cancelled'});
  }
  for (const query of Object.values(ACCOUNT_RUN_CHILD_QUERIES)) {
    const rows = await query(ctx, run._id).take(ACCOUNT_PURGE_BATCH_MAX);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === ACCOUNT_PURGE_BATCH_MAX) return true;
  }
  await ctx.db.delete(run._id);
  return true;
}
