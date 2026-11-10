import type { Message } from '@praxis/protocol';
import { describe, expect, it } from 'vitest';
import { reconcileMessages } from './reconcileMessages';

const at = (s: number) => new Date(Date.UTC(2026, 10, 10, 12, 0, s)).toISOString();
const msg = (id: string, role: Message['role'], parts: Message['parts'], s: number, clientTurnId = 'turn-1'): Message =>
  ({ type: 'message', id, chatId: 'c', role, parts, clientTurnId, createdAt: at(s), updatedAt: at(s) }) as Message;
const optimistic = msg('optimistic-turn-1', 'user', [{ type: 'text', text: "what's here" }, { type: 'document', attachmentId: 'a1' }], 1);
const prompt = msg('u1', 'user', [{ type: 'text', text: "what's here" }], 1);
const call = msg('m1', 'assistant', [{ type: 'toolCall', callId: 'x', name: 'run_javascript', arguments: '{}' }], 2);
const result = msg('m2', 'user', [{ type: 'toolResult', callId: 'x', content: [] }], 3);

describe('reconcileMessages', () => {
  it('replaces the optimistic prompt with the committed prompt of the same turn', () => {
    expect(reconcileMessages([optimistic], [prompt, call]).map((m) => m.id)).toEqual(['u1', 'm1']);
  });
  it('keeps the prompt when a tool result of the same turn is committed (the vanishing message)', () => {
    const afterPrompt = reconcileMessages([optimistic], [prompt, call]);
    expect(reconcileMessages(afterPrompt, [result]).map((m) => m.id)).toEqual(['u1', 'm1', 'm2']);
  });
  it('keeps the optimistic prompt until its own prompt is committed, even when a tool result arrives first', () => {
    expect(reconcileMessages([optimistic], [result]).map((m) => m.id)).toEqual(['optimistic-turn-1', 'm2']);
  });
  it('never removes a committed message by turn ID, only by its own ID', () => {
    const older = msg('u0', 'user', [{ type: 'text', text: 'hello' }], 0, 'turn-0');
    expect(reconcileMessages([older, prompt], [msg('u1', 'user', [{ type: 'text', text: 'edited' }], 1)]).map((m) => m.parts[0]?.text)).toEqual(['hello', 'edited']);
  });
});
