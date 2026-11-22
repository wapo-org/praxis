import type {ApprovalDecision, PendingApprovalRecord} from '@praxis/protocol';
import type {AgentPorts} from './types.js';

export function approvalTestStore() {
  const rows = new Map<string, PendingApprovalRecord>();
  const decisions = new Map<string, ApprovalDecision['decision']>();
  const ports: Pick<AgentPorts, 'pendingApproval' | 'approvalDecision'> = {
    async pendingApproval(_userId, row) {
      rows.set(row.id, row);
    },
    async approvalDecision(_userId, binding, id) {
      const row = rows.get(id);
      if (!row || row.runId !== binding.runId || row.toolCallId !== binding.toolCallId ||
          row.tool !== binding.tool || row.argsHash !== binding.argsHash) return null;
      return decisions.get(id) ?? null;
    },
  };
  return {ports, rows, decisions};
}
