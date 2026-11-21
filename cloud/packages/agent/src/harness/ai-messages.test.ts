import {describe, expect, it} from 'vitest';
import fc from 'fast-check';
import type {Message} from '@praxis/protocol';
import {canonical} from '../policy.js';
import {MessageMappingError, toModelMessages, toStoredMessages} from '../model-messages.js';
import {capturedChat, committedTurns, harnessTurns, legacyShapes, promptWithAttachments} from '../message-corpus.js';
import {fromAiMessages, jsonView, requestMessages, toAiMessages, PRAXIS_OPTIONS} from './ai-messages.js';

const TIME = '2026-11-17T12:00:00.000Z';
/** stored → model view → AI SDK messages (as JSON, like a step argument) → model view → stored. */
const roundTrip = (messages: Message[]) => toStoredMessages(fromAiMessages(JSON.parse(JSON.stringify(toAiMessages(toModelMessages(messages))))));

async function corpus(): Promise<Message[]> {
  return [...capturedChat(), promptWithAttachments('prompt-1'), ...await committedTurns(), ...await harnessTurns(), ...legacyShapes()];
}

describe('stored messages ⇄ AI SDK messages', () => {
  it('round trip equals the original for every corpus message and the whole chat', async () => {
    const messages = await corpus();
    expect(messages.flatMap(m => m.parts.map(p => p.type))).toEqual(expect.arrayContaining(
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
    }), {numRuns: 200, seed: 169});
  });

  it('puts stored reasoning_details on the assistant message, where OpenRouter replays them with signatures', async () => {
    const chat = [...capturedChat(), ...await harnessTurns()];
    const signed = chat.filter(m => Array.isArray((m.raw?.data as {reasoning_details?: unknown} | undefined)?.reasoning_details));
    expect(signed.length).toBeGreaterThan(0);
    for (const message of signed) {
      const [ai] = toAiMessages(toModelMessages([message]));
      const details = (message.raw!.data as {reasoning_details: unknown}).reasoning_details;
      expect(ai!.providerOptions?.openrouter).toEqual({reasoning_details: details});
      expect(JSON.stringify(details)).toContain('signature');
    }
  });

  it('renders the model view: notes as text, references as placeholders, results as tool messages', async () => {
    const [user] = requestMessages([promptWithAttachments('p')]);
    expect(user).toMatchObject({role: 'user', content: [
      {type: 'text', text: '[Note]\nCurrent mode: build. Effort: high.'}, {type: 'text', text: 'What is in these files?'},
      {type: 'text', text: '[image p-image omitted]'}, {type: 'text', text: '[document p-pdf omitted]'},
    ]});
    const turns = await harnessTurns();
    const view = requestMessages([promptWithAttachments('p'), ...turns.slice(0, 2)]);
    expect(view.map(m => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(view[2]).toMatchObject({role: 'tool', content: [{type: 'tool-result', toolCallId: 'corpus-call', output: {type: 'text', value: 'external'}}]});
    expect(jsonView(view)).toBeTruthy();
  });

  it('sends rehydrated bytes as image and file parts, and drops empty responses from the request only', () => {
    const rehydrated: Message = {...promptWithAttachments('r'), parts: [
      {type: 'image', attachmentId: 'r-image', mediaType: 'image/png', data: 'aW1hZ2U='},
      {type: 'document', attachmentId: 'r-pdf', mediaType: 'application/pdf', data: 'cGRm'},
    ]};
    const [user] = requestMessages([rehydrated, ...legacyShapes().slice(2)]);
    expect(user).toMatchObject({role: 'user', content: [
      {type: 'image', image: 'aW1hZ2U=', mediaType: 'image/png'}, {type: 'file', data: 'cGRm', mediaType: 'application/pdf'},
    ]});
    expect(requestMessages([rehydrated, ...legacyShapes().slice(2)])).toHaveLength(1);
    expect(roundTrip([rehydrated])).toEqual([rehydrated]);
  });

  it('carries only what the AI part cannot express', async () => {
    const [ai] = toAiMessages(toModelMessages([{type: 'message', id: 'a', chatId: 'chat', role: 'assistant',
      createdAt: TIME, updatedAt: TIME, parts: [{type: 'text', text: 'plain'}]}]));
    expect(ai!.content).toEqual([{type: 'text', text: 'plain'}]);
    expect(Object.keys(ai!.providerOptions ?? {})).toEqual([PRAXIS_OPTIONS]);
  });
});

describe('the request history fails closed', () => {
  const base = {type: 'message' as const, chatId: 'chat', createdAt: TIME, updatedAt: TIME};
  const cases: Array<[string, Message]> = [
    ['a user reasoning part', {...base, id: 'u', role: 'user', parts: [{type: 'reasoning', text: 'x'}]}],
    ['an assistant note', {...base, id: 'a', role: 'assistant', parts: [{type: 'note', text: 'x'}]}],
    ['results before a response', {...base, id: 'a', role: 'assistant', parts: [{type: 'toolResult', callId: 'c'}, {type: 'text', text: 'x'}]}],
  ];
  it.each(cases)('rejects %s', (_name, message) => {
    expect(() => requestMessages([message])).toThrow(MessageMappingError);
  });

  it('rejects rows MessageSchema rejects', () => {
    expect(() => requestMessages([{...base, id: 'x', role: 'system', parts: []} as unknown as Message])).toThrow();
  });
});
