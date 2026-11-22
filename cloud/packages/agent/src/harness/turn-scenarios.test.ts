import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import type {Message, MessagePart} from '@praxis/protocol';
import {argsHash, issueApproval} from '../boundary/receipt.js';
import {INTERRUPTED_TOOL_TEXT} from '../model-messages.js';
import {canonical} from '../policy.js';
import {MEDIA_CONCURRENCY, rehydrateMessages} from '../request-transforms.js';
import {UncertainToolCall} from './turn.js';
import {prompt, scenario, SCENARIO_NOW_MS, SCENARIO_TIME} from './turn-fixture.js';

const parts = (messages: Message[], type: MessagePart['type']) => messages.flatMap(m => m.parts).filter(p => p.type === type);
const signature = {text: 'Plan the reply.', signature: 'sig-anthropic-1'};
type Prompt = Array<{role: string; content: unknown}>;
const promptOf = (s: Awaited<ReturnType<typeof scenario>>, call: number) => s.model.calls[call]!.prompt as unknown as Prompt;

describe('scripted scenarios on the fake model through the AI SDK', () => {
  it('text: one model call, one assistant message with signed reasoning and usage, done', async () => {
    const s = await scenario([{text: 'Hi there.', reasoning: signature}]);
    expect(await s.untilDone()).toMatchObject({end: {status: 'completed'}, usage: {cost: 0.0001}});
    expect(s.outputs[0]?.messages).toEqual([expect.objectContaining({
      id: 'msg-0', role: 'assistant', runId: 'run', createdAt: SCENARIO_TIME,
      parts: [{type: 'reasoning', ...signature}, {type: 'text', text: 'Hi there.'}],
      raw: {type: 'provider.payload', data: expect.objectContaining({reasoning_details: [expect.objectContaining({signature: 'sig-anthropic-1'})]})},
    })]);
    expect(s.model.calls).toHaveLength(1);
  });

  it('tools: a turn stops after the call and its result; the next turn replays signed reasoning and finishes', async () => {
    const s = await scenario([{calls: [{id: 'c1', name: 'echo', args: {say: 'hi'}}], reasoning: signature}, {text: 'Echoed.'}]);
    expect(await s.run()).toMatchObject({state: 'output', output: {end: {status: 'ready'}}});
    expect(s.outputs[0]?.messages.map(m => m.parts.map(p => p.type))).toEqual([['reasoning', 'toolCall'], ['toolResult']]);
    await s.untilDone();
    const second = promptOf(s, 1);
    expect(second.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(JSON.stringify(second[2])).toContain('sig-anthropic-1');
    expect(second[3]).toMatchObject({content: [{type: 'tool-result', toolCallId: 'c1', output: {type: 'text', value: '{"say":"hi"}'}}]});
    expect(s.effects).toEqual({echo: 1});
  });

  it('approval: without a receipt the write is refused as a result; with an exact receipt it runs once', async () => {
    const call = {id: 'w1', name: 'write', args: {note: 'x'}};
    const refused = await scenario([{calls: [call]}, {text: 'Needs approval.'}]);
    await refused.untilDone();
    expect(refused.effects.write).toBeUndefined();
    expect(parts(refused.history(), 'toolResult')[0]).toMatchObject({isError: true, content: [{text: expect.stringContaining('[approval-required]')}]});
    const probe = await scenario([]);
    const receipt = await issueApproval(probe.key, {runId: 'run', toolCallId: 'w1', tool: 'write', argsHash: await argsHash(call.args)}, SCENARIO_NOW_MS + 1, 'n');
    const approved = await scenario([{calls: [call]}, {text: 'Written.'}], {receipts: {w1: receipt}});
    await approved.untilDone();
    expect(approved.effects.write).toBe(1);
  });

  it('nested approval: a nested write is refused before any effect and the outer call stays uncertain', async () => {
    const s = await scenario([{calls: [{id: 'n1', name: 'nested', args: {}}]}]);
    await expect(s.run()).rejects.toBeInstanceOf(UncertainToolCall);
    expect(s.effects).toEqual({nested: 1});
    expect(s.outputs).toHaveLength(0);
    expect(s.ledger().calls.n1).toBeNull();
  });

  it('error: a provider failure commits nothing and saves no response, so the retry calls the model again', async () => {
    const s = await scenario([{error: {status: 500, message: 'Scripted provider error'}}, {text: 'Recovered.'}]);
    await expect(s.run()).rejects.toMatchObject({kind: 'unavailable'});
    expect(s.outputs).toHaveLength(0);
    expect(s.ledger().saved).toBeUndefined();
    await s.untilDone();
    expect(s.model.calls).toHaveLength(2);
  });

  it('long: a long reply is committed whole and its usage once', async () => {
    const text = 'Scripted long response. '.repeat(2_000);
    const s = await scenario([{text}]);
    const output = await s.untilDone();
    expect(parts(output.messages, 'text').at(-1)?.text).toBe(text);
    expect(output.usage.outputTokens).toBe(Math.ceil(text.length / 4));
  });

  it('compaction: no framework summarization; long history is sent whole and the prefix bytes stay equal', async () => {
    const history = Array.from({length: 40}, (_, i) => prompt(`p${i}`, `Turn ${i}: ${'context '.repeat(200)}`));
    const s = await scenario(Array.from({length: 3}, (_, i) => ({calls: [{id: `e${i}`, name: 'echo', args: {}}]})), {history});
    for (let turn = 0; turn < 3; turn++) await s.run();
    const prefix = s.model.calls.map(call => createHash('sha256').update(canonical({
      system: (call.prompt as unknown as Prompt)[0], tools: call.tools,
    })).digest('hex'));
    expect(new Set(prefix).size).toBe(1);
    expect(s.model.calls.map(call => call.prompt.length)).toEqual([41, 43, 45]);
    expect(promptOf(s, 2).slice(0, 41)).toEqual(promptOf(s, 0));
  });

  it('vision: references rehydrate per request, two at a time, while history keeps references; look_at_image emits', async () => {
    const images = Array.from({length: 5}, (_, i): MessagePart => ({type: 'image', attachmentId: `img-${i}`, mediaType: 'image/png'}));
    let active = 0, peak = 0;
    const rehydrate = rehydrateMessages(async part => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      if (part.attachmentId === 'img-4') throw new Error('it was deleted');
      return {...part, data: Buffer.from(`bytes-${part.attachmentId}`).toString('base64')};
    });
    const s = await scenario([{calls: [{id: 'v1', name: 'look_at_image', args: {attachmentId: 'img-0'}}]}, {text: 'A fake image.'}],
      {history: [prompt('p', 'Describe', images)], rehydrate});
    await s.untilDone();
    expect(peak).toBeLessThanOrEqual(MEDIA_CONCURRENCY);
    const sent = (promptOf(s, 0)[1]!.content as Array<{type: string; data?: unknown; text?: string}>);
    expect(sent.slice(1, 5).map(p => p.type)).toEqual(['file', 'file', 'file', 'file']);
    expect(sent[5]).toEqual({type: 'text', text: '[Attachment unavailable: it was deleted]'});
    expect(parts(s.history(), 'image').every(p => p.data === undefined)).toBe(true);
    expect(s.emitted.map(e => e.type === 'vision.activity' ? e.phase : e.type)).toEqual(['started', 'finished']);
  });
});

describe('edge cases', () => {
  it('several calls in one response run sequentially in model order', async () => {
    const calls = ['a', 'b', 'c'].map(id => ({id, name: 'echo', args: {id}}));
    const s = await scenario([{calls}, {text: 'All done.'}]);
    await s.untilDone();
    expect(s.effects.echo).toBe(3);
    expect(s.outputs[0]!.messages[1]!.parts.map(p => p.callId)).toEqual(['a', 'b', 'c']);
  });

  it('a dangling call from a crashed turn reaches the model with a synthetic interrupted result; storage is untouched', async () => {
    const dangling: Message = {type: 'message', id: 'crashed', chatId: 'chat', role: 'assistant', createdAt: SCENARIO_TIME,
      updatedAt: SCENARIO_TIME, parts: [{type: 'toolCall', callId: 'lost', name: 'echo', arguments: '{}'}]};
    const history = [prompt('p1', 'First'), dangling, prompt('p2', 'Again')];
    const s = await scenario([{text: 'Recovered.'}], {history});
    await s.run();
    const sent = promptOf(s, 0);
    expect(sent.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(sent[3]).toMatchObject({content: [{type: 'tool-result', toolCallId: 'lost', output: {type: 'error-text', value: INTERRUPTED_TOOL_TEXT}}]});
    expect(s.history().slice(0, 3)).toEqual(history);
    expect(s.effects).toEqual({});
  });

  it('an unknown tool name becomes an error result and the turn continues', async () => {
    const s = await scenario([{calls: [{id: 'u1', name: 'does_not_exist', args: {}}]}, {text: 'Sorry.'}]);
    expect(await s.untilDone()).toMatchObject({end: {status: 'completed'}});
    expect(parts(s.history(), 'toolResult')[0]).toMatchObject({callId: 'u1', isError: true,
      content: [{text: expect.stringContaining('[policy-denied]')}]});
  });

  it('untrusted reads mark their result and the commit taint, including a failed read', async () => {
    const s = await scenario([{calls: [{id: 'f1', name: 'fetch_missing', args: {}}, {id: 'f2', name: 'fetch', args: {}}]}, {text: 'ok'}]);
    await s.run();
    const output = s.outputs[0]!;
    expect(output.taint).toEqual({tainted: true, source: 'fetch missing', callId: 'f1'});
    expect(output.messages[1]!.parts.map(p => [p.callId, p.isError, p.taintSource])).toEqual([['f1', true, 'fetch missing'], ['f2', false, 'fetch']]);
    expect(output.tainted).toBe(true);
  });

  it('a model without tool support is offered no tools and any call it makes is denied', async () => {
    const s = await scenario([{calls: [{id: 'x', name: 'echo', args: {}}]}, {text: 'ok'}], {toolsEnabled: false});
    await s.untilDone();
    expect(s.model.calls[0]!.tools).toBeUndefined();
    expect(s.effects).toEqual({});
  });
});
