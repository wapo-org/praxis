import React from 'react';
import type { Message } from '@praxis/protocol';
import type { LiveRunState } from '../../state/types';
import type { AgentActivityViewProps } from './activityTypes';
import { AgentActivityView } from './AgentActivityView';
import { AgentMessageView } from './AgentMessageView';
import styles from './AgentMessageView.module.css';
import { MarkdownContent } from './MarkdownContent';
import { hasThought, type ReasoningBlock } from './ReasoningView';

type Node = {
  id: string;
  text?: string;
  thought?: ReasoningBlock;
  step?: AgentActivityViewProps['toolSteps'][number];
};

function minIso(values: Array<string | undefined>): string | undefined {
  const valid = values.filter((v): v is string => !!v && !Number.isNaN(Date.parse(v)));
  if (!valid.length) return undefined;
  return valid.reduce((best, cur) => (Date.parse(cur) < Date.parse(best) ? cur : best));
}

function maxIso(values: Array<string | undefined>): string | undefined {
  const valid = values.filter((v): v is string => !!v && !Number.isNaN(Date.parse(v)));
  if (!valid.length) return undefined;
  return valid.reduce((best, cur) => (Date.parse(cur) > Date.parse(best) ? cur : best));
}

/** Parts stay in wire order; result-only user messages have already been joined by messageTurns. */
export function savedTimeline(message: Message, steps: AgentActivityViewProps['toolSteps']): Node[] {
  const nodes = message.parts.flatMap((p, i): Node[] => {
    const id = p.blockId ?? `${message.id}-${i}`;
    if (p.type === 'text') return p.text ? [{ id, text: p.text }] : [];
    if (p.type === 'reasoning') return [{ id, thought: { ...p, id, text: p.text ?? '', finished: true } }];
    if (p.type === 'toolCall') {
      const step = steps.find((s) => s.callId === p.callId);
      return step ? [{ id: step.callId, step }] : [];
    }
    return [];
  });
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (nodes.some((n) => n.step?.callId === step.callId)) continue;
    const node = { id: step.callId, step };
    const parent = step.activity.parentCallId
      ? nodes.findIndex((n) => n.step?.callId === step.activity.parentCallId)
      : -1;
    if (parent >= 0) {
      nodes.splice(parent + 1, 0, node);
      continue;
    }
    const nextInNodes = steps
      .slice(i + 1)
      .map((later) => nodes.findIndex((n) => n.step?.callId === later.callId))
      .find((idx) => idx >= 0);
    if (nextInNodes !== undefined) {
      nodes.splice(nextInNodes, 0, node);
      continue;
    }
    const prevInNodes = [...steps.slice(0, i)]
      .reverse()
      .map((earlier) => nodes.findIndex((n) => n.step?.callId === earlier.callId))
      .find((idx) => idx >= 0);
    if (prevInNodes !== undefined) {
      nodes.splice(prevInNodes + 1, 0, node);
      continue;
    }
    const firstText = nodes.findIndex((n) => n.text !== undefined);
    if (firstText >= 0) nodes.splice(firstText, 0, node);
    else nodes.push(node);
  }
  return nodes;
}

export function liveTimeline(live: LiveRunState): Node[] {
  return [
    ...live.textBlocks.filter((b) => b.text.length > 0).map((b) => ({ id: b.id, text: b.text, order: b.timelineOrder ?? 0 })),
    ...live.reasoningBlocks.map((b) => ({ id: b.id, thought: b, order: b.timelineOrder ?? 0 })),
    ...live.toolSteps.map((s) => ({ id: s.callId, step: s, order: s.timelineOrder ?? 1 })),
  ].sort((a, b) => a.order - b.order);
}

export function ResponseTimeline({
  nodes,
  activity,
  text,
  usage,
  onRetry,
  errorElement,
}: {
  nodes: Node[];
  activity: AgentActivityViewProps & { runStatus?: string };
  text: string;
  usage?: LiveRunState['usage'];
  onRetry?: () => void;
  errorElement?: React.ReactNode;
}) {
  const rawGroups: Array<{ id: string; nodes: Node[]; text?: string }> = [];
  for (const node of nodes) {
    if (node.text !== undefined) {
      rawGroups.push({ id: node.id, nodes: [], text: node.text });
    } else if (node.step || node.thought) {
      const last = rawGroups.at(-1);
      if (last && last.text === undefined) last.nodes.push(node);
      else rawGroups.push({ id: node.id, nodes: [node] });
    }
  }
  const last = rawGroups.at(-1);
  const pendingCards =
    !!activity.pendingApprovals?.length ||
    !!activity.pendingElicitations?.length ||
    !!activity.visionActivities?.length ||
    !!activity.compactions?.length;
  const hasVisibleGroups = rawGroups.some(
    (g) => g.text !== undefined || g.nodes.some((n) => !!n.step || (!!n.thought && hasThought(n.thought))),
  );
  const pending = pendingCards || (!!activity.isRunning && !hasVisibleGroups);
  if (pending && (!last || last.text !== undefined)) rawGroups.push({ id: 'pending', nodes: [] });

  const groups = rawGroups.filter(
    (g, i) =>
      g.text !== undefined ||
      g.nodes.some((n) => !!n.step || (!!n.thought && hasThought(n.thought))) ||
      (i === rawGroups.length - 1 && pending),
  );

  const firstTextIndex = groups.findIndex((g) => g.text !== undefined);
  const leading = firstTextIndex >= 0 ? groups.slice(0, firstTextIndex) : groups;
  const rest = firstTextIndex >= 0 ? groups.slice(firstTextIndex) : [];

  const renderGroup = (group: { id: string; nodes: Node[]; text?: string }, i: number) => {
    if (group.text !== undefined) {
      return (
        <div key={group.id} className={styles.timelineText} data-timeline-text="">
          <MarkdownContent text={group.text} isStreaming={!!activity.isRunning && i === groups.length - 1} />
        </div>
      );
    }
    const thoughts = group.nodes.flatMap((n) => (n.thought ? [n.thought] : []));
    const steps = group.nodes.flatMap((n) => (n.step ? [n.step] : []));
    const tail = i === groups.length - 1;
    const prevNodes = groups.slice(0, i).flatMap((g) => g.nodes);
    const nextNodes = groups.slice(i + 1).flatMap((g) => g.nodes);
    const prevEnd = maxIso(prevNodes.map((n) => n.thought?.finishedAt ?? n.step?.finishedAt));
    const nextStart = minIso(nextNodes.map((n) => n.thought?.startedAt ?? n.step?.startedAt));
    const startedAt =
      minIso([...thoughts.map((t) => t.startedAt), ...steps.map((s) => s.startedAt)]) ??
      prevEnd ??
      activity.startedAt;
    const finishedAt =
      maxIso([...thoughts.map((t) => t.finishedAt), ...steps.map((s) => s.finishedAt)]) ??
      nextStart ??
      activity.finishedAt;

    return (
      <AgentActivityView
        key={group.id}
        {...activity}
        timelineGroup
        startedAt={startedAt}
        finishedAt={finishedAt}
        promptStartedAt={i === 0 ? activity.promptStartedAt : undefined}
        isRunning={!!activity.isRunning && tail}
        runStatus={tail ? activity.runStatus : 'completed'}
        reasoningBlocks={thoughts}
        toolSteps={steps}
        pendingApprovals={tail ? activity.pendingApprovals : []}
        pendingElicitations={tail ? activity.pendingElicitations : []}
        visionActivities={tail ? activity.visionActivities : []}
        compactions={tail ? activity.compactions : []}
      />
    );
  };

  return (
    <>
      {leading.map((g, idx) => renderGroup(g, idx))}
      {errorElement}
      {rest.length > 0 ? (
        <AgentMessageView text={text} isStreaming={activity.isRunning} usage={usage} onRetry={onRetry}>
          {rest.map((g, idx) => renderGroup(g, leading.length + idx))}
        </AgentMessageView>
      ) : null}
    </>
  );
}

export function LiveResponseTimeline({
  live,
  promptStartedAt,
  errorElement,
  ...handlers
}: {
  live: LiveRunState;
  promptStartedAt?: string;
  errorElement?: React.ReactNode;
} & Pick<AgentActivityViewProps, 'onResolveApproval' | 'onResolveElicitation'>) {
  return (
    <ResponseTimeline
      nodes={liveTimeline(live)}
      text={live.textBlocks.map((b) => b.text).filter(Boolean).join('\n\n')}
      usage={live.usage}
      errorElement={errorElement}
      activity={{
        ...handlers,
        ...live,
        ...live.run,
        runId: live.run.id,
        startedAt: live.run.createdAt,
        finishedAt: live.run.updatedAt,
        promptStartedAt,
        isRunning: live.run.status === 'queued' || live.run.status === 'running',
        runStatus: live.run.status,
      }}
    />
  );
}
