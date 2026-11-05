import type { Message } from '@praxis/protocol';
import type { ActiveToolStep } from '../../state/store';
/** Tool calls and their results across a turn's messages; a result may arrive in a later message. */
export function extractToolSteps(messages: Message[]): ActiveToolStep[] {
  const byCallId = new Map<string, ActiveToolStep>();
  for (const part of messages.flatMap((message) => message.parts)) {
    if (part.type === 'toolCall' && part.callId) {
      byCallId.set(part.callId, {
        callId: part.callId,
        activity: {
          type: 'tool.activity',
          id: part.callId,
          name: part.name || 'tool',
          source: { type: 'builtin' },
          presentation: {
            type: 'tool.presentation',
            category: 'other',
            runningTitle: part.name || 'Running tool',
            finishedTitle: part.name || 'Completed tool',
          },
        },
        argumentsJson: part.arguments ?? '{}',
        running: false,
        progressLines: [],
      });
    } else if (part.type === 'toolResult' && part.callId) {
      const existing = byCallId.get(part.callId);
      const preview = part.text ?? (part.content ? JSON.stringify(part.content) : '');
      const completion = {
        type: 'tool.completion' as const,
        status: part.isError ? ('failed' as const) : ('succeeded' as const),
        summary: part.isError ? 'Tool failed' : 'Tool completed',
        preview,
        outputRef: part.outputRef,
      };
      if (existing) {
        existing.completion = completion;
      } else {
        byCallId.set(part.callId, {
          callId: part.callId,
          activity: {
            type: 'tool.activity',
            id: part.callId,
            name: part.name || 'tool',
            source: { type: 'builtin' },
            presentation: {
              type: 'tool.presentation',
              category: 'other',
              runningTitle: part.name || 'Running tool',
              finishedTitle: part.name || 'Completed tool',
            },
          },
          argumentsJson: '{}',
          running: false,
          progressLines: [],
          completion,
        });
      }
    }
  }
  return Array.from(byCallId.values());
}

