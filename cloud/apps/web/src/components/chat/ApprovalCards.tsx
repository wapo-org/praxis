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
          <div
            key={approval.id}
            data-testid={`approval-card-${approval.id}`}
            style={{
              width: '100%',
              borderRadius: 16,
              padding: 16,
              background: 'var(--paper-surface)',
              border: '1px solid var(--paper-warn)',
              boxShadow: '0 8px 24px rgba(184, 120, 34, 0.10)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--paper-warn)',
                  }}
                />
                <span
                  style={{
                    fontSize: 14,
                    fontWeight: 600,
                    color: 'var(--paper-ink)',
                  }}
                >
                  Approval required: {approval.title || approval.toolName}
                </span>
              </div>
              {approval.source?.serverName && (
                <span
                  style={{
                    fontSize: 11.5,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'var(--paper-fill-1)',
                    color: 'var(--paper-ink-2)',
                  }}
                >
                  {approval.source.serverName}
                </span>
              )}
            </div>

            {approval.reason && (
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--paper-ink-2)',
                  lineHeight: '18px',
                }}
              >
                {approval.reason}
              </div>
            )}

            {formattedApprovalArgs && (
              <pre
                style={{
                  margin: 0,
                  padding: '8px 10px',
                  borderRadius: 10,
                  background: 'var(--paper-surface-2)',
                  border: '0.5px solid var(--paper-hairline)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  lineHeight: '16px',
                  color: 'var(--paper-ink)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {formattedApprovalArgs}
              </pre>
            )}

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                marginTop: 4,
              }}
            >
              <button
                type="button"
                data-testid="approval-allow-once"
                onClick={() => runId && onResolveApproval?.(runId, approval.id, 'allowOnce')}
                style={{
                  padding: '7px 14px',
                  borderRadius: 10,
                  border: 'none',
                  background: 'var(--paper-accent)',
                  color: 'var(--paper-canvas)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Allow Once
              </button>
              <button
                type="button"
                data-testid="approval-allow-always"
                onClick={() => runId && onResolveApproval?.(runId, approval.id, 'allowAlways')}
                style={{
                  padding: '7px 14px',
                  borderRadius: 10,
                  border: '0.5px solid var(--paper-hairline)',
                  background: 'var(--paper-fill-1)',
                  color: 'var(--paper-ink)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Always Allow
              </button>
              <button
                type="button"
                data-testid="approval-deny"
                onClick={() => runId && onResolveApproval?.(runId, approval.id, 'deny')}
                style={{
                  padding: '7px 14px',
                  borderRadius: 10,
                  border: '0.5px solid var(--paper-hairline)',
                  background: 'transparent',
                  color: 'var(--paper-danger)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
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
