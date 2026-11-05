import type { Approval } from '@praxis/protocol';
import { FileText, Link2, Waypoints } from '../../lib/icons';
import type { AgentActivityViewProps } from './activityTypes';
import { humanizeToolName } from './activityLine';
import styles from './InlineCard.module.css';

function formatArguments(value: Approval['arguments']) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text === '{}' ? '' : text;
}

/** Inline approval: what will run, why it asks, the exact arguments, and three answers.
 *  A call made from inside code says so: the model didn't call the tool itself, its code did. */
export function ApprovalCard({
  approval,
  runId,
  onResolveApproval,
}: { approval: Approval } & Pick<AgentActivityViewProps, 'runId' | 'onResolveApproval'>) {
  const fromCode = Boolean(approval.parentCallId);
  const tool = humanizeToolName(approval.toolName);
  const server = approval.source?.serverName;
  const origin = [fromCode ? 'From code' : null, server, tool].filter(Boolean).join(' · ');
  const OriginIcon = fromCode ? FileText : server ? Link2 : Waypoints;
  const args = formatArguments(approval.arguments);
  // The API writes titles like "Allow local_write?": the raw name never reaches the card.
  const title = (approval.title || tool).replaceAll(approval.toolName, tool.toLowerCase());
  const answer = (decision: 'allowOnce' | 'allowAlways' | 'deny') => {
    if (runId) onResolveApproval?.(runId, approval.id, decision);
  };
  return (
    <section
      className={styles.card}
      data-testid={`approval-card-${approval.id}`}
      aria-label={`Approval needed: ${title}`}
    >
      <div className={styles.origin}>
        <span className={styles.originIcon}>
          <OriginIcon size={16} />
        </span>
        <span>{origin}</span>
      </div>
      <div className={styles.copy}>
        <h3 className={styles.title}>{title}</h3>
        {approval.reason ? <p className={styles.reason}>{approval.reason}</p> : null}
        {fromCode ? (
          <p className={styles.reason} data-muted="true">
            The code above is calling this tool. It waits for your answer.
          </p>
        ) : null}
      </div>
      {args ? <pre className={styles.arguments}>{args}</pre> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.button} data-tone="primary" data-testid="approval-allow-once" onClick={() => answer('allowOnce')}>
          Allow once
        </button>
        <button type="button" className={styles.button} data-tone="secondary" data-testid="approval-allow-always" onClick={() => answer('allowAlways')}>
          Always allow
        </button>
        <span className={styles.spacer} />
        <button type="button" className={styles.button} data-tone="ghost" data-testid="approval-deny" onClick={() => answer('deny')}>
          Deny
        </button>
      </div>
    </section>
  );
}
