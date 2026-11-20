import {useState} from 'react';
import type {Approval, ApprovalDecision} from '@praxis/protocol';
import styles from './Activity.module.css';
import card from './ElicitationCards.module.css';
import type {AgentActivityViewProps} from './activityTypes';

function ApprovalCard({approval, runId, onResolveApproval}: {
  approval: Approval;
  runId?: string;
  onResolveApproval?: AgentActivityViewProps['onResolveApproval'];
}) {
  const [submission, setSubmission] = useState<'idle' | 'submitting' | 'failed'>('idle');
  const preview = typeof approval.arguments === 'string' ? approval.arguments.trim() : '';

  async function submit(decision: ApprovalDecision['decision']) {
    if (!runId || !onResolveApproval || submission === 'submitting') return;
    setSubmission('submitting');
    try {
      await onResolveApproval(runId, approval.id, decision);
    } catch {
      setSubmission('failed');
    }
  }

  return (
    <div data-testid={`approval-card-${approval.id}`} className={`${card.card} ${card.body}`}>
      <div className={card.message}>
        <span>Approval required · {(approval.title || approval.toolName).replace(/_/g, ' ')}</span>
        {approval.source.serverName && <span className={styles.cardSource}>{approval.source.serverName}</span>}
      </div>
      {approval.taintSource && (
        <div data-testid="approval-taint" role="note" className={styles.cardReason}>
          This run read content from {approval.taintSource}.
        </div>
      )}
      {approval.reason && <div className={styles.cardReason}>{approval.reason}</div>}
      {preview && <pre className={styles.cardArgs}>{preview}</pre>}
      {submission === 'failed' && <div role="alert">Could not submit the decision. Try again.</div>}
      <div className={card.actions}>
        <button
          type="button"
          data-testid="approval-allow-once"
          data-tone="primary"
          className={card.primary}
          disabled={submission === 'submitting'}
          onClick={() => void submit('allowOnce')}
        >
          Allow Once
        </button>
        <button
          type="button"
          data-testid="approval-deny"
          data-tone="danger"
          className={card.secondary}
          disabled={submission === 'submitting'}
          onClick={() => void submit('deny')}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export function ApprovalCards({
  pendingApprovals = [], runId, onResolveApproval,
}: Pick<AgentActivityViewProps, 'pendingApprovals' | 'runId' | 'onResolveApproval'>) {
  return pendingApprovals.map(approval => (
    <ApprovalCard key={approval.id} approval={approval} runId={runId} onResolveApproval={onResolveApproval} />
  ));
}
