import type { Message, Run, RunSnapshot, Usage } from '@praxis/protocol';
import React from 'react';
import { apiClient } from '../../lib/api';
import { snapshotProgress } from '../../lib/toolProgress';
import type { ActiveToolStep } from '../../state/types';
import { outcomeNote } from './activityLine';
import { AgentActivityView } from './AgentActivityView';
import { AgentMessageView } from './AgentMessageView';
import { extractToolSteps } from './messageTools';
import styles from './ChatScreen.module.css';

export type TranscriptItem =
  | { kind: 'user'; key: string; message: Message }
  | { kind: 'assistant'; key: string; messages: Message[] }
  /** A run with no saved answer: it failed or was stopped before one. Only its snapshot knows. */
  | { kind: 'unanswered'; key: string; runId: string };

/** One run is one turn: its tool and assistant messages share a single activity and answer. */
export function groupTranscript(messages: Message[], liveRunId?: string): TranscriptItem[] {
  const answered = new Set(messages.filter((m) => m.role !== 'user' && m.runId).map((m) => m.runId));
  const items: TranscriptItem[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      items.push({ kind: 'user', key: message.id, message });
      if (message.runId && message.runId !== liveRunId && !answered.has(message.runId))
        items.push({ kind: 'unanswered', key: `${message.runId}-unanswered`, runId: message.runId });
      continue;
    }
    if (message.runId && message.runId === liveRunId) continue;
    const last = items.at(-1);
    if (last?.kind === 'assistant' && message.runId && last.messages[0]!.runId === message.runId) last.messages.push(message);
    else items.push({ kind: 'assistant', key: message.id, messages: [message] });
  }
  return items;
}

function snapshotSteps(snapshot: RunSnapshot): ActiveToolStep[] {
  return snapshot.tools.map((tool) => ({
    callId: tool.activity.id,
    activity: tool.activity,
    argumentsJson: tool.argumentsJson,
    running: false,
    ...snapshotProgress(tool),
    completion: tool.completion,
  }));
}

function useRunSnapshot(runId: string | undefined, enabled: boolean) {
  const [snapshot, setSnapshot] = React.useState<RunSnapshot>();
  React.useEffect(() => {
    if (!runId || !enabled) return;
    let active = true;
    void apiClient
      .getRunSnapshot(runId)
      .then((value) => {
        if (active) setSnapshot(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [runId, enabled]);
  return snapshot;
}

export function OutcomeNote({ run }: { run?: Pick<Run, 'status' | 'outcome' | 'error'> }) {
  const note = run ? outcomeNote(run.status, run.outcome, run.error) : null;
  return note ? (
    <p role="status" data-testid="run-outcome-note" className={styles.outcome}>
      {note}
    </p>
  ) : null;
}

const joinText = (messages: Message[]) =>
  messages
    .flatMap((message) => message.parts)
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n\n');

/** A saved turn. Its run's timing and outcome come from the snapshot, fetched only if it has activity. */
export function AssistantTurn({ messages, onRetry, usage }: { messages: Message[]; onRetry?: () => void; usage?: Usage }) {
  const steps = React.useMemo(() => extractToolSteps(messages), [messages]);
  const reasoning = React.useMemo(
    () =>
      messages.flatMap((message) =>
        message.parts
          .filter((part) => part.type === 'reasoning')
          .map((part, index) => ({ id: `${message.id}-${index}`, text: part.text ?? '', finished: true })),
      ),
    [messages],
  );
  const hasActivity = steps.length > 0 || reasoning.length > 0;
  const snapshot = useRunSnapshot(messages[0]?.runId, hasActivity);
  const text = joinText(messages);
  return (
    <div data-testid="assistant-turn" className={styles.assistantTurn}>
      {hasActivity ? (
        <AgentActivityView
          startedAt={snapshot?.run.createdAt}
          finishedAt={snapshot?.run.updatedAt}
          isStopped={snapshot?.run.status === 'cancelled'}
          toolSteps={snapshot ? snapshotSteps(snapshot) : steps}
          reasoningBlocks={reasoning}
        />
      ) : null}
      {text ? <AgentMessageView text={text} onRetry={onRetry} usage={usage} /> : null}
      <OutcomeNote run={snapshot?.run} />
    </div>
  );
}

/** A run that ended without a saved answer. Whatever it did survives in the snapshot. */
export function UnansweredTurn({ runId }: { runId: string }) {
  const snapshot = useRunSnapshot(runId, true);
  if (!snapshot || !['failed', 'cancelled'].includes(snapshot.run.status)) return null;
  const reasoning = snapshot.blocks.filter((block) => block.type === 'reasoning');
  const text = snapshot.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n');
  return (
    <div data-testid="assistant-turn" className={styles.assistantTurn}>
      <AgentActivityView
        startedAt={snapshot.run.createdAt}
        finishedAt={snapshot.run.updatedAt}
        isStopped={snapshot.run.status === 'cancelled'}
        toolSteps={snapshotSteps(snapshot)}
        reasoningBlocks={reasoning.map((block) => ({ id: block.id, text: block.text, finished: true }))}
      />
      {text ? <AgentMessageView text={text} /> : null}
      <OutcomeNote run={snapshot.run} />
    </div>
  );
}
