import {describe, expect, it} from 'vitest';
import {SealedSecret} from '@praxis/types';
import type {JsonObject} from '@praxis/protocol';
import {openRouterTurnModel} from './openrouter-model.js';
import {prompt, turnFixture} from './turn-fixture.js';
import {runTurn} from './turn.js';

const KEY = 'sk-or-v1-harness-test-key';
const SIGNED = {type: 'reasoning.text', text: 'Read first.', signature: 'sig-anthropic-wire', format: 'anthropic-claude-v1', index: 0};
const ENCRYPTED = {type: 'reasoning.encrypted', data: 'opaque-encrypted-blob', format: 'anthropic-claude-v1', index: 1};

function completion(message: JsonObject, finish = 'stop'): JsonObject {
  return {
    id: 'gen-1', object: 'chat.completion', created: 1_800_000_000, model: 'anthropic/claude-sonnet-5.5', provider: 'Anthropic',
    choices: [{index: 0, finish_reason: finish, message: {role: 'assistant', ...message}}],
    usage: {prompt_tokens: 310, completion_tokens: 41, total_tokens: 351, cost: 0.001545, prompt_tokens_details: {cached_tokens: 12}},
  };
}

/** OpenRouter's chat completions endpoint: records request bodies and answers in order. */
function openRouter(replies: Array<{status?: number; body: JsonObject; headers?: Record<string, string>}>) {
  const bodies: JsonObject[] = [];
  const headers: Headers[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== 'https://openrouter.ai/api/v1/chat/completions') throw new Error(`Unexpected ${request.url}`);
    bodies.push(await request.json() as JsonObject);
    headers.push(request.headers);
    const reply = replies[bodies.length - 1];
    if (!reply) throw new Error('No scripted OpenRouter reply');
    return Response.json(reply.body, {status: reply.status ?? 200, headers: reply.headers ?? {}});
  };
  return {fetcher, bodies, headers};
}

async function turnOn(fetcher: typeof fetch, effort?: 'high') {
  const f = await turnFixture([]);
  const {model, providerOptions} = openRouterTurnModel(SealedSecret.of(KEY), 'anthropic/claude-sonnet-5.5', effort, fetcher);
  return {...f, model, ...(providerOptions ? {providerOptions} : {})};
}

describe('the harness on the real OpenRouter AI SDK provider', () => {
  it('turn 1 commits cost and signed reasoning; turn 2 replays reasoning_details unchanged after the tool result', async () => {
    const wire = openRouter([
      {body: completion({content: null, reasoning_details: [SIGNED, ENCRYPTED],
        tool_calls: [{id: 'toolu_01Read', type: 'function', function: {name: 'read', arguments: '{"query":"hello"}'}}]}, 'tool_calls')},
      {body: completion({content: 'The answer.'})},
    ]);
    const first = await turnOn(wire.fetcher, 'high');
    const run = await runTurn(first);
    if (run.state !== 'output') throw new Error(`turn ended ${run.state}`);
    expect(run.output.usage).toMatchObject({inputTokens: 310, outputTokens: 41, cost: 0.001545});
    expect(run.output.end).toEqual({status: 'ready'});
    expect(run.output.messages[0]!.raw?.data).toMatchObject({reasoning_details: [SIGNED, ENCRYPTED]});
    expect(run.output.messages[0]!.parts).toEqual([
      {type: 'reasoning', text: 'Read first.', signature: 'sig-anthropic-wire'},
      {type: 'toolCall', callId: 'toolu_01Read', name: 'read', arguments: '{"query":"hello"}'},
    ]);
    expect(wire.bodies[0]).toMatchObject({usage: {include: true}, reasoning: {effort: 'high'}, tools: [{function: {name: 'read'}}]});
    expect(wire.headers[0]!.get('authorization')).toBe(`Bearer ${KEY}`);

    const second = await turnOn(wire.fetcher);
    second.input = {...second.input, history: [prompt('prompt', 'Hello'), ...run.output.messages]};
    expect(await runTurn(second)).toMatchObject({state: 'output', output: {end: {status: 'completed'}}});
    const messages = wire.bodies[1]!.messages as JsonObject[];
    expect(messages.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(messages[2]).toMatchObject({reasoning_details: [SIGNED, ENCRYPTED],
      tool_calls: [{id: 'toolu_01Read', function: {name: 'read', arguments: '{"query":"hello"}'}}]});
    expect(messages[3]).toMatchObject({tool_call_id: 'toolu_01Read', content: 'external'});
    expect(JSON.stringify(wire.bodies[1])).not.toContain('envelope');
  });

  it.each([
    [401, 'User not found.', 'model_key_invalid'],
    [402, 'Insufficient credits.', 'model_credit_exhausted'],
  ] as const)('a %d ends the turn as failed and saves nothing', async (status, message, code) => {
    const wire = openRouter([{status, body: {error: {code: status, message}}}]);
    const f = await turnOn(wire.fetcher);
    expect(await runTurn(f)).toMatchObject({state: 'failed', failure: {code, message}});
    expect(f.ledger.saved).toBeUndefined();
    expect(f.counts.tool).toBe(0);
  });

  it('a 429 worded as a quota is a rate limit for the workflow retry, not spent credit', async () => {
    const body = {error: {code: 429, message: 'Quota exceeded for requests per minute; retry in 3 seconds'}};
    const wire = openRouter(Array.from({length: 3}, () => ({status: 429, body, headers: {'retry-after': '3'}})));
    const f = await turnOn(wire.fetcher);
    await expect(runTurn(f)).rejects.toMatchObject({kind: 'rateLimited', retryable: true, status: 429});
    expect(f.ledger.saved).toBeUndefined();
  }, 20_000);
});
