import { Check, Clock, X } from '../../lib/icons';

import styles from './Activity.module.css';
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
    <div data-testid="agent-activity-steps" className={styles.steps}>
      {reasoningBlocks.map((block) => (
        <div key={block.id} data-testid="agent-reasoning-block" className={styles.reasoning}>
          <div className={styles.reasoningCaption}>
            Reasoning{block.finished ? '' : ' · streaming'}
          </div>
          <div>{block.text}</div>
        </div>
      ))}

      {visionActivities.map((v) => (
        <div key={v.id} className={styles.vision}>
          <div>Image reader ({v.modelId ?? 'vision'}): {v.phase}</div>
          {v.answer ? <div>{v.answer}</div> : null}
        </div>
      ))}

      {compactions.map((c) => (
        <div key={c.id} className={styles.compaction}>
          <strong>Context compaction ({c.phase}):</strong> {c.summary ?? 'Summarizing earlier conversation turns...'}
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

        const iconTone = isError ? 'error' : isDone ? 'done' : 'running';
        return (
          <div key={step.callId} data-testid={`tool-step-${step.callId}`} className={styles.toolStep}>
            <button
              type="button"
              data-testid={`tool-step-header-${step.callId}`}
              onClick={() => toggleStepDetail(step.callId)}
              className={styles.toolStepHeader}
            >
              <span className={styles.toolStepMain}>
                <span className={styles.toolStepIcon} data-tone={iconTone} aria-hidden="true">
                  {step.running ? (
                    <Clock size={16} />
                  ) : isError ? (
                    <X size={16} />
                  ) : (
                    <Check size={16} />
                  )}
                </span>
                <span className={styles.toolStepName}>{step.activity.name}</span>
                {stepSummary ? (
                  <span className={styles.toolStepSummary}>— {stepSummary}</span>
                ) : null}
              </span>
              <span className={styles.toolStepToggle}>{isStepOpen ? 'Hide' : 'Details'}</span>
            </button>

            {isStepOpen && (
              <div data-testid={`tool-step-detail-${step.callId}`} className={styles.toolStepDetail}>
                <div className={styles.toolStepDetailHead}>
                  <span className={styles.toolStepDetailLabel}>Input</span>
                  <button
                    type="button"
                    className={styles.toolStepCopy}
                    onClick={() => copyText(step.callId, `${formattedArgs}\n\n${outputText}`.trim())}
                  >
                    {copiedStepId === step.callId ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre style={{ margin: 0, maxHeight: 160, overflowY: 'auto' }}>{formattedArgs}</pre>

                {step.progressLines.length > 0 && (
                  <div>
                    <div className={styles.toolStepDetailLabel}>Progress</div>
                    <pre style={{ margin: 0 }}>{step.progressLines.join('\n')}</pre>
                  </div>
                )}

                {outputText && (
                  <div>
                    <div className={styles.toolStepDetailLabel}>{isError ? 'Error' : 'Output'}</div>
                    <pre style={{ margin: 0, maxHeight: 200, overflowY: 'auto' }}>{outputText}</pre>
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
