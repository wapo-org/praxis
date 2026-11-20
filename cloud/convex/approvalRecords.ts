import {ApprovalRecordSchema} from '@praxis/protocol';
import {ConvexError} from 'convex/values';
import type {Doc} from './_generated/dataModel.js';
import type {MutationCtx, QueryCtx} from './functions.js';

export function ownedApproval(ctx: QueryCtx, userId: string, id: string) {
  return ctx.db.query('approvals').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', id)).unique();
}

export function approvalValue({id, runId, toolCallId, tool, argsHash, preview, status, decision}: Doc<'approvals'>) {
  return ApprovalRecordSchema.parse({
    id, runId, toolCallId, tool, argsHash, preview, status, ...(decision && {decision}),
  });
}

export async function saveApproval(
  ctx: MutationCtx,
  input: {userId: string; id: string; parentId?: string; value: unknown; revision: number; updatedAt: string},
) {
  const {userId, id, parentId, revision, updatedAt} = input;
  const value = ApprovalRecordSchema.parse(input.value);
  if (id !== value.id || parentId !== value.runId) throw new ConvexError('Approval address mismatch');
  const run = await ctx.db.query('runs').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', value.runId)).unique();
  if (!run || (run.value.status !== 'running' && run.value.status !== 'awaitingApproval')) {
    throw new ConvexError('Approval run unavailable');
  }
  const previous = await ownedApproval(ctx, userId, id);
  const row = {...value, userId, revision, updatedAt};
  if (!previous && value.status === 'pending') {
    await ctx.db.insert('approvals', row);
  } else if (previous?.status === 'pending' && value.status !== 'pending' &&
      previous.runId === value.runId && previous.toolCallId === value.toolCallId &&
      previous.tool === value.tool && previous.argsHash === value.argsHash && previous.preview === value.preview) {
    await ctx.db.replace(previous._id, row);
  } else {
    throw new ConvexError('Invalid approval transition');
  }
  return {value, parentId};
}
