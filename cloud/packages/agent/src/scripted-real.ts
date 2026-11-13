import type { MessagePart } from '@praxis/protocol';
import { textResult, type AgentTool, type ProviderEvent, type ProviderRequest } from './types.js';

/**
 * WP-M1: a replay of a real chat from the owner's app ("write something semi long", 2026-11-13), with the
 * real part order and realistic timing. One assistant turn is two provider responses split by a wire `user`
 * message that carries only the toolResult:
 *   assistant [reasoning(summary), reasoning(redacted), text, toolCall mcp__exa__web_search_exa_…]
 *   user      [toolResult]
 *   assistant [reasoning(summary), reasoning(redacted), text (long, streamed in small chunks)]
 * Timing: reasoning ≈1.6 s and ≈2.7 s, the search tool 4 s, text in ~4-character chunks at ~70 chunks/s.
 */
export const REAL_SHAPE_TOOL = 'mcp__exa__web_search_exa_226473000415';
export const REAL_SHAPE_TOOL_MS = 4000;

const STEP_ONE = {
  reasoning: 'Interpreting a vague long-form writing request and planning to invoke enabled tools immediately without asking permission.',
  reasoningMs: 1600,
  text: 'I\'ll craft something semi-long for you — pulling a spark of inspiration first.',
  arguments: '{"numResults":5.0,"objective":"Find inspiring themes for a semi-long creative essay/story to write for the user.","query":"most evocative short story themes memory time technology 2026"}',
};

const STEP_TWO = {
  reasoning: 'Drafting an original semi-long story with depth while avoiding copyright and using existing search results.',
  reasoningMs: 2700,
  text: [
    'Here\'s something semi-long for you — an original short story:',
    '',
    '---',
    '',
    '### The Weight of Unkept Hours',
    '',
    'Mara found the box on the third day of cleaning out her father\'s house.',
    '',
    'It was October, and the light in Cleveland was already thinning. The house on W. 112th smelled of dust and lemon oil and something older underneath — pipe tobacco, though her father had quit twenty years ago. She\'d been through the kitchen, the bedroom, the hall closet full of coats he never threw away. Now the attic.',
    '',
    'The box was labeled in his precise architect\'s hand: **TAPE - DO NOT ERASE.**',
    '',
    'Inside were 43 cassette tapes, each dated. 1987 to 2001. A cheap handheld recorder sat on top, its foam windscreen crumbling.',
    '',
    'Mara hadn\'t owned a cassette player in fifteen years. She drove to the library and checked out a dusty Sony Walkman from their "obsolete tech" collection — the librarian smiled like this happened more than you\'d think.',
    '',
    'That night, in her father\'s recliner that she couldn\'t yet bring herself to sell, she pressed play.',
    '',
    '*July 14th, 1989. 7:42 a.m. Mara ate three pancakes. Said the blueberries looked like eyes. Ruth laughed so hard she cried.*',
    '',
    'Her father\'s voice. Younger. Flat, factual. She frowned and fast-forwarded.',
  ].join('\n'),
};

const SEARCH_RESULT = [
  'Title: The Forgetting Code by Malena Salazar Maciá : Clarkesworld Magazine - Science Fiction & Fantasy',
  'URL: https://clarkesworldmagazine.com/macia_04_26/',
  'Published: N/A',
  'Author: Malena Salazar Maciá',
  'Highlights:',
  'There is no formula for forgetting.',
].join('\n');

const CHUNK = 4;
const CHUNK_MS = 14;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function chunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    let step = CHUNK;
    const code = text.charCodeAt(i + step - 1);
    if (code >= 0xd800 && code <= 0xdbff) step++;
    out.push(text.slice(i, i + step));
    i += step;
  }
  return out;
}

/** The provider side of the replay: which step it is follows from whether the tool result is in the request. */
export async function* realShapeStream(request: ProviderRequest, signal: AbortSignal, afterTool: boolean): AsyncGenerator<ProviderEvent> {
  const step = afterTool ? STEP_TWO : STEP_ONE;
  const parts: MessagePart[] = [];
  const reasoning = chunks(step.reasoning);
  for (const chunk of reasoning) {
    await wait(step.reasoningMs / reasoning.length, signal);
    yield { type: 'reasoning', index: 100, text: chunk, shape: 'summary' };
  }
  yield { type: 'blockEnd', index: 100, shape: 'summary' };
  parts.push({ type: 'reasoning', text: step.reasoning, shape: 'summary' });
  yield { type: 'reasoning', index: 101, text: '', shape: 'redacted', redacted: true };
  yield { type: 'blockEnd', index: 101, shape: 'redacted', redacted: true };
  parts.push({ type: 'reasoning', text: '', shape: 'redacted', redacted: true });
  for (const chunk of chunks(step.text)) {
    await wait(CHUNK_MS, signal);
    yield { type: 'text', index: 0, text: chunk };
  }
  yield { type: 'blockEnd', index: 0 };
  parts.push({ type: 'text', text: step.text });
  if (!afterTool) {
    // A connected Exa connector exposes its own hashed name; the scripted stand-in is used otherwise.
    const name = request.tools.find((t) => t.name.startsWith('mcp__exa__web_search_exa'))?.name ?? REAL_SHAPE_TOOL;
    const id = `call_${crypto.randomUUID().replaceAll('-', '')}`;
    yield { type: 'tool', index: 1, id, name };
    yield { type: 'arguments', index: 1, json: STEP_ONE.arguments };
    parts.push({ type: 'toolCall', callId: id, name, arguments: STEP_ONE.arguments });
  }
  yield {
    type: 'completed',
    response: {
      parts,
      stop: afterTool ? 'endTurn' : 'toolUse',
      usage: { type: 'usage', inputTokens: 1200, outputTokens: Math.ceil(step.text.length / 4), cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  };
}

/** The scripted stand-in for the owner's Exa connector tool: same name and source, a real-looking delay. */
export function realShapeTool(): AgentTool {
  return {
    spec: {
      type: 'tool.spec',
      name: REAL_SHAPE_TOOL,
      originalName: 'web_search_exa',
      description: 'Search the web with Exa',
      inputSchema: { type: 'object', additionalProperties: true },
      source: { type: 'mcp', serverId: 'exa', serverName: 'Exa' },
      traits: ['readOnly'],
    },
    execute: async (_args, ctx) => {
      await wait(REAL_SHAPE_TOOL_MS, ctx.signal ?? new AbortController().signal);
      return textResult(SEARCH_RESULT);
    },
  };
}
