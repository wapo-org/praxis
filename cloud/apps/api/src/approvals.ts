import {
  APPROVAL_RECORD_KIND, ApprovalRecordSchema, PendingApprovalRecordSchema,
  type ApprovalBinding, type ApprovalDecision, type ApprovalRecord, type PendingApprovalRecord,
} from '@praxis/protocol';
import type {Store} from './contracts.js';
import {ApiError} from './service.js';

function matchesBinding(row: ApprovalBinding, binding: ApprovalBinding): boolean {
  return row.runId === binding.runId && row.toolCallId === binding.toolCallId &&
    row.tool === binding.tool && row.argsHash === binding.argsHash;
}

async function readApproval(store: Store, userId: string, id: string) {
  const row = await store.get(userId, APPROVAL_RECORD_KIND, id);
  if (!row || row.deleted) return null;
  const approval = ApprovalRecordSchema.parse(row.value);
  return approval.id === id ? {approval, revision: row.revision} : null;
}

export async function recordPendingApproval(store: Store, userId: string, value: PendingApprovalRecord): Promise<void> {
  const pending = PendingApprovalRecordSchema.parse(value);
  const row = await store.putIfRevision(userId, APPROVAL_RECORD_KIND, pending.id,
    {...pending, status: 'pending'}, 0, {parentId: pending.runId});
  if (row) return;
  const previous = (await readApproval(store, userId, pending.id))?.approval;
  if (previous?.status !== 'pending' || !matchesBinding(previous, pending) || previous.preview !== pending.preview) {
    throw new Error('Could not create pending approval');
  }
}

export async function readApprovalDecision(
  store: Store, userId: string, binding: ApprovalBinding, approvalId: string,
): Promise<ApprovalDecision['decision'] | null> {
  const row = await readApproval(store, userId, approvalId);
  if (!row || row.approval.status === 'pending' || !matchesBinding(row.approval, binding)) return null;
  return row.approval.decision;
}

export async function resolvedApproval(
  store: Store, userId: string, runId: string, approvalId: string,
): Promise<ApprovalDecision | null> {
  const row = await readApproval(store, userId, approvalId);
  if (!row || row.approval.status === 'pending' || row.approval.runId !== runId) return null;
  return {type: 'approval.decision', approvalId, decision: row.approval.decision};
}

export async function decideApproval(
  store: Store, userId: string, runId: string, reply: ApprovalDecision, pending: boolean,
): Promise<void> {
  const {approvalId, decision} = reply;
  const row = await readApproval(store, userId, approvalId);
  if (!row || row.approval.runId !== runId) {
    throw new ApiError(409, 'decision_stale', 'Pending approval no longer exists');
  }
  const {approval} = row;
  if (approval.status !== 'pending') {
    verifySameDecision(approval, decision);
    return;
  }
  if (!pending) throw new ApiError(409, 'decision_stale', 'Pending approval no longer exists');
  const saved = await store.putIfRevision(userId, APPROVAL_RECORD_KIND, approvalId,
    {...approval, decision, status: decision === 'deny' ? 'denied' : 'approved'}, row.revision, {parentId: runId});
  if (saved) return;
  const current = await readApproval(store, userId, approvalId);
  if (!current || current.approval.runId !== runId) throw new ApiError(409, 'decision_stale', 'Pending approval no longer exists');
  verifySameDecision(current.approval, decision);
}

function verifySameDecision(row: ApprovalRecord, decision: ApprovalDecision['decision']): void {
  if (row.status === 'pending' || row.decision !== decision) {
    throw new ApiError(409, 'decision_conflict', 'Decision already resolved');
  }
}
