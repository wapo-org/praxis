import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import {CapabilitiesSchema, type Message} from '@praxis/protocol';
import {
  INTERRUPTED_TOOL_TEXT, MessageMappingError, repairDanglingToolCalls, toModelMessages, toStoredMessages,
} from './model-messages.js';
import {buildProviderRequest} from './wire.js';
import {canonical} from './policy.js';
import {capturedChat, committedTurns, legacyShapes, promptWithAttachments} from './message-corpus.js';

const TIME = '2026-11-17T12:00:00.000Z';
const roundTrip = (messages: Message[]) => toStoredMessages(toModelMessages(messages));

async function corpus(): Promise<Message[]> {
  return [...capturedChat(), promptWithAttachments('prompt-1'), ...await committedTurns(), ...legacyShapes()];
}

describe('message mapper round trip', () => {
  it('stored → model view → stored equals the original for every corpus message and the whole chat', async () => {
    const messages = await corpus();
    expect(messages.map(m => m.parts.map(p => p.type)).flat()).toEqual(expect.arrayContaining(
      ['text', 'note', 'image', 'document', 'reasoning', 'toolCall', 'toolResult'],
    ));
    expect(roundTrip(messages)).toEqual(messages);
    for (const message of messages) expect(roundTrip([message])).toEqual([message]);
  });

  it('holds for any ordered selection of corpus messages, byte for byte', async () => {
    const messages = await corpus();
    await fc.assert(fc.property(fc.subarray(messages.map((_, index) => index)), indexes => {
      const chat = indexes.map(index => messages[index]!);
      expect(canonical(roundTrip(chat))).toBe(canonical(chat));
    }), {numRuns: 200, seed: 43});
  });

  it('keeps raw provider payloads and Anthropic signatures, so reasoning replays unchanged', async () => {
    const chat = capturedChat();
    const signed = chat.flatMap(m => m.parts).filter(p => p.type === 'reasoning' && p.data);
    expect(signed.length).toBeGreaterThan(0);
    const committed = await committedTurns();
    const reasoning = committed.find(m => (m.raw?.data as {reasoning_details?: unknown[]} | undefined)?.reasoning_details);
    expect(reasoning).toBeDefined();
    expect(roundTrip([reasoning!])[0]!.raw).toEqual(reasoning!.raw);
    const wire = buildProviderRequest({
      model: 'm', system: 'S', messages: [promptWithAttachments('p'), reasoning!], tools: [],
      capabilities: CapabilitiesSchema.parse({tools: true}), maxTokens: 8,
    });
    expect((wire.messages as unknown[]).at(-1)).toEqual(reasoning!.raw!.data);
  });
});

describe('message mapper fails closed', () => {
  const base = {type: 'message' as const, chatId: 'chat', createdAt: TIME, updatedAt: TIME};
  const cases: Array<[string, Message]> = [
    ['a user reasoning part', {...base, id: 'u', role: 'user', parts: [{type: 'reasoning', text: 'x'}]}],
    ['a user tool call', {...base, id: 'u', role: 'user', parts: [{type: 'toolCall', callId: 'c', name: 'n'}]}],
    ['an assistant note', {...base, id: 'a', role: 'assistant', parts: [{type: 'note', text: 'x'}]}],
    ['an assistant document', {...base, id: 'a', role: 'assistant', parts: [{type: 'document', attachmentId: 'd'}]}],
    ['results before a response', {...base, id: 'a', role: 'assistant', parts: [{type: 'toolResult', callId: 'c'}, {type: 'text', text: 'x'}]}],
    ['results after user text', {...base, id: 'u', role: 'user', parts: [{type: 'text', text: 'x'}, {type: 'toolResult', callId: 'c'}]}],
  ];
  it.each(cases)('rejects %s', (_name, message) => {
    expect(() => toModelMessages([message])).toThrow(MessageMappingError);
  });

  it('rejects rows MessageSchema rejects and duplicate message ids', () => {
    expect(() => toModelMessages([{...base, id: 'x', role: 'system', parts: []} as unknown as Message])).toThrow();
    const message: Message = {...base, id: 'same', role: 'user', parts: [{type: 'text', text: 'x'}]};
    expect(() => toModelMessages([message, message])).toThrow(/duplicate message id/);
  });
});

describe('dangling tool calls', () => {
  const call = (id: string, ids: string[]): Message => ({type: 'message', id, chatId: 'chat', role: 'assistant',
    createdAt: TIME, updatedAt: TIME, parts: ids.map(callId => ({type: 'toolCall', callId, name: 'read', arguments: '{}'}))});
  const result = (id: string, callId: string): Message => ({type: 'message', id, chatId: 'chat', role: 'user',
    createdAt: TIME, updatedAt: TIME, parts: [{type: 'toolResult', callId, name: 'read', content: []}]});

  it('answers an unanswered call with a synthetic interrupted result right after its response', () => {
    const history = [call('a', ['c1', 'c2']), result('r', 'c1'), promptWithAttachments('next')];
    const repaired = toStoredMessages(repairDanglingToolCalls(toModelMessages(history)));
    expect(repaired[0]!.parts.map(p => [p.type, p.callId])).toEqual([['toolCall', 'c1'], ['toolCall', 'c2'], ['toolResult', 'c2']]);
    expect(repaired[0]!.parts[2]).toMatchObject({isError: true, name: 'read', content: [{type: 'text', text: INTERRUPTED_TOOL_TEXT}]});
    expect(repaired.slice(1)).toEqual(history.slice(1));
  });

  it('is a no-op on answered history and idempotent, so every later turn rebuilds the same bytes', async () => {
    const answered = await corpus();
    expect(repairDanglingToolCalls(toModelMessages(answered))).toEqual(toModelMessages(answered));
    const once = repairDanglingToolCalls(toModelMessages([call('a', ['c1'])]));
    expect(repairDanglingToolCalls(toModelMessages(toStoredMessages(once)))).toEqual(once);
  });
});

describe('wire projection of assistant-role tool results', () => {
  it('replays the raw response, then one tool message per result in call order', async () => {
    const committed = await committedTurns();
    const tool = committed.findIndex(m => m.parts.some(p => p.type === 'toolResult'));
    const wire = buildProviderRequest({
      model: 'm', system: 'S', messages: [promptWithAttachments('p'), committed[tool - 1]!, committed[tool]!], tools: [],
      capabilities: CapabilitiesSchema.parse({tools: true}), maxTokens: 8,
    });
    const roles = (wire.messages as Array<{role: string; tool_call_id?: string}>).map(m => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
    expect((wire.messages as Array<{tool_call_id?: string}>)[3]!.tool_call_id).toBe('toolu_01ReadHello');
  });
});
