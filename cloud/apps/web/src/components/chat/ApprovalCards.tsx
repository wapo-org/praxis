import styles from './Activity.module.css';
import card from './ElicitationCards.module.css';
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

        let hasArguments = Boolean(formattedApprovalArgs.trim());
        try {
          const value: unknown = JSON.parse(formattedApprovalArgs);
          if (
            value &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            Object.keys(value).length === 0
          )
            hasArguments = false;
        } catch {
          /* Plain text and partially streamed arguments remain reviewable. */
        }
        return (
          <div
            key={approval.id}
            data-testid={`approval-card-${approval.id}`}
            className={`${card.card} ${card.body}`}
          >
            <div className={card.message} style={{display:'flex',flexDirection:'column',gap:4}}>
              <span>
                Approval required: {(approval.title || approval.toolName).replace(/_/g, ' ')}
              </span>
              {approval.source?.serverName ? (
                <span className={styles.cardSource}>{approval.source.serverName}</span>
              ) : null}
            </div>

            {approval.reason ? <div className={styles.cardReason}>{approval.reason}</div> : null}

            {hasArguments ? <pre className={styles.cardArgs}>{formattedApprovalArgs}</pre> : null}

            <div className={card.actions}>
              <button
                type="button"
                data-testid="approval-allow-once"
                data-tone="primary"
                className={card.primary}
                onClick={() => runId && onResolveApproval?.(runId, approval.id, 'allowOnce')}
              >
                Allow Once
              </button>
              <button
                type="button"
                data-testid="approval-allow-always"
                data-tone="secondary"
                className={card.secondary}
                onClick={() => runId && onResolveApproval?.(runId, approval.id, 'allowAlways')}
              >
                Always Allow
              </button>
              <button
                type="button"
                data-testid="approval-deny"
                data-tone="danger"
                className={card.secondary}
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
