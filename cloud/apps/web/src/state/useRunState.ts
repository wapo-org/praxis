import type { Message, RunEvent, RunSnapshot } from '@praxis/protocol';
import React from 'react';
import { snapshotProgress } from '../lib/toolProgress';

import type { ActiveElicitation, LiveRunState } from './types';
import type { PraxisState } from './usePraxisState';
export function useRunState(state: PraxisState) {
  const { setMessagesByChat, setLiveRunsByChat } = state;
  const applySnapshotToLiveRun = React.useCallback((snapshot: RunSnapshot) => {
    setLiveRunsByChat((prev) => ({
      ...prev,
      [snapshot.run.chatId]: {
        run: snapshot.run,
        lastEventId: snapshot.lastEventId,
        textBlocks: snapshot.blocks
          .filter((b) => b.type === 'text')
          .map((b) => ({ id: b.id, text: b.text, finished: b.finished })),
        reasoningBlocks: snapshot.blocks
          .filter((b) => b.type === 'reasoning')
          .map((b) => ({ id: b.id, text: b.text, finished: b.finished })),
        toolSteps: snapshot.tools.map((t) => ({
          callId: t.activity.id,
          activity: t.activity,
          argumentsJson: t.argumentsJson,
          running: t.running,
          ...snapshotProgress(t),
          completion: t.completion,
        })),
        pendingApprovals: snapshot.pendingApprovals,
        pendingElicitations: snapshot.pendingElicitations as ActiveElicitation[],
        visionActivities: [],
        compactions: [],
        usage: snapshot.usage,
      },
    }));
    if (snapshot.messages.length > 0) {
      setMessagesByChat((prev) => {
        const existing = prev[snapshot.run.chatId] ?? [];
        const byId = new Map<string, Message>();
        for (const m of existing) byId.set(m.id, m);
        for (const m of snapshot.messages) byId.set(m.id, m);
        const merged = Array.from(byId.values()).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        return { ...prev, [snapshot.run.chatId]: merged };
      });
    }
  }, []);

  const handleRunEvent = React.useCallback((envelope: RunEvent) => {
    const { chatId, runId, id: eventId, event } = envelope;

    if (event.type === 'messages.committed') {
      setMessagesByChat((prev) => {
        const existing = prev[chatId] ?? [];
        const byId = new Map<string, Message>();
        for (const m of existing) {
          // Replace optimistic turn if clientTurnId matches
          const committedMatch = event.messages.find(
            (cm) => cm.clientTurnId && cm.clientTurnId === m.clientTurnId && cm.role === m.role,
          );
          if (!committedMatch) {
            byId.set(m.id, m);
          }
        }
        for (const m of event.messages) {
          byId.set(m.id, m);
        }
        const merged = Array.from(byId.values()).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        return { ...prev, [chatId]: merged };
      });
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
          if (idx >= 0) {
            const prevBlock = next.reasoningBlocks[idx]!;
            next.reasoningBlocks[idx] = {
              ...prevBlock,
              text: prevBlock.text + event.text,
            };
          } else {
            next.reasoningBlocks.push({
              id: event.blockId,
              text: event.text,
              finished: false,
            });
          }
          break;
        }
        case 'reasoning.finished': {
          const idx = next.reasoningBlocks.findIndex((b) => b.id === event.blockId);
          if (idx >= 0) {
            next.reasoningBlocks[idx] = {
              ...next.reasoningBlocks[idx]!,
              finished: true,
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
            };
          } else {
            next.toolSteps.push({
              callId: event.activity.id,
              activity: event.activity,
              argumentsJson: argsStr,
              running: event.type === 'tool.started',
              progressLines: [],
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
            next.toolSteps[idx] = { ...next.toolSteps[idx]!, running: true };
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
