import { Check, Clock, X } from '../../lib/icons';

import type { AgentActivityViewProps } from './activityTypes';
export function ActivityDetails({
  reasoningBlocks = [],
  visionActivities = [],
  compactions = [],
  toolSteps,
  openStepIds,
  copiedStepId,
  toggleStepDetail,
  copyText,
}: Pick<
  AgentActivityViewProps,
  'reasoningBlocks' | 'visionActivities' | 'compactions' | 'toolSteps'
> & {
  openStepIds: Record<string, boolean>;
  copiedStepId: string | null;
  toggleStepDetail: (id: string) => void;
  copyText: (id: string, text: string) => void;
}) {
  return (
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
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontWeight: 500,
            }}
          >
            <span>👁</span>
            <span>
              Image reader ({v.modelId ?? 'vision'}): {v.phase}
            </span>
          </div>
          {v.answer && (
            <div
              style={{
                color: 'var(--paper-ink-2)',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
              }}
            >
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
        const isError =
          step.completion?.status === 'failed' || step.completion?.status === 'denied';
        const isDone = Boolean(step.completion) && !step.running;

        const formattedArgs =
          step.argumentsJson ||
          (step.activity.arguments ? JSON.stringify(step.activity.arguments, null, 2) : '{}');
        const outputText = step.completion?.preview || step.completion?.summary || '';
        const stepSummary = step.running
          ? step.statusText || step.activity.presentation?.runningTitle
          : step.activity.presentation?.finishedTitle || step.completion?.summary;

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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minWidth: 0,
                }}
              >
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
                  {step.running ? (
                    <Clock size={14} />
                  ) : isError ? (
                    <X size={14} />
                  ) : (
                    <Check size={14} />
                  )}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 12,
                    fontWeight: 500,
                    color: 'var(--paper-ink)',
                  }}
                >
                  {step.activity.name}
                </span>
                {stepSummary && (
                  <span
                    style={{
                      color: 'var(--paper-ink-2)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    — {stepSummary}
                  </span>
                )}
              </div>
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--paper-ink-3)',
                  flexShrink: 0,
                }}
              >
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
                      style={{
                        fontWeight: 600,
                        color: 'var(--paper-ink-3)',
                        marginBottom: 4,
                      }}
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
  );
}
