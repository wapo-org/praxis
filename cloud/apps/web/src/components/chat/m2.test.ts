import { describe, it, expect } from 'vitest';
import { MessageSchema } from '@praxis/protocol';
import fixture from '../../../../../packages/agent/src/hello-replay.json';
import { messageTurns } from './messageTurns';
import { extractMessageToolSteps } from './messageTools';
import { savedTimeline } from './ResponseTimeline';
import { toolDisplay } from './toolDisplay';
import { toolRowCopy } from './toolRowCopy';
import { workEntry } from './WorkEntry.logic';

describe('owner Hello fixture', () => {
  const messages = fixture.messages.map((m, i) =>
    MessageSchema.parse({
      ...m,
      type: 'message',
      id: String(i),
      chatId: 'hello',
      runId: i ? 'run' : undefined,
      createdAt: '2026-11-13T00:00:00Z',
      updatedAt: '2026-11-13T00:00:20Z',
    }),
  );

  it('joins tool-result-only user messages and preserves every text/tool boundary', () => {
    const turns = messageTurns(messages);
    expect(turns).toHaveLength(2);
    const turn = turns[1]!;
    const nodes = savedTimeline(turn, extractMessageToolSteps(turn));
    expect(nodes.map((n) => (n.text !== undefined ? 'text' : n.step ? 'tool' : 'reasoning'))).toEqual([
      'reasoning',
      'reasoning',
      'text',
      'tool',
      'reasoning',
      'text',
      'tool',
      'reasoning',
      'text',
    ]);
  });

  it('humanises every label path, including legacy presentation/status text', () => {
    const turn = messageTurns(messages)[1]!;
    for (const step of extractMessageToolSteps(turn)) {
      step.running = true;
      step.statusText = 'Running ' + step.activity.name;
      const labels = [
        toolDisplay(step).title,
        toolDisplay(step).detail,
        toolRowCopy(step).title,
        toolRowCopy(step).summary,
        workEntry(step).title,
        workEntry(step).preview,
        step.activity.presentation?.runningTitle,
        step.activity.presentation?.finishedTitle,
      ];
      for (const label of labels) expect(label ?? '').not.toMatch(/mcp__|_[0-9a-f]{8,}|[0-9]{9,}/);
    }
  });
});
