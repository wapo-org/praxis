import { describe, expect, it } from 'vitest';
import {
  classifyReasoningShape,
  decodeAnthropic,
  decodeOpenAIChat,
  decodeOpenAIResponses,
  parseSSE,
  type ProviderEvent,
} from './index.js';

function bytes(value: string, chunk = 5): ReadableStream<Uint8Array> {
  const data = new TextEncoder().encode(value);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < data.length; i += chunk) {
        controller.enqueue(data.slice(i, i + chunk));
      }
      controller.close();
    },
  });
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of source) events.push(event);
  return events;
}

const sse = (...events: unknown[]) =>
  events.map((e) => (typeof e === 'string' ? `data: ${e}\n\n` : `data: ${JSON.stringify(e)}\n\n`)).join('');

function finalResponse(events: ProviderEvent[]) {
  const last = events.at(-1);
  if (last?.type !== 'completed') throw new Error('Expected completed event');
  return last.response;
}

describe('classifyReasoningShape across the 5 canonical shapes', () => {
  it('classifies (a) titles, (b) summary, (c) raw, (d) redacted, (e) none', () => {
    expect(classifyReasoningShape('Searching the repo\nChecking types\nRunning unit tests')).toBe('titles');
    expect(classifyReasoningShape('', 'titles')).toBe('titles');
    expect(
      classifyReasoningShape(
        '**Clarifying resignation topics**\n"Resigning topics" most naturally refers to key subjects discussed when leaving a job.',
      ),
    ).toBe('summary');
    expect(
      classifyReasoningShape(
        'The user wants the weather in Paris. I should call get_weather first and then format the temperature.',
      ),
    ).toBe('raw');
    expect(classifyReasoningShape('', 'redacted', true)).toBe('redacted');
    expect(classifyReasoningShape('')).toBe('none');
  });
});

describe('Anthropic stream normalisation', () => {
  it('normalises (d) redacted_thinking, (b) summary thinking, (c) raw thinking, citations_delta, and duplicate message_stop', async () => {
    const rawStream = sse(
      {
        type: 'message_start',
        message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 100, output_tokens: 1 } },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'encrypted-redacted-blob' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: '**Checking types**\nInspecting protocol definitions.' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'thinking_delta', thinking: '' }, // empty delta ignored
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'signature_delta', signature: 'sig-123' },
      },
      { type: 'content_block_stop', index: 1 },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: {
          type: 'citations_delta',
          citation: {
            type: 'web_search_result_location',
            url: 'https://example.com/spec',
            title: 'Spec Doc',
            cited_text: 'Protocol v1 is additive.',
          },
        },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'text_delta', text: 'Protocol v1 is additive.' },
      },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 45 } },
      { type: 'message_stop' },
      { type: 'message_stop' }, // duplicate final event
    );

    const events = await collect(decodeAnthropic(parseSSE(bytes(rawStream, 11))));
    const res = finalResponse(events);

    const reasoningEvents = events.filter((e) => e.type === 'reasoning');
    expect(reasoningEvents[0]).toMatchObject({
      type: 'reasoning',
      index: 0,
      text: '',
      shape: 'redacted',
      redacted: true,
    });
    expect(reasoningEvents[1]).toMatchObject({type:'reasoning',index:1,text:'',shape:'raw'});
    expect(reasoningEvents[2]).toMatchObject({
      type: 'reasoning',
      index: 1,
      shape: 'summary',
    });

    expect(res.parts).toHaveLength(3);
    expect(events.find(e => e.type === 'reasoning')).toMatchObject({type:'reasoning',text:''});
    expect(res.parts[0]).toMatchObject({
      type: 'reasoning',
      text: '',
      shape: 'redacted',
      redacted: true,
      data: 'encrypted-redacted-blob',
    });
    expect(res.parts[1]).toMatchObject({
      type: 'reasoning',
      text: '**Checking types**\nInspecting protocol definitions.',
      shape: 'summary',
      signature: 'sig-123',
    });
    expect(res.parts[2]).toMatchObject({
      type: 'text',
      text: 'Protocol v1 is additive.',
      annotations: [
        {
          type: 'citation',
          url: 'https://example.com/spec',
          title: 'Spec Doc',
          citedText: 'Protocol v1 is additive.',
        },
      ],
    });
  });
});

describe('OpenAI Chat stream normalisation', () => {
  it('parses inline <think>...</think> split mid-tag across 1-byte chunks and closes reasoning before text', async () => {
    const rawStream = sse(
      { choices: [{ index: 0, delta: { role: 'assistant', content: '<th' } }] },
      { choices: [{ index: 0, delta: { content: 'ink>\nStep 1: analyze input. ' } }] },
      { choices: [{ index: 0, delta: { content: 'Step 2: compute result.</th' } }] },
      { choices: [{ index: 0, delta: { content: 'ink>\nFinal answer: 42.' } }], finish_reason: 'stop' },
      '[DONE]',
    );

    const events = await collect(decodeOpenAIChat(parseSSE(bytes(rawStream, 3))));
    const res = finalResponse(events);

    const types = events.map((e) => e.type);
    const firstBlockEndIdx = types.indexOf('blockEnd');
    const firstTextIdx = types.indexOf('text');
    expect(firstBlockEndIdx).toBeGreaterThan(0);
    expect(firstBlockEndIdx).toBeLessThan(firstTextIdx);

    expect(res.parts).toEqual([
      {
        type: 'reasoning',
        text: 'Step 1: analyze input. Step 2: compute result.',
        shape: 'raw',
      },
      {
        type: 'text',
        text: 'Final answer: 42.',
      },
    ]);
  });

  it('normalises (a) step titles, (b) OpenRouter reasoning.summary, (d) reasoning.encrypted, and reasoning after text started', async () => {
    const rawStream = sse(
      { choices: [{ index: 0, delta: { reasoning_title: 'Searching the repo' } }] },
      { choices: [{ index: 0, delta: { reasoning_title: 'Checking types' } }] },
      { choices: [{ index: 0, delta: { content: 'First paragraph of text. ' } }] },
      // Reasoning after text had started:
      {
        choices: [
          {
            index: 0,
            delta: {
              reasoning_details: [
                { type: 'reasoning.summary', summary: '**Second thought**\nDouble checking edge cases.' },
                { type: 'reasoning.encrypted', data: 'enc-xyz' },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              content: 'Second paragraph.',
              annotations: [
                {
                  type: 'url_citation',
                  url_citation: { url: 'https://praxis.dev/docs', title: 'Praxis Docs', start_index: 0, end_index: 16 },
                },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      },
      '[DONE]',
    );

    const events = await collect(decodeOpenAIChat(parseSSE(bytes(rawStream, 9))));
    const res = finalResponse(events);

    expect(res.parts.map((p) => ({ type: p.type, shape: p.shape, redacted: p.redacted }))).toEqual([
      { type: 'reasoning', shape: 'titles', redacted: undefined },
      { type: 'text', shape: undefined, redacted: undefined },
      { type: 'reasoning', shape: 'summary', redacted: undefined },
      { type: 'reasoning', shape: 'redacted', redacted: true },
      { type: 'text', shape: undefined, redacted: undefined },
    ]);
    expect(res.parts[0]?.text).toBe('Searching the repo\nChecking types');
    expect(res.parts[4]?.annotations?.[0]).toMatchObject({
      type: 'citation',
      url: 'https://praxis.dev/docs',
      title: 'Praxis Docs',
    });
  });
});

describe('OpenAI Responses stream normalisation', () => {
  it('normalises encrypted-only reasoning items as (d) redacted and emits citations', async () => {
    const output = [
      { type: 'reasoning', id: 'r_enc', summary: [], encrypted_content: 'opaque-cipher' },
      {
        type: 'message',
        id: 'm_1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Cited answer.', annotations: [] }],
      },
    ];
    const rawStream = sse(
      { type: 'response.output_item.added', output_index: 0, item: output[0] },
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'message', content: [] } },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Cited answer.' },
      {
        type: 'response.output_text.annotation.added',
        output_index: 1,
        content_index: 0,
        annotation: { type: 'url_citation', url: 'https://openai.com', title: 'OpenAI' },
      },
      { type: 'response.output_text.done', output_index: 1, content_index: 0 },
      { type: 'response.output_item.done', output_index: 1, item: output[1] },
      { type: 'response.completed', response: { output, usage: { input_tokens: 12, output_tokens: 8 } } },
      { type: 'response.completed', response: { output, usage: { input_tokens: 12, output_tokens: 8 } } }, // duplicate final
    );

    const events = await collect(decodeOpenAIResponses(parseSSE(bytes(rawStream, 13))));
    const res = finalResponse(events);

    expect(events.some((e) => e.type === 'reasoning' && e.shape === 'redacted' && e.redacted === true)).toBe(true);
    expect(events.find(e => e.type === 'reasoning')).toMatchObject({type:'reasoning',text:''});
    expect(res.parts[0]).toMatchObject({
      type: 'reasoning',
      text: '',
      shape: 'redacted',
      redacted: true,
      data: 'opaque-cipher',
    });
    expect(res.parts[1]).toMatchObject({
      type: 'text',
      text: 'Cited answer.',
      annotations: [{ type: 'citation', url: 'https://openai.com', title: 'OpenAI' }],
    });
  });
});
