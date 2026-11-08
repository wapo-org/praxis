import type { Message, Run } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../../lib/api';
import { snapshotProgress } from '../../lib/toolProgress';
import type { ActiveToolStep } from '../../state/store';
import styles from './Activity.module.css';
import { AgentActivityView } from './AgentActivityView';
import { maxIsoTimestamp } from './useActivityClock';

export function MessageActivity({
  message,
  steps,
  liveRun,
  liveSteps,
  promptStartedAt,
}: {
  message: Message;
  steps: ActiveToolStep[];
  liveRun?: Run;
  liveSteps?: ActiveToolStep[];
  promptStartedAt?: string;
}) {
  const [run, setRun] = React.useState<Run | undefined>(liveRun);
  const [recoveredSteps, setRecoveredSteps] = React.useState<ActiveToolStep[] | undefined>();
  React.useEffect(() => {
    if (liveRun) {
      setRun(liveRun);
      return;
    }
    if (!message.runId) return;
    let active = true;
    void apiClient
      .getRunSnapshot(message.runId)
      .then((value) => {
        if (active) {
          setRun(value.run);
          setRecoveredSteps(
            value.tools.map((tool) => ({
              callId: tool.activity.id,
              activity: tool.activity,
              argumentsJson: tool.argumentsJson,
              running: false,
              ...snapshotProgress(tool),
              completion: tool.completion,
            })),
          );
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [message.runId, liveRun]);

  const startedAt = run?.createdAt ?? message.createdAt;
  const finishedAt =
    maxIsoTimestamp(run?.updatedAt, maxIsoTimestamp(message.updatedAt, message.createdAt)) ??
    undefined;

  return (
    <>
      <AgentActivityView
        runId={run?.id ?? message.runId}
        startedAt={startedAt}
        finishedAt={finishedAt}
        promptStartedAt={promptStartedAt}
        isRunning={false}
        runStatus={run?.status}
        toolSteps={liveSteps ?? recoveredSteps ?? steps}
        reasoningBlocks={message.parts
          .filter((p) => p.type === 'reasoning')
          .map((p, i) => ({
            id: p.blockId ?? `${message.id}-${i}`,
            ...p,
            text: p.text ?? '',
            finished: true,
          }))}
      />
      {run?.error ? (
        <p role="status" className={styles.outcome}>
          Couldn't finish: {run.error}
        </p>
      ) : null}
    </>
  );
}
