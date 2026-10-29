import React from 'react';
import type { Approval } from '@praxis/protocol';
import { GlassSurface } from '@praxis/glass';
import type { ActiveElicitation, ActiveToolStep } from '../../state/store';

export interface AgentActivityViewProps {
  runId?: string;
  isRunning?: boolean;
  reasoningBlocks?: Array<{ id: string; text: string; finished: boolean }>;
  toolSteps: ActiveToolStep[];
  pendingApprovals?: Approval[];
  pendingElicitations?: ActiveElicitation[];
  visionActivities?: Array<{
    id: string;
    phase: 'started' | 'finished' | 'failed';
    attachmentId: string;
    modelId?: string;
    question?: string;
    answer?: string;
  }>;
  compactions?: Array<{
    id: string;
    phase: 'started' | 'finished' | 'failed';
    summary?: string;
  }>;
  onResolveApproval?: (
    runId: string,
    approvalId: string,
    decision: 'allowOnce' | 'allowAlways' | 'deny',
  ) => void;
  onResolveElicitation?: (
    runId: string,
    elicitationId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>,
  ) => void;
}

export const AgentActivityView: React.FC<AgentActivityViewProps> = ({
  runId,
  isRunning = false,
  reasoningBlocks = [],
  toolSteps,
  pendingApprovals = [],
  pendingElicitations = [],
  visionActivities = [],
  compactions = [],
  onResolveApproval,
  onResolveElicitation,
}) => {
  const [expanded, setExpanded] = React.useState<boolean>(false);
  const [openStepIds, setOpenStepIds] = React.useState<Record<string, boolean>>({});
  const [copiedStepId, setCopiedStepId] = React.useState<string | null>(null);
  const [elicitationValues, setElicitationValues] = React.useState<
    Record<string, Record<string, unknown>>
  >({});

  const hasActivity =
    toolSteps.length > 0 ||
    reasoningBlocks.length > 0 ||
    pendingApprovals.length > 0 ||
    pendingElicitations.length > 0 ||
    visionActivities.length > 0 ||
    compactions.length > 0;

  if (!hasActivity && !isRunning) {
    return null;
  }

  const runningToolsCount = toolSteps.filter((t) => t.running).length;
  const totalToolsCount = toolSteps.length;
  const hasApproval = pendingApprovals.length > 0;
  const hasElicitation = pendingElicitations.length > 0;

  let statusColor = 'var(--paper-accent)';
  let summaryLabel = 'Completed activity';

  if (hasApproval) {
    statusColor = 'var(--paper-warn)';
    summaryLabel = `Waiting for tool approval (${pendingApprovals.length})`;
  } else if (hasElicitation) {
    statusColor = 'var(--paper-warn)';
    summaryLabel = 'Waiting for your input';
  } else if (isRunning || runningToolsCount > 0) {
    statusColor = 'var(--paper-ink-2)';
    const currentStep = toolSteps.find((s) => s.running) ?? toolSteps[toolSteps.length - 1];
    if (currentStep) {
      summaryLabel = `${currentStep.activity.summary || currentStep.activity.tool}${
        totalToolsCount > 1 ? ` · ${totalToolsCount} steps` : ''
      }`;
    } else if (reasoningBlocks.some((b) => !b.finished)) {
      summaryLabel = 'Thinking...';
    } else {
      summaryLabel = 'Working...';
    }
  } else if (totalToolsCount > 0) {
    const failedCount = toolSteps.filter((s) => s.completion?.isError).length;
    if (failedCount > 0) {
      statusColor = 'var(--paper-danger)';
      summaryLabel = `Used ${totalToolsCount} tool${totalToolsCount === 1 ? '' : 's'} (${failedCount} failed)`;
    } else {
      statusColor = 'var(--paper-accent)';
      summaryLabel = `Used ${totalToolsCount} tool${totalToolsCount === 1 ? '' : 's'}`;
    }
  } else if (reasoningBlocks.length > 0) {
    summaryLabel = 'Thought process';
  }

  const toggleStepDetail = (callId: string) => {
    setOpenStepIds((prev) => ({ ...prev, [callId]: !prev[callId] }));
  };

  const copyText = (id: string, text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
    setCopiedStepId(id);
    setTimeout(() => {
      setCopiedStepId((curr) => (curr === id ? null : curr));
    }, 1500);
  };

  return (
    <div
      data-testid="agent-activity-view"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 10,
        marginBottom: 12,
        width: '100%',
      }}
    >
      {/* Level 0: Folded / Expandable Pill Header */}
      <GlassSurface
        as="button"
        material="thin"
        intensity="subtle"
        radius={18}
        interactive
        data-testid="agent-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 9,
          padding: '6px 13px',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--paper-ink)',
          fontSize: 13,
          lineHeight: '18px',
          fontWeight: 500,
          maxWidth: '100%',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            backgroundColor: statusColor,
            flexShrink: 0,
            boxShadow:
              isRunning || hasApproval || hasElicitation ? `0 0 0 3px ${statusColor}28` : 'none',
            animation:
              isRunning || runningToolsCount > 0
                ? 'praxisPulseDot 1.4s ease-in-out infinite'
                : 'none',
          }}
        />
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {summaryLabel}
        </span>
        <span
          aria-hidden="true"
          style={{
            fontSize: 11,
            color: 'var(--paper-ink-3)',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          ▾
        </span>
      </GlassSurface>

      {/* Level 1 & Level 2: Expanded Steps + Reasoning + Vision + Compaction */}
      {expanded && (
        <div
          data-testid="agent-activity-steps"
          style={{
            width: '100%',
            borderRadius: 16,
            background: 'var(--paper-surface)',
            border: '0.5px solid var(--paper-hairline)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            boxShadow: '0 4px 18px rgba(18, 17, 15, 0.04)',
          }}
        >
          {reasoningBlocks.map((block) => (
            <div
              key={block.id}
              data-testid="agent-reasoning-block"
              style={{
                padding: '8px 10px',
                borderRadius: 10,
                background: 'var(--paper-fill-1)',
                fontSize: 13,
                lineHeight: '19px',
                color: 'var(--paper-ink-2)',
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  textTransform: 'uppercase',
                  letterSpacing: '0.4px',
                  color: 'var(--paper-ink-3)',
                  marginBottom: 4,
                }}
              >
                Reasoning {block.finished ? '' : '· streaming'}
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{block.text}</div>
            </div>
          ))}

          {visionActivities.map((v) => (
            <div
              key={v.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '8px 10px',
                borderRadius: 10,
                background: 'var(--paper-fill-1)',
                fontSize: 13,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 }}>
                <span>👁</span>
                <span>
                  Image reader ({v.modelId ?? 'vision'}): {v.phase}
                </span>
              </div>
              {v.answer && (
                <div style={{ color: 'var(--paper-ink-2)', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                  {v.answer}
                </div>
              )}
            </div>
          ))}

          {compactions.map((c) => (
            <div
              key={c.id}
              style={{
                padding: '8px 10px',
                borderRadius: 10,
                background: 'var(--paper-fill-1)',
                fontSize: 12.5,
                color: 'var(--paper-ink-2)',
              }}
            >
              <strong>Context compaction ({c.phase}):</strong>{' '}
              {c.summary ?? 'Summarizing earlier conversation turns...'}
            </div>
          ))}

          {toolSteps.map((step) => {
            const isStepOpen = Boolean(openStepIds[step.callId]);
            const isError = Boolean(step.completion?.isError);
            const isDone = Boolean(step.completion) && !step.running;

            const formattedArgs = step.argumentsJson || (
              step.activity.arguments ? JSON.stringify(step.activity.arguments, null, 2) : '{}'
            );
            const outputText = step.completion?.output ?? step.completion?.error ?? '';

            return (
              <div
                key={step.callId}
                data-testid={`tool-step-${step.callId}`}
                style={{
                  borderRadius: 12,
                  border: '0.5px solid var(--paper-hairline)',
                  background: 'var(--paper-canvas)',
                  overflow: 'hidden',
                }}
              >
                <button
                  type="button"
                  data-testid={`tool-step-header-${step.callId}`}
                  onClick={() => toggleStepDetail(step.callId)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '9px 12px',
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: 'var(--paper-ink)',
                    fontSize: 13,
                    lineHeight: '18px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span
                      aria-hidden="true"
                      style={{
                        fontSize: 12,
                        color: isError
                          ? 'var(--paper-danger)'
                          : isDone
                            ? 'var(--paper-accent)'
                            : 'var(--paper-ink-2)',
                      }}
                    >
                      {step.running ? '⟳' : isError ? '✕' : '✓'}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        fontWeight: 500,
                        color: 'var(--paper-ink)',
                      }}
                    >
                      {step.activity.tool}
                    </span>
                    {step.activity.summary && (
                      <span
                        style={{
                          color: 'var(--paper-ink-2)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        — {step.activity.summary}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--paper-ink-3)', flexShrink: 0 }}>
                    {isStepOpen ? 'Hide' : 'Details'}
                  </span>
                </button>

                {/* Level 2: Monospace JSON Input + Progress + Output Detail */}
                {isStepOpen && (
                  <div
                    data-testid={`tool-step-detail-${step.callId}`}
                    style={{
                      borderTop: '0.5px solid var(--paper-hairline)',
                      padding: '10px 12px',
                      background: 'var(--paper-surface-2)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      lineHeight: '16px',
                      color: 'var(--paper-ink-2)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 4,
                        }}
                      >
                        <span style={{ fontWeight: 600, color: 'var(--paper-ink-3)' }}>INPUT</span>
                        <button
                          type="button"
                          onClick={() =>
                            copyText(step.callId, `${formattedArgs}\n\n${outputText}`.trim())
                          }
                          style={{
                            border: '0.5px solid var(--paper-hairline)',
                            background: 'var(--paper-surface)',
                            borderRadius: 6,
                            padding: '2px 7px',
                            fontSize: 10.5,
                            color: 'var(--paper-ink-2)',
                            cursor: 'pointer',
                          }}
                        >
                          {copiedStepId === step.callId ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                      <pre
                        style={{
                          margin: 0,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          maxHeight: 160,
                          overflowY: 'auto',
                        }}
                      >
                        {formattedArgs}
                      </pre>
                    </div>

                    {step.progressLines.length > 0 && (
                      <div>
                        <div
                          style={{ fontWeight: 600, color: 'var(--paper-ink-3)', marginBottom: 4 }}
                        >
                          PROGRESS
                        </div>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                          {step.progressLines.join('\n')}
                        </pre>
                      </div>
                    )}

                    {outputText && (
                      <div>
                        <div
                          style={{
                            fontWeight: 600,
                            color: isError ? 'var(--paper-danger)' : 'var(--paper-ink-3)',
                            marginBottom: 4,
                          }}
                        >
                          {isError ? 'ERROR' : 'OUTPUT'}
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            maxHeight: 200,
                            overflowY: 'auto',
                            color: isError ? 'var(--paper-danger)' : 'var(--paper-ink)',
                          }}
                        >
                          {outputText}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Inline Pending Tool Approval Cards */}
      {pendingApprovals.map((approval) => (
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--paper-warn)',
                }}
              />
              <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--paper-ink)' }}>
                Approval required: {approval.title || approval.toolName}
              </span>
            </div>
            {approval.connectorName && (
              <span
                style={{
                  fontSize: 11.5,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: 'var(--paper-fill-1)',
                  color: 'var(--paper-ink-2)',
                }}
              >
                {approval.connectorName}
              </span>
            )}
          </div>

          {approval.detail && (
            <div style={{ fontSize: 13, color: 'var(--paper-ink-2)', lineHeight: '18px' }}>
              {approval.detail}
            </div>
          )}

          {approval.argumentsJson && (
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
              {approval.argumentsJson}
            </pre>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              data-testid="approval-allow-once"
              onClick={() => runId && onResolveApproval?.(runId, approval.id, 'allowOnce')}
              style={{
                padding: '7px 14px',
                borderRadius: 10,
                border: 'none',
                background: 'var(--paper-accent)',
                color: '#FFFFFF',
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
      ))}

      {/* Inline Pending Elicitation Form Cards */}
      {pendingElicitations.map((elicitation) => {
        const schemaProps =
          (elicitation.schema?.properties as Record<
            string,
            { type?: string; title?: string; description?: string; default?: unknown }
          >) ?? {};
        const propKeys = Object.keys(schemaProps);
        const currentForm = elicitationValues[elicitation.id] ?? {};

        const setFieldValue = (key: string, val: unknown) => {
          setElicitationValues((prev) => ({
            ...prev,
            [elicitation.id]: {
              ...(prev[elicitation.id] ?? {}),
              [key]: val,
            },
          }));
        };

        return (
          <div
            key={elicitation.id}
            data-testid={`elicitation-card-${elicitation.id}`}
            style={{
              width: '100%',
              borderRadius: 16,
              padding: 16,
              background: 'var(--paper-surface)',
              border: '1px solid var(--paper-accent)',
              boxShadow: '0 8px 24px rgba(47, 122, 77, 0.10)',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--paper-ink)' }}>
              {elicitation.message || 'Additional details requested'}
            </div>

            {elicitation.mode === 'url' && elicitation.url ? (
              <a
                href={elicitation.url}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  color: 'var(--paper-accent)',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Open external authorization ({elicitation.url}) ↗
              </a>
            ) : propKeys.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {propKeys.map((key) => {
                  const spec = schemaProps[key] ?? {};
                  const val =
                    currentForm[key] !== undefined
                      ? String(currentForm[key])
                      : spec.default !== undefined
                        ? String(spec.default)
                        : '';
                  return (
                    <label
                      key={key}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        fontSize: 12.5,
                        color: 'var(--paper-ink-2)',
                      }}
                    >
                      <span style={{ fontWeight: 500, color: 'var(--paper-ink)' }}>
                        {spec.title || key}
                      </span>
                      {spec.description && (
                        <span style={{ fontSize: 11.5, color: 'var(--paper-ink-3)' }}>
                          {spec.description}
                        </span>
                      )}
                      <input
                        type={spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text'}
                        data-testid={`elicitation-input-${key}`}
                        value={val}
                        placeholder={`Enter ${spec.title || key}...`}
                        onChange={(e) =>
                          setFieldValue(
                            key,
                            spec.type === 'number' || spec.type === 'integer'
                              ? Number(e.target.value)
                              : e.target.value,
                          )
                        }
                        style={{
                          padding: '8px 11px',
                          borderRadius: 10,
                          border: '0.5px solid var(--paper-hairline)',
                          background: 'var(--paper-canvas)',
                          color: 'var(--paper-ink)',
                          fontSize: 13.5,
                        }}
                      />
                    </label>
                  );
                })}
              </div>
            ) : (
              <input
                type="text"
                data-testid="elicitation-input-response"
                placeholder="Type your response..."
                value={String(currentForm.response ?? '')}
                onChange={(e) => setFieldValue('response', e.target.value)}
                style={{
                  padding: '8px 11px',
                  borderRadius: 10,
                  border: '0.5px solid var(--paper-hairline)',
                  background: 'var(--paper-canvas)',
                  color: 'var(--paper-ink)',
                  fontSize: 13.5,
                }}
              />
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                data-testid="elicitation-submit"
                onClick={() => {
                  if (!runId) return;
                  const payload =
                    Object.keys(currentForm).length > 0
                      ? currentForm
                      : propKeys.reduce<Record<string, unknown>>((acc, k) => {
                          acc[k] = schemaProps[k]?.default ?? 'confirmed';
                          return acc;
                        }, {});
                  onResolveElicitation?.(runId, elicitation.id, 'accept', payload);
                }}
                style={{
                  padding: '7px 14px',
                  borderRadius: 10,
                  border: 'none',
                  background: 'var(--paper-accent)',
                  color: '#FFFFFF',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Submit
              </button>
              <button
                type="button"
                data-testid="elicitation-decline"
                onClick={() => runId && onResolveElicitation?.(runId, elicitation.id, 'decline')}
                style={{
                  padding: '7px 14px',
                  borderRadius: 10,
                  border: '0.5px solid var(--paper-hairline)',
                  background: 'var(--paper-fill-1)',
                  color: 'var(--paper-ink)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Decline
              </button>
              <button
                type="button"
                data-testid="elicitation-cancel"
                onClick={() => runId && onResolveElicitation?.(runId, elicitation.id, 'cancel')}
                style={{
                  padding: '7px 14px',
                  borderRadius: 10,
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--paper-ink-3)',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
