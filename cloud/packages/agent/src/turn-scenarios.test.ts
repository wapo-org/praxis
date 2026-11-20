import {describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import type {Message, MessagePart} from '@praxis/protocol';
import {argsHash, issueApproval} from './boundary/receipt.js';
import {ProviderFailure} from './provider-error.js';
import {UncertainToolCall} from './one-turn.js';
import {INTERRUPTED_TOOL_TEXT} from './model-messages.js';
import {rehydrateAttachments, MEDIA_CONCURRENCY} from './request-transforms.js';
import {canonical} from './policy.js';
import {prompt, scenario, SCENARIO_NOW_MS, SCENARIO_TIME} from './turn-scenarios-fixture.js';

const parts = (messages: Message[], type: MessagePart['type']) => messages.flatMap(m => m.parts).filter(p => p.type === type);
const signature = {text: 'Plan the reply.', signature: 'sig-anthropic-1'};

describe('scripted scenarios on the fake chat model', () => {
  it('text: one model call, one assistant message with signed reasoning and usage, done', async () => {
    const s = await scenario([{text: 'Hi there.', reasoning: signature}]);
    expect(await s.run()).toEqual({turnIndex: 1, status: 'completed', done: true});
    const [output] = s.store.data.outputs;
    expect(output?.messages).toEqual([expect.objectContaining({
      id: 'msg-0', role: 'assistant', runId: 'run', createdAt: SCENARIO_TIME,
      parts: [{type: 'reasoning', ...signature}, {type: 'text', text: 'Hi there.'}],
      raw: {type: 'provider.payload', data: expect.objectContaining({reasoning_details: [expect.objectContaining({signature: 'sig-anthropic-1'})]})},
    })]);
    expect(output?.usage).toMatchObject({cost: 0.0001});
    expect(s.model.requests).toHaveLength(1);
  });

  it('tools: a turn stops after the call and its result; the next turn sees the result and finishes', async () => {
    const s = await scenario([{calls: [{id: 'c1', name: 'echo', args: {say: 'hi'}}], reasoning: signature}, {text: 'Echoed.'}]);
    expect(await s.run()).toEqual({turnIndex: 1, status: 'ready', done: false});
    expect(s.model.requests).toHaveLength(1);
    expect(s.store.data.outputs[0]?.messages.map(m => m.parts.map(p => p.type))).toEqual([['reasoning', 'toolCall'], ['toolResult']]);
    expect(await s.untilDone()).toEqual({turnIndex: 2, status: 'completed', done: true});
    const second = s.model.requests[1]!;
    expect(parts(second.messages, 'toolResult')).toEqual([expect.objectContaining({callId: 'c1', content: [{type: 'text', text: '{"say":"hi"}'}]})]);
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
    expect(s.store.data.commits).toBe(0);
    expect(s.store.data.calls.n1).toBeNull();
  });

  it('error: a provider failure mid-stream keeps the claim for recovery and commits nothing', async () => {
    const s = await scenario([{reasoning: signature, error: new ProviderFailure('fatal', 'Scripted provider error')}]);
    await expect(s.run()).rejects.toMatchObject({kind: 'fatal'});
    expect(s.store.data.commits).toBe(0);
    expect(s.store.data.claimed).toBe(true);
    expect(s.streamed.map(e => e.type)).toEqual(['reasoning', 'blockEnd']);
  });

  it('long: every streamed delta reaches the writer port and the committed text is the whole reply', async () => {
    const text = 'Scripted streaming response. '.repeat(400);
    const s = await scenario([{text}]);
    await s.run();
    const deltas = s.streamed.flatMap(e => e.type === 'text' ? [e.text] : []);
    expect(deltas.length).toBeGreaterThan(400);
    expect(deltas.join('')).toBe(text);
    expect(s.streamed.at(-1)?.type).toBe('completed');
    expect(parts(s.history(), 'text').at(-1)?.text).toBe(text);
  });

  it('compaction: no framework summarization; long history is sent whole and the prefix bytes stay equal', async () => {
    const history = Array.from({length: 40}, (_, i) => prompt(`p${i}`, `Turn ${i}: ${'context '.repeat(200)}`));
    const s = await scenario(Array.from({length: 3}, () => ({calls: [{id: crypto.randomUUID(), name: 'echo', args: {}}]})), {history});
    for (let turn = 0; turn < 3; turn++) await s.run();
    const prefix = s.model.requests.map(r => createHash('sha256').update(canonical({system: r.system, tools: r.tools})).digest('hex'));
    expect(new Set(prefix).size).toBe(1);
    expect(s.model.requests.map(r => r.messages.length)).toEqual([40, 42, 44]);
    expect(s.model.requests[2]!.messages.slice(0, 40)).toEqual(s.model.requests[0]!.messages);
  });

  it('vision: references rehydrate per request, two at a time, while history keeps references; look_at_image emits', async () => {
    const images = Array.from({length: 5}, (_, i): MessagePart => ({type: 'image', attachmentId: `img-${i}`, mediaType: 'image/png'}));
    let active = 0, peak = 0;
    const transform = rehydrateAttachments(async part => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      if (part.attachmentId === 'img-4') throw new Error('it was deleted');
      return {...part, data: `bytes-${part.attachmentId}`};
    });
    const s = await scenario([{calls: [{id: 'v1', name: 'look_at_image', args: {attachmentId: 'img-0'}}]}, {text: 'A fake image.'}],
      {history: [prompt('p', 'Describe', images)], capabilities: {vision: true}, transforms: [transform]});
    await s.untilDone();
    expect(peak).toBeLessThanOrEqual(MEDIA_CONCURRENCY);
    const sent = s.model.requests[0]!.messages[0]!.parts;
    expect(sent.slice(1, 5).map(p => p.data)).toEqual(['bytes-img-0', 'bytes-img-1', 'bytes-img-2', 'bytes-img-3']);
    expect(sent[5]).toEqual({type: 'text', text: '[Attachment unavailable: it was deleted]'});
    expect(parts(s.history(), 'image').every(p => p.data === undefined)).toBe(true);
    expect(s.emitted.map(e => e.type === 'vision.activity' ? e.phase : e.type)).toEqual(['started', 'finished']);
  });
});

describe('edge cases', () => {
  it.each([true, false])('several calls in one response run in model order (parallelToolCalls %s)', async parallelToolCalls => {
    const calls = ['a', 'b', 'c'].map(id => ({id, name: 'echo', args: {id}}));
    const s = await scenario([{calls}, {text: 'All done.'}], {capabilities: {parallelToolCalls}});
    await s.untilDone();
    expect(s.effects.echo).toBe(3);
    const results = s.store.data.outputs[0]!.messages[1]!.parts;
    expect(results.map(p => p.callId)).toEqual(['a', 'b', 'c']);
  });

  it('a dangling call from a crashed turn reaches the model with a synthetic interrupted result; storage is untouched', async () => {
    const dangling: Message = {type: 'message', id: 'crashed', chatId: 'chat', role: 'assistant', createdAt: SCENARIO_TIME,
      updatedAt: SCENARIO_TIME, parts: [{type: 'toolCall', callId: 'lost', name: 'echo', arguments: '{}'}]};
    const history = [prompt('p1', 'First'), dangling, prompt('p2', 'Again')];
    const s = await scenario([{text: 'Recovered.'}], {history});
    await s.run();
    const sent = s.model.requests[0]!.messages;
    expect(sent[1]!.parts.at(-1)).toMatchObject({type: 'toolResult', callId: 'lost', isError: true,
      content: [{type: 'text', text: INTERRUPTED_TOOL_TEXT}]});
    expect(s.effects).toEqual({});
  });

  it('an unknown tool name becomes an error result and the turn continues', async () => {
    const s = await scenario([{calls: [{id: 'u1', name: 'does_not_exist', args: {}}]}, {text: 'Sorry.'}]);
    expect(await s.untilDone()).toMatchObject({status: 'completed'});
    expect(parts(s.history(), 'toolResult')[0]).toMatchObject({callId: 'u1', isError: true,
      content: [{text: expect.stringContaining('[policy-denied]')}]});
  });

  it('untrusted reads mark their result and the commit taint, including a failed read', async () => {
    const s = await scenario([{calls: [{id: 'f1', name: 'fetch_missing', args: {}}, {id: 'f2', name: 'fetch', args: {}}]}, {text: 'ok'}]);
    await s.run();
    const output = s.store.data.outputs[0]!;
    expect(output.taint).toEqual({tainted: true, source: 'fetch missing', callId: 'f1'});
    expect(output.messages[1]!.parts.map(p => [p.callId, p.isError, p.taintSource])).toEqual([['f1', true, 'fetch missing'], ['f2', false, 'fetch']]);
    expect(output.tainted).toBe(true);
  });
});
