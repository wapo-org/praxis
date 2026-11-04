import styles from './Activity.module.css';
import type { AgentActivityViewProps } from './activityTypes';
export function ApprovalCards({
  pendingApprovals = [],
  runId,
  onResolveApproval,
}: Pick<AgentActivityViewProps, 'pendingApprovals' | 'runId' | 'onResolveApproval'>) {
  return (
    <>
      {pendingApprovals.map((approval) => {
        const formattedApprovalArgs =
          approval.arguments !== undefined
            ? typeof approval.arguments === 'string'
              ? approval.arguments
              : JSON.stringify(approval.arguments, null, 2)
            : '';

        return (
          <div key={approval.id} data-testid={`approval-card-${approval.id}`} className={styles.card}>
            <div className={styles.cardTitle}>
              <span>Approval required: {approval.title || approval.toolName}</span>
              {approval.source?.serverName ? (
                <span className={styles.cardSource}>{approval.source.serverName}</span>
              ) : null}
            </div>

            {approval.reason ? <div className={styles.cardReason}>{approval.reason}</div> : null}

            {formattedApprovalArgs ? <pre className={styles.cardArgs}>{formattedApprovalArgs}</pre> : null}

            <div className={styles.cardActions}>
              <button
                type="button"
                data-testid="approval-allow-once"
                data-tone="primary"
                className={styles.cardButton}
                onClick={() => runId && onResolveApproval?.(runId, approval.id, 'allowOnce')}
              >
                Allow Once
              </button>
              <button
                type="button"
                data-testid="approval-allow-always"
                data-tone="secondary"
                className={styles.cardButton}
                onClick={() => runId && onResolveApproval?.(runId, approval.id, 'allowAlways')}
              >
                Always Allow
              </button>
              <button
                type="button"
                data-testid="approval-deny"
                data-tone="danger"
                className={styles.cardButton}
                onClick={() => runId && onResolveApproval?.(runId, approval.id, 'deny')}
              >
                Deny
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
