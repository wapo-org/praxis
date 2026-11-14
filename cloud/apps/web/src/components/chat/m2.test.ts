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

  it('places snapshot-only steps in snapshot order ahead of text instead of appending a trailing group', () => {
    const turn = MessageSchema.parse({
      type: 'message',
      id: 'm1',
      chatId: 'c1',
      runId: 'r1',
      role: 'assistant',
      createdAt: '2026-11-13T00:00:00Z',
      updatedAt: '2026-11-13T00:00:10Z',
      parts: [
        { type: 'toolCall', callId: 'real-call', name: 'local_echo', arguments: '{}' },
        { type: 'text', text: 'Done.' },
      ],
    });
    const baseStep = extractMessageToolSteps(turn)[0]!;
    const extra1 = { ...baseStep, callId: 'extra-1', activity: { ...baseStep.activity, id: 'extra-1' } };
    const extra2 = { ...baseStep, callId: 'extra-2', activity: { ...baseStep.activity, id: 'extra-2' } };
    const nodes = savedTimeline(turn, [extra1, extra2, baseStep]);
    expect(nodes.map((n) => n.id)).toEqual(['extra-1', 'extra-2', 'real-call', 'm1-1']);
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

  it('times saved tool steps from their message commit times, not the reasoning blocks', () => {
    // Real gaps from the owner's Hello chat: the call commits with the assistant message, the result with the tool-result message.
    const at = ['00:45:39.537', '00:46:09.873', '00:46:11.924', '00:46:39.599', '00:46:43.772', '00:46:50.343'];
    const timed = messages.map((m, i) => ({ ...m, parts: m.parts.map((p) => ({ ...p })), createdAt: `2026-11-13T${at[i]}Z` }));
    const turn = messageTurns(timed)[1]!;
    const steps = extractMessageToolSteps(turn);
    expect(steps.map((s) => [s.startedAt, s.finishedAt])).toEqual([
      ['2026-11-13T00:46:09.873Z', '2026-11-13T00:46:11.924Z'],
      ['2026-11-13T00:46:39.599Z', '2026-11-13T00:46:43.772Z'],
    ]);
  });
});
