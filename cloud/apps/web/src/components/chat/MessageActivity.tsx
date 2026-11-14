import type { Message, Run } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../../lib/api';
import { snapshotProgress } from '../../lib/toolProgress';
import type { ActiveToolStep } from '../../state/store';
import styles from './Activity.module.css';
import { ResponseTimeline, savedTimeline } from './ResponseTimeline';
import { maxIsoTimestamp } from './useActivityClock';

export function MessageActivity({
  message,
  steps,
  text,
  liveRun,
  liveSteps,
  promptStartedAt,
  onRetry,
}: {
  message: Message;
  steps: ActiveToolStep[];
  text: string;
  liveRun?: Run;
  liveSteps?: ActiveToolStep[];
  promptStartedAt?: string;
  onRetry?: () => void;
}) {
  const [run, setRun] = React.useState<Run | undefined>(liveRun);
  const [recoveredSteps, setRecoveredSteps] = React.useState<ActiveToolStep[] | undefined>();
  const hasReasoning = message.parts.some((p) => p.type === 'reasoning');
  React.useEffect(() => {
    if (liveRun) {
      setRun(liveRun);
      return;
    }
    if (!message.runId || (!steps.length && !hasReasoning && text.length > 0)) return;
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
  }, [message.runId, liveRun, steps.length, hasReasoning, text.length]);

  const startedAt = run?.createdAt ?? message.createdAt;
  const finishedAt =
    maxIsoTimestamp(run?.updatedAt, maxIsoTimestamp(message.updatedAt, message.createdAt)) ??
    undefined;
  // Snapshots carry no timing; the message-derived steps know when each call and result were committed.
  const timedRecovered = React.useMemo(
    () =>
      recoveredSteps?.map((r) => {
        const m = steps.find((s) => s.callId === r.callId);
        return m ? { ...r, startedAt: r.startedAt ?? m.startedAt, finishedAt: r.finishedAt ?? m.finishedAt } : r;
      }),
    [recoveredSteps, steps],
  );
  const resolvedSteps = liveSteps ?? timedRecovered ?? steps;

  return (
    <ResponseTimeline
      nodes={savedTimeline(message, resolvedSteps)}
      text={text}
      onRetry={onRetry}
      errorElement={
        run?.error ? (
          <p role="status" className={styles.outcome}>
            Couldn't finish: {run.error}
          </p>
        ) : undefined
      }
      activity={{
        runId: run?.id ?? message.runId,
        startedAt,
        finishedAt,
        promptStartedAt,
        isRunning: false,
        runStatus: run?.status,
        toolSteps: resolvedSteps,
      }}
    />
  );
}
