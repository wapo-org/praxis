import type { RunEvent, RunSnapshot } from '@praxis/protocol';
import React from 'react';
import { snapshotProgress } from '../lib/toolProgress';
import { reconcileMessages } from './reconcileMessages';

import type { ActiveElicitation, LiveRunState } from './types';
import type { PraxisState } from './usePraxisState';

function nextOrder(live: LiveRunState): number {
  return (
    Math.max(
      0,
      ...live.textBlocks.map((b) => b.timelineOrder ?? 0),
      ...live.reasoningBlocks.map((b) => b.timelineOrder ?? 0),
      ...live.toolSteps.map((s) => s.timelineOrder ?? 0),
    ) + 1
  );
}

export function useRunState(state: PraxisState) {
  const { setMessagesByChat, setLiveRunsByChat } = state;
  const applySnapshotToLiveRun = React.useCallback((snapshot: RunSnapshot) => {
    const blocks = snapshot.blocks.map((b, i) => ({ ...b, timelineOrder: i * 2 }));
    const stepSize = 0.5 / (snapshot.tools.length + 1);
    const toolOrders = new Array<number>(snapshot.tools.length);
    let nextToolOrder = snapshot.blocks.length * 2 + snapshot.tools.length;
    for (let j = snapshot.tools.length - 1; j >= 0; j--) {
      const toolId = snapshot.tools[j]!.activity.id;
      const afterIdx = snapshot.blocks.findIndex((b) => b.afterToolCallId === toolId);
      const order = afterIdx >= 0 ? afterIdx * 2 - 1 : nextToolOrder - stepSize;
      toolOrders[j] = order;
      nextToolOrder = order;
    }

    setLiveRunsByChat((prev) => ({
      ...prev,
      [snapshot.run.chatId]: {
        run: snapshot.run,
        lastEventId: snapshot.lastEventId,
        textBlocks: blocks.filter((b) => b.type === 'text'),
        reasoningBlocks: blocks.filter((b) => b.type === 'reasoning'),
        toolSteps: snapshot.tools.map((t, j) => ({
          callId: t.activity.id,
          activity: t.activity,
          argumentsJson: t.argumentsJson,
          running: t.running,
          ...snapshotProgress(t),
          completion: t.completion,
          timelineOrder: toolOrders[j],
        })),
        pendingApprovals: snapshot.pendingApprovals,
        pendingElicitations: snapshot.pendingElicitations as ActiveElicitation[],
        visionActivities: [],
        compactions: [],
        usage: snapshot.usage,
      },
    }));
    if (snapshot.messages.length > 0) {
      setMessagesByChat((prev) => ({
        ...prev,
        [snapshot.run.chatId]: reconcileMessages(prev[snapshot.run.chatId] ?? [], snapshot.messages),
      }));
    }
  }, []);

  const handleRunEvent = React.useCallback((envelope: RunEvent) => {
    const { chatId, runId, id: eventId, event } = envelope;

    if (event.type === 'messages.committed') {
      setMessagesByChat((prev) => ({ ...prev, [chatId]: reconcileMessages(prev[chatId] ?? [], event.messages) }));
    }

    setLiveRunsByChat((prev) => {
      const current: LiveRunState = prev[chatId] ?? {
        run: {
          type: 'run',
          id: runId,
          chatId,
          status: 'running',
          createdAt: envelope.createdAt,
          updatedAt: envelope.createdAt,
          lastEventId: eventId,
        },
        lastEventId: 0,
        textBlocks: [],
        reasoningBlocks: [],
        toolSteps: [],
        pendingApprovals: [],
        pendingElicitations: [],
        visionActivities: [],
        compactions: [],
      };

      const next: LiveRunState = {
        ...current,
        lastEventId: Math.max(current.lastEventId, eventId),
        run: {
          ...current.run,
          lastEventId: Math.max(current.run.lastEventId, eventId),
          updatedAt: envelope.createdAt,
        },
        textBlocks: [...current.textBlocks],
        reasoningBlocks: [...current.reasoningBlocks],
        toolSteps: [...current.toolSteps],
        pendingApprovals: [...current.pendingApprovals],
        pendingElicitations: [...current.pendingElicitations],
        visionActivities: [...current.visionActivities],
        compactions: [...current.compactions],
      };

      switch (event.type) {
        case 'run.started':
          next.run.status = 'running';
          break;
        case 'text.delta': {
          const idx = next.textBlocks.findIndex((b) => b.id === event.blockId);
          if (idx >= 0) {
            const prevBlock = next.textBlocks[idx]!;
            next.textBlocks[idx] = {
              ...prevBlock,
              text: prevBlock.text + event.text,
            };
          } else {
            next.textBlocks.push({
              id: event.blockId,
              text: event.text,
              finished: false,
              timelineOrder: nextOrder(next),
            });
          }
          break;
        }
        case 'text.finished': {
          const idx = next.textBlocks.findIndex((b) => b.id === event.blockId);
          if (idx >= 0) {
            next.textBlocks[idx] = { ...next.textBlocks[idx]!, finished: true };
          }
          break;
        }
        case 'reasoning.delta': {
          const idx = next.reasoningBlocks.findIndex((b) => b.id === event.blockId);
          const old = next.reasoningBlocks[idx];
          const block = {
            ...old,
            id: event.blockId,
            text: (old?.text ?? '') + event.text,
            finished: false,
            shape: event.shape ?? old?.shape,
            redacted: event.redacted ?? old?.redacted,
            startedAt: old?.startedAt ?? envelope.createdAt,
            afterToolCallId: old?.afterToolCallId ?? next.toolSteps.at(-1)?.callId,
            timelineOrder: old?.timelineOrder ?? nextOrder(next),
          };
          if (idx < 0) next.reasoningBlocks.push(block);
          else next.reasoningBlocks[idx] = block;
          break;
        }
        case 'reasoning.finished': {
          const idx = next.reasoningBlocks.findIndex((b) => b.id === event.blockId);
          const old = next.reasoningBlocks[idx];
          if (old) {
            next.reasoningBlocks[idx] = {
              ...old,
              finished: true,
              shape: event.shape ?? old.shape,
              finishedAt: envelope.createdAt,
              durationMs: Math.max(
                0,
                Date.parse(envelope.createdAt) - Date.parse(old.startedAt ?? envelope.createdAt),
              ),
            };
          }
          break;
        }
        case 'tool.started':
        case 'tool.ready': {
          const idx = next.toolSteps.findIndex((s) => s.callId === event.activity.id);
          const argsStr =
            event.activity.arguments !== undefined
              ? JSON.stringify(event.activity.arguments, null, 2)
              : '';
          if (idx >= 0) {
            const existing = next.toolSteps[idx]!;
            next.toolSteps[idx] = {
              ...existing,
              activity: event.activity,
              argumentsJson: argsStr || existing.argumentsJson,
              startedAt: existing.startedAt ?? envelope.createdAt,
              timelineOrder: existing.timelineOrder ?? nextOrder(next),
            };
          } else {
            next.toolSteps.push({
              callId: event.activity.id,
              activity: event.activity,
              argumentsJson: argsStr,
              running: event.type === 'tool.started',
              progressLines: [],
              startedAt: envelope.createdAt,
              timelineOrder: nextOrder(next),
            });
          }
          break;
        }
        case 'tool.arguments.delta': {
          const idx = next.toolSteps.findIndex((s) => s.callId === event.callId);
          if (idx >= 0) {
            const existing = next.toolSteps[idx]!;
            next.toolSteps[idx] = {
              ...existing,
              argumentsJson: existing.argumentsJson + event.json,
            };
          }
          break;
        }
        case 'tool.running': {
          const idx = next.toolSteps.findIndex((s) => s.callId === event.callId);
          if (idx >= 0) {
            const existing = next.toolSteps[idx]!;
            next.toolSteps[idx] = {
              ...existing,
              running: true,
              startedAt: existing.startedAt ?? envelope.createdAt,
            };
          }
          break;
        }
        case 'tool.progress': {
          const idx = next.toolSteps.findIndex((s) => s.callId === event.callId);
          if (idx >= 0) {
            const existing = next.toolSteps[idx]!;
            const lines = [...existing.progressLines];
            if (event.text) lines.push(event.text);
            if (event.lines) lines.push(...event.lines);
            next.toolSteps[idx] = {
              ...existing,
              progressLines: lines,
              ...(event.kind === 'status'
                ? { statusText: event.text ?? event.lines?.join(' ') }
                : {}),
            };
          }
          break;
        }
        case 'tool.finished': {
          const idx = next.toolSteps.findIndex((s) => s.callId === event.callId);
          if (idx >= 0) {
            next.toolSteps[idx] = {
              ...next.toolSteps[idx]!,
              running: false,
              finishedAt: envelope.createdAt,
              completion: event.completion,
            };
          }
          break;
        }
        case 'approval.requested':
          next.run.status = 'awaitingApproval';
          if (!next.pendingApprovals.some((a) => a.id === event.approval.id)) {
            next.pendingApprovals.push(event.approval);
          }
          break;
        case 'approval.resolved':
          next.run.status = 'running';
          next.pendingApprovals = next.pendingApprovals.filter((a) => a.id !== event.approvalId);
          break;
        case 'elicitation.requested':
          next.run.status = 'awaitingElicitation';
          if (!next.pendingElicitations.some((e) => e.id === event.elicitation.id)) {
            next.pendingElicitations.push(event.elicitation as ActiveElicitation);
          }
          break;
        case 'elicitation.resolved':
          next.run.status = 'running';
          next.pendingElicitations = next.pendingElicitations.filter(
            (e) => e.id !== event.elicitationId,
          );
          break;
        case 'vision.activity': {
          const idx = next.visionActivities.findIndex((v) => v.id === event.id);
          const entry = {
            id: event.id,
            phase: event.phase,
            attachmentId: event.attachmentId,
            modelId: event.modelId,
            question: event.question,
            answer: event.answer,
          };
          if (idx >= 0) next.visionActivities[idx] = entry;
          else next.visionActivities.push(entry);
          break;
        }
        case 'compaction': {
          const idx = next.compactions.findIndex((c) => c.id === event.id);
          const entry = {
            id: event.id,
            phase: event.phase,
            summary: event.summary,
          };
          if (idx >= 0) next.compactions[idx] = entry;
          else next.compactions.push(entry);
          break;
        }
        case 'usage':
          next.usage = event.usage;
          break;
        case 'run.finished':
          next.textBlocks = next.textBlocks.map((b) => ({ ...b, finished: true }));
          next.reasoningBlocks = next.reasoningBlocks.map((b) => ({
            ...b,
            finished: true,
            finishedAt: b.finishedAt ?? envelope.createdAt,
          }));
          next.toolSteps = next.toolSteps.map((s) =>
            s.running ? { ...s, running: false, finishedAt: s.finishedAt ?? envelope.createdAt } : s,
          );
          next.run.status =
            event.outcome === 'failed'
              ? 'failed'
              : event.outcome === 'cancelled'
                ? 'cancelled'
                : 'completed';
          next.run.outcome = event.outcome;
          if (event.message && event.outcome === 'failed') {
            next.run.error = event.message;
          }
          break;
      }

      return { ...prev, [chatId]: next };
    });
  }, []);

  return { applySnapshotToLiveRun, handleRunEvent };
}
