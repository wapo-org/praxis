import { describe, expect, it } from 'vitest';
import {
  classifyReasoningShape,
  decodeOpenAIChat,
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
