import {describe, expect, it} from 'vitest';
import {CapabilitiesSchema, type JsonObject, type Message} from '@praxis/protocol';
import {SealedSecret} from '@praxis/types';
import {createOpenRouterProvider} from './openrouter.js';
import {collectResponse} from './collect.js';
import {AgentRunner} from './runner.js';
import {recordedTransport, recording} from './recorded-transport.js';
import type {AgentPorts, ProviderEvent, ProviderRequest, ProviderResponse} from './types.js';

const KEY = 'sk-or-v1-recorded-transport-key';
const time = '2026-11-17T12:00:00.000Z';
const caps = CapabilitiesSchema.parse({tools: true, vision: true, reasoningEffort: true});
const message = (role: Message['role'], parts: Message['parts'], raw?: Message['raw']): Message => ({
  type: 'message', id: crypto.randomUUID(), chatId: 'chat', role, parts, createdAt: time, updatedAt: time, ...(raw ? {raw} : {}),
});
const readTool = {
  type: 'tool.spec' as const, name: 'read', description: 'Read external data.', source: {type: 'builtin' as const}, traits: [],
  inputSchema: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']},
};
const request = (messages: Message[], extra: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'anthropic/claude-sonnet-5.5', system: 'System', messages, tools: [readTool], capabilities: caps, maxTokens: 1024, ...extra,
});
const provider = (fetcher: typeof fetch) => createOpenRouterProvider({apiKey: SealedSecret.of(KEY), capabilities: caps}, fetcher);
const signal = () => new AbortController().signal;
const sent = (transport: {calls: {body: JsonObject}[]}, index: number): JsonObject => {
  const call = transport.calls[index];
  if (!call) throw new Error(`No request ${index} was sent`);
  return call.body;
};

async function drain(source: AsyncIterable<ProviderEvent>): Promise<{events: ProviderEvent[]; response: ProviderResponse}> {
  const events: ProviderEvent[] = [];
  for await (const event of source) events.push(event);
  const last = events.at(-1);
  if (last?.type !== 'completed') throw new Error('Stream did not complete');
  return {events, response: last.response};
}

describe('OpenRouter over a recorded transport', () => {
  it('text: streams deltas, then one response with tokens and cost', async () => {
    const transport = recordedTransport(recording('text.sse'));
    const {events, response} = await drain(provider(transport.fetcher).stream(request([message('user', [{type: 'text', text: 'Hi'}])]), signal()));
    expect(events.filter(e => e.type === 'text').map(e => e.type === 'text' ? e.text : '').join('')).toBe('Hello from OpenRouter.');
    expect(response).toMatchObject({stop: 'endTurn', parts: [{type: 'text', text: 'Hello from OpenRouter.'}]});
    expect(response.usage).toEqual({type: 'usage', inputTokens: 32, outputTokens: 6, cacheReadTokens: 10, cacheWriteTokens: 0, cost: 0.000216});
    const [call] = transport.calls;
    expect(call?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(call?.headers.get('x-title')).toBe('Praxis');
    expect(call?.body).toMatchObject({stream: true, usage: {include: true}, model: 'anthropic/claude-sonnet-5.5'});
  });

  it('tool call: arguments split across chunks assemble into one call', async () => {
    const transport = recordedTransport(recording('tool-call.sse'));
    const {response} = await drain(provider(transport.fetcher).stream(request([message('user', [{type: 'text', text: 'Look up hello'}])]), signal()));
    expect(response.stop).toBe('toolUse');
    expect(response.parts.filter(p => p.type === 'toolCall')).toEqual([{type: 'toolCall', callId: 'toolu_01ReadHello', name: 'read', arguments: '{"query":"hello"}'}]);
    expect(response.usage.cost).toBe(0.001545);
    expect((sent(transport, 0).tools as JsonObject[])[0]).toMatchObject({type: 'function', function: {name: 'read'}});
  });

  it('reasoning: details merged per index are replayed unchanged on the next request', async () => {
    const transport = recordedTransport(recording('reasoning.sse'), recording('text.sse'));
    const model = provider(transport.fetcher);
    const user = message('user', [{type: 'text', text: 'Look up hello'}]);
    const first = await collectResponse(model, request([user], {effort: 'high'}), signal());
    expect(first.parts[0]).toMatchObject({type: 'reasoning', text: 'The user wants a lookup.'});
    const result = message('user', [{type: 'toolResult', callId: 'toolu_02ReasonRead', name: 'read', content: [{type: 'text', text: 'world'}]}]);
    await collectResponse(model, request([user, message('assistant', first.parts, first.raw), result], {effort: 'high'}), signal());
    expect(transport.calls[0]?.body.reasoning).toEqual({effort: 'high'});
    const replayed = (sent(transport, 1).messages as JsonObject[]).find(m => m.role === 'assistant');
    expect(replayed?.reasoning_details).toEqual([{
      type: 'reasoning.text', text: 'The user wants a lookup.', signature: 'EqQBCkYIBxgCKkCsig0001', format: 'anthropic-claude-v1', index: 0,
    }]);
    expect(replayed?.tool_calls).toEqual([{id: 'toolu_02ReasonRead', type: 'function', function: {name: 'read', arguments: '{"query":"hello"}'}}]);
  });

  it('image: an image part goes out as an image_url data URL and the answer comes back as text', async () => {
    const transport = recordedTransport(recording('image.sse'));
    const image = message('user', [{type: 'text', text: 'What is this?'}, {type: 'image', attachmentId: 'img', data: 'iVBORw0KGgo=', mediaType: 'image/png'}]);
    const response = await collectResponse(provider(transport.fetcher), request([image], {model: 'google/gemini-3.8-flash'}), signal());
    expect(response.parts).toEqual([{type: 'text', text: 'A red square on white.'}]);
    expect(response.usage.cost).toBe(0.000132);
    expect((sent(transport, 0).messages as JsonObject[])[1]?.content).toEqual([
      {type: 'text', text: 'What is this?'}, {type: 'image_url', image_url: {url: 'data:image/png;base64,iVBORw0KGgo='}},
    ]);
  });
});

describe('Retry-After on the OpenRouter provider', () => {
  it.each([
    [429, 'Quota exceeded for requests per minute; retry in 3 seconds'],
    [429, 'Rate limit exceeded'],
    [503, 'Try later'],
  ] as const)('a %d "%s" with Retry-After waits that long, then completes', async (status, text) => {
    const transport = recordedTransport({status, body: {error: {code: status, message: text}}, headers: {'retry-after': '30'}}, recording('text.sse'));
    const waits: number[] = [];
    const ports: AgentPorts = {save: async () => {}, emit: async () => {}, isCancelled: async () => false, sleep: async ms => { waits.push(ms); }};
    const run = {type: 'run' as const, id: 'run', chatId: 'chat', status: 'queued' as const, createdAt: time, updatedAt: time, lastEventId: 0};
    const chat = {type: 'chat' as const, id: 'chat', title: 'Chat', pinned: false, mode: 'auto' as const, connectorIds: [], disabledConnectorIds: [], createdAt: time, updatedAt: time};
    const cp = await new AgentRunner({provider: provider(transport.fetcher), ports}).run({userId: 'user', run, chat, messages: [message('user', [{type: 'text', text: 'Hi'}])]});
    expect(cp.run.status).toBe('completed');
    expect(waits).toEqual([30_000]);
    expect(transport.calls).toHaveLength(2);
  });
});
