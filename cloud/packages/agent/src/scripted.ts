import helloReplayJson from './hello-replay.json' with { type: 'json' };
import {
  CapabilitiesSchema,
  StartRunSchema,
  type MessagePart,
  type ReasoningShape,
  type StreamSimOptions,
  type ToolSpec,
} from '@praxis/protocol';
import { ProviderFailure, AgentRunner } from './runner.js';
import {
  textResult,
  type AgentPorts,
  type AgentTool,
  type ModelProvider,
  type ProviderEvent,
  type ProviderRequest,
  type ProviderResponse,
} from './types.js';

const helloReplay = helloReplayJson as unknown as { messages: Array<{ role: string; parts: MessagePart[] }> };

export type Script = NonNullable<import('@praxis/protocol').StartRun['script']>;

export const OWNER_REFERENCE_REASONING_SUMMARY =
  'The user is asking for "top 10 resigning topics" and says "reason long" - which might mean "resignation topics" (topics related to resigning from a job, or reasons for resignation, or things to discuss when resigning, or maybe "designing topics" with a typo?). Let me think carefully about what they likely mean.\n\n' +
  '**Clarifying resignation topics**\n' +
  '"Resigning topics" most naturally refers to:\n' +
  '1. Topics to cover when you are resigning from a job (what to discuss with your manager/HR)\n' +
  '2. Common reasons/topics behind employee resignation (HR/management perspective)\n\n' +
  '**Structuring the response**\n' +
  'I will cover the 10 essential topics every professional should prepare before and during a resignation conversation, organized clearly with actionable guidance.';

export const OWNER_REFERENCE_ANSWER_TEXT =
  'Here are the **top 10 resignation topics** to prepare for—whether you are planning a resignation conversation with your manager, drafting your transition plan, or studying workplace attrition:\n\n' +
  '### 1. Notice Period & Final Working Day\n' +
  'Confirm your contractual notice period (typically two weeks to three months) and propose a clear, unambiguous final day.\n\n' +
  '### 2. Knowledge Transfer & Handover Plan\n' +
  'List active projects, credentials, documentation, and proposed owners for each responsibility.\n\n' +
  '| Area | Recommended Action | Owner |\n' +
  '| :--- | :--- | ---: |\n' +
  '| Active PRs | Document status & next steps | Tech Lead |\n' +
  '| On-call rotation | Reassign upcoming shifts | Team Manager |\n' +
  '| Client handoff | Schedule intro call | Account Lead |\n';

export const RAW_REASONING_SAMPLE = [
  'First, let us examine how provider SSE frames arrive over the network when chunks split mid-token.',
  'Anthropic emits content_block_start with thinking, followed by thinking_delta and signature_delta frames.',
  'OpenAI Chat completions stream delta.reasoning_content or inline <think>...</think> tags inside delta.content.',
  'OpenAI Responses emits response.reasoning_summary_text.delta or encrypted_content items with empty summaries.',
  'When streaming raw chain-of-thought live in the chat column, we cap the live viewport to roughly six lines.',
  'A soft top mask fades the oldest lines at the top while auto-scrolling smoothly to keep the newest line in view.',
  'Once reasoning finishes, the header transitions to "Reasoned for Ns" and the body collapses smoothly as the answer begins.',
  'If the user clicks the header chevron to expand, the full unclipped reasoning transcript is revealed at body width.',
].join('\n');

export const TORTURE_MARKDOWN_SAMPLE = [
  '### Stream Normalisation & Torture Matrix',
  '',
  'Testing **bold across splits**, *italic*, ~~strikethrough~~, `src/streams.ts#L42`, and [Praxis Docs](https://praxis.dev/docs).',
  '',
  'Unicode & Grapheme Clusters: 👨‍👩‍👧‍👦 🏳️‍🌈 👍🏽 e\u0301 a\u0300\u0323 日本語テキスト 한국어 العربية עברית.',
  '',
  'Inline math $E = mc^2$ and display formula: $$\\int_0^\\infty e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}$$',
  '',
  '```typescript',
  'export function drainPacedBuffer(pending: string, dtMs: number): string {',
  '  const step = Math.max(1, Math.ceil((pending.length * dtMs) / 120));',
  '  return pending.slice(0, step);',
  '}',
  '```',
  '',
  '| Provider | Reasoning Shape | P95 Budget |',
  '| :--- | :---: | ---: |',
  '| Anthropic | `raw` / `redacted` | <= 10.2 ms |',
  '| OpenAI | `summary` / `titles` | <= 10.2 ms |',
  '',
  '- [x] Normalise 5 reasoning shapes',
  '- [x] Prevent broken intermediate markdown fences & tables',
  '- [ ] Never lag more than 300 ms behind stream completion',
].join('\n');

export function splitIntoSimulatedChunks(
  text: string,
  chunkSize: StreamSimOptions['chunkSize'] = 'token',
  splitMode: StreamSimOptions['splitMode'] = 'none',
): string[] {
  if (!text) return [];
  if (splitMode === 'encoding' || splitMode === 'torture') return text.split('');
  if (chunkSize === 'whole') return [text];
  if (chunkSize === '2kb') {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += 2048) out.push(text.slice(i, i + 2048));
    return out;
  }
  if (chunkSize === 'sentence') {
    return text.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) ?? [text];
  }
  if (chunkSize === 'word') {
    return text.match(/\S+\s*|\s+/g) ?? [text];
  }
  if (chunkSize === 'char') {
    // Array.from splits by Unicode code point so we don't produce invalid lone surrogates in JSON strings
    return Array.from(text);
  }
  // 'token' (~4 chars, or targeted splits for markdown/torture)
  if (splitMode === 'markdown') {
    const out: string[] = [];
    let i = 0;
    const widths = [1, 2, 1, 3, 2, 5, 1, 4];
    let wIdx = 0;
    while (i < text.length) {
      let step = widths[wIdx++ % widths.length]!;
      // Avoid splitting a surrogate pair in half in JS string slices
      const code = text.charCodeAt(i + step - 1);
      if (code >= 0xd800 && code <= 0xdbff) step++;
      out.push(text.slice(i, i + step));
      i += step;
    }
    return out;
  }
  const out: string[] = [];
  for (let i = 0; i < text.length; ) {
    let step = 4;
    const code = text.charCodeAt(i + step - 1);
    if (code >= 0xd800 && code <= 0xdbff) step++;
    out.push(text.slice(i, i + step));
    i += step;
  }
  return out;
}

export function createScriptedProvider(
  script: Script = 'text',
  simOptions?: StreamSimOptions,
): ModelProvider {
  StartRunSchema.shape.script.parse(script);
  return {
    flavor: 'openAIChat',
    capabilities: CapabilitiesSchema.parse({ tools: true, vision: true, reasoningEffort: true }),
    async *stream(request: ProviderRequest, signal: AbortSignal): AsyncGenerator<ProviderEvent> {
      if (signal.aborted) throw new Error('Aborted');

      let start = 0;
      for (let i = request.messages.length - 1; i >= 0; i--) {
        if (
          request.messages[i]!.role === 'user' &&
          request.messages[i]!.parts.some((p) => p.type === 'text')
        ) {
          start = i;
          break;
        }
      }
      const done = request.messages
        .slice(start)
        .some((m) => m.parts.some((p) => p.type === 'toolResult'));
      const prompt =
        request.messages
          .slice(start)
          .flatMap((m) => m.parts)
          .find((p) => p.type === 'text')?.text ?? '';

      // Owner's real assistant / user-toolResult / assistant shape, with local-only tools.
      if (script === 'helloReplay') {
        const iteration = request.messages.slice(start).filter(m => m.parts.some(p => p.type === 'toolResult')).length;
        const source = helloReplay.messages.filter(m => m.role === 'assistant')[Math.min(iteration, 2)]!;
        const parts: MessagePart[] = [];
        let index = 0;
        for (const part of source.parts) {
          if (part.type === 'reasoning') {
            yield { type: 'reasoning', index, text: part.text ?? '', shape: part.shape as ReasoningShape, redacted: part.redacted };
            await new Promise(r => setTimeout(r, 1000));
            yield { type: 'blockEnd', index };
            parts.push({ type: 'reasoning', text: part.text ?? '', shape: part.shape as ReasoningShape, redacted: part.redacted });
          } else if (part.type === 'text') {
            for (const text of splitIntoSimulatedChunks(part.text ?? '', 'token')) {
              if (signal.aborted) throw new Error('Aborted');
              yield { type: 'text', index, text };
              await new Promise(r => setTimeout(r, 45));
            }
            yield { type: 'blockEnd', index };
            parts.push({ type: 'text', text: part.text });
          } else if (part.type === 'toolCall') {
            const id = crypto.randomUUID();
            yield { type: 'tool', index, id, name: part.name! };
            yield { type: 'arguments', index, json: part.arguments! };
            parts.push({ type: 'toolCall', callId: id, name: part.name, arguments: part.arguments });
          }
          index++;
        }
        yield { type: 'completed', response: { parts, stop: iteration < 2 ? 'toolUse' : 'endTurn', usage: { type: 'usage', inputTokens: 32, outputTokens: 64, cacheReadTokens: 0, cacheWriteTokens: 0 } } };
        return;
      }

      // Specialised reasoning & simulator scripts
      if (
        script === 'reasoningTitles' ||
        script === 'reasoningSummary' ||
        script === 'reasoningRaw' ||
        script === 'reasoningRedacted' ||
        script === 'reasoningNone' ||
        script === 'reasoningInterleaved' ||
        script === 'streamSim'
      ) {
        const shape: ReasoningShape =
          script === 'reasoningTitles'
            ? 'titles'
            : script === 'reasoningSummary'
              ? 'summary'
              : script === 'reasoningRaw'
                ? 'raw'
                : script === 'reasoningRedacted'
                  ? 'redacted'
                  : script === 'reasoningNone'
                    ? 'none'
                    : script === 'reasoningInterleaved'
                      ? 'summary'
                      : (simOptions?.reasoningShape ?? 'summary');

        const reasoningText =
          shape === 'titles'
            ? 'Searching the repo\nChecking types\nNormalising provider stream\nDrafting response'
            : shape === 'summary'
              ? script === 'reasoningInterleaved'
                ? done
                  ? '**Synthesising tool output**\nCombining the tool result into the final answer.'
                  : '**Inspecting workspace**\nChecking the repository state before running local_echo.'
                : OWNER_REFERENCE_REASONING_SUMMARY
              : shape === 'raw'
                ? RAW_REASONING_SAMPLE
                : '';

        const parts: MessagePart[] = [];

        if (shape === 'redacted') {
          yield { type: 'reasoning', index: 100, text: '', shape: 'redacted', redacted: true };
          yield { type: 'blockEnd', index: 100, shape: 'redacted', redacted: true };
          parts.push({ type: 'reasoning', text: '', shape: 'redacted', redacted: true });
        } else if (shape !== 'none' && simOptions?.edgeCase !== 'reasoningAfterText') {
          const rChunks = splitIntoSimulatedChunks(
            reasoningText,
            simOptions?.chunkSize ?? 'word',
            simOptions?.splitMode ?? 'none',
          );
          for (const chunk of rChunks) {
            if (signal.aborted) throw new Error('Aborted');
            yield { type: 'reasoning', index: 100, text: chunk, shape };
          }
          yield { type: 'blockEnd', index: 100, shape };
          parts.push({ type: 'reasoning', text: reasoningText, shape });
        }

        if (
          (script === 'reasoningInterleaved' || simOptions?.edgeCase === 'interleavedTools') &&
          !done
        ) {
          const id = crypto.randomUUID();
          yield { type: 'tool', index: 0, id, name: 'local_echo' };
          yield { type: 'arguments', index: 0, json: '{"step":1}' };
          parts.push({ type: 'toolCall', callId: id, name: 'local_echo', arguments: '{"step":1}' });
          yield {
            type: 'completed',
            response: {
              parts,
              stop: 'toolUse',
              usage: {
                type: 'usage',
                inputTokens: 24,
                outputTokens: 16,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            },
          };
          return;
        }

        const answerText =
          script === 'reasoningSummary'
            ? OWNER_REFERENCE_ANSWER_TEXT
            : script === 'streamSim'
              ? simOptions?.sample === 'short' ? 'Hello **world** 👩🏽‍💻 é 中文 שלום.' : TORTURE_MARKDOWN_SAMPLE
              : `Completed ${script}: ${prompt || 'verified.'}`;
        const tChunks = splitIntoSimulatedChunks(
          answerText,
          simOptions?.chunkSize ?? 'token',
          simOptions?.splitMode ?? 'none',
        );

        const midIdx = Math.max(1, Math.floor(tChunks.length / 2));
        for (let idx = 0; idx < tChunks.length; idx++) {
          if (signal.aborted) throw new Error('Aborted');
          if (simOptions?.edgeCase === 'midStreamError' && idx === midIdx) {
            throw new ProviderFailure('Simulated mid-stream provider error');
          }
          if (simOptions?.edgeCase === 'reasoningAfterText' && idx === midIdx && shape !== 'none') {
            yield { type: 'blockEnd', index: 0 };
            const lateReasoning = '**Mid-turn verification**\nDouble-checking intermediate claims.';
            yield { type: 'reasoning', index: 101, text: lateReasoning, shape: 'summary' };
            yield { type: 'blockEnd', index: 101, shape: 'summary' };
            parts.push({ type: 'text', text: tChunks.slice(0, idx).join('') });
            parts.push({ type: 'reasoning', text: lateReasoning, shape: 'summary' });
          }
          const targetIdx = simOptions?.edgeCase === 'reasoningAfterText' && idx >= midIdx ? 2 : 0;
          if (simOptions?.edgeCase === 'emptyDeltas') yield { type: 'text', index: targetIdx, text: '' };
          yield { type: 'text', index: targetIdx, text: tChunks[idx]! };
        }
        yield {
          type: 'blockEnd',
          index: simOptions?.edgeCase === 'reasoningAfterText' ? 2 : 0,
        };
        if (simOptions?.edgeCase === 'reasoningAfterText') {
          parts.push({ type: 'text', text: tChunks.slice(midIdx).join('') });
        } else {
          parts.push({ type: 'text', text: answerText });
        }

        if (simOptions?.edgeCase === 'duplicateFinal') yield {type:'blockEnd', index:0};
        yield {
          type: 'completed',
          response: {
            parts,
            stop: 'endTurn',
            usage: {
              type: 'usage',
              inputTokens: 32,
              outputTokens: Math.ceil(answerText.length / 4),
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        };
        if (simOptions?.edgeCase === 'duplicateFinal') {
        yield {
          type: 'completed',
          response: {
            parts,
            stop: 'endTurn',
            usage: {
              type: 'usage',
              inputTokens: 32,
              outputTokens: Math.ceil(answerText.length / 4),
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        };
        }
        return;
      }

      if (
        request.system.startsWith('You are a conversation title generator.') ||
        request.system.startsWith('Return only a short')
      ) {
        const raw = request.messages.at(-1)?.parts.find((p) => p.type === 'text')?.text ?? '';
        const match = /<message>\s*([\s\S]*?)\s*<\/message>/i.exec(raw);
        const text = (match ? match[1]! : raw).trim();
        const title = text.split(/\s+/).slice(0, 5).join(' ');
        yield {
          type: 'completed',
          response: {
            parts: [{ type: 'text', text: title }],
            stop: 'endTurn',
            usage: {
              type: 'usage',
              inputTokens: Math.ceil((request.system.length + raw.length) / 4),
              outputTokens: Math.min(20, Math.ceil(title.length / 4)),
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        };
        return;
      }
      // Default legacy scripts ('text', 'tools', 'approval', 'nestedApproval', 'elicitation', 'elicitationURL', 'error', 'long', 'compaction', 'vision')
      yield { type: 'reasoning', index: 100, text: 'Checking the scripted scenario.' };
      yield { type: 'blockEnd', index: 100 };
      if (script === 'error') throw new ProviderFailure('Scripted provider error');

      let parts: MessagePart[];
      const toolName = (
        {
          tools: 'local_echo',
          approval: 'local_write',
          nestedApproval: 'local_nested',
          elicitation: 'local_elicit',
          elicitationURL: 'local_elicit_url',
          vision: 'look_at_image',
        } as Partial<Record<Script, string>>
      )[script];
      if (toolName && !done) {
        const id = crypto.randomUUID();
        yield { type: 'tool', index: 0, id, name: toolName };
        yield { type: 'arguments', index: 0, json: '{}' };
        parts = [{ type: 'toolCall', callId: id, name: toolName, arguments: '{}' }];
      } else {
        const text =
          script === 'long'
            ? 'Scripted streaming response. '.repeat(400)
            : done
              ? 'Scripted tools completed.'
              : `Scripted response: ${prompt}`;
        parts = [{ type: 'text', text }];
        for (let i = 0; i < text.length; i += 24) {
          if (signal.aborted) throw new Error('Aborted');
          yield { type: 'text', index: 0, text: text.slice(i, i + 24) };
        }
        yield { type: 'blockEnd', index: 0 };
      }
      const response: ProviderResponse = {
        parts,
        stop: toolName && !done ? 'toolUse' : 'endTurn',
        usage: {
          type: 'usage',
          inputTokens: Math.ceil(JSON.stringify(request.messages).length / 4),
          outputTokens:
            parts[0]?.type === 'text' ? Math.ceil((parts[0].text ?? '').length / 4) : 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
      yield { type: 'completed', response };
    },
  };
}

function spec(
  name: string,
  source: ToolSpec['source'],
  traits: ToolSpec['traits'],
): ToolSpec {
  return {
    type: 'tool.spec',
    name,
    description: `Local scripted ${name}`,
    inputSchema: { type: 'object', additionalProperties: true },
    source,
    traits,
  };
}

export function scriptedTools(): AgentTool[] {
  return [
    {
      spec: spec('local_echo', { type: 'builtin' }, ['readOnly']),
      execute: async (args) => textResult(JSON.stringify(args)),
    },
    {
      spec: spec('local_write', { type: 'mcp', serverId: 'local', serverName: 'Local' }, [
        'destructive',
      ]),
      execute: async () => textResult('Local write completed.'),
    },
    {
      spec: spec('local_nested', { type: 'javascript' }, ['sandboxed']),
      execute: async (_, ctx) => ctx.callTool('local_write', {}),
    },
    {
      spec: spec('local_elicit', { type: 'builtin' }, ['readOnly']),
      execute: async (_, ctx) => {
        const reply = await ctx.elicit({
          message: 'Provide a name',
          schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        });
        return textResult(
          reply.action === 'accept' ? JSON.stringify(reply.content ?? {}) : 'Elicitation declined',
          reply.action !== 'accept',
        );
      },
    },
    {
      spec: spec('local_elicit_url', { type: 'builtin' }, ['readOnly']),
      execute: async (_, ctx) => {
        // Deterministic URL elicitation (protocol v1 mode:'url'): the client opens the URL, then responds accept/decline/cancel.
        const reply = await ctx.elicit({
          message: 'Sign in to Local Connector to continue.',
          schema: { type: 'object', properties: {} },
          mode: 'url',
          url: 'https://example.com/praxis/local-oauth?state=scripted-elicitation',
          connectorId: 'local-connector',
          connectorName: 'Local Connector',
        });
        return textResult(
          {
            accept: 'Local Connector sign-in completed.',
            decline: 'Local Connector sign-in declined.',
            cancel: 'Local Connector sign-in cancelled.',
          }[reply.action],
          reply.action !== 'accept',
        );
      },
    },
    {
      spec: spec('look_at_image', { type: 'builtin' }, ['readOnly']),
      execute: async (_, ctx) => {
        const id = `${ctx.callId}/vision`;
        await ctx.emit({ type: 'vision.activity', id, phase: 'started', attachmentId: 'local-image' });
        await ctx.emit({
          type: 'vision.activity',
          id,
          phase: 'finished',
          attachmentId: 'local-image',
          answer: 'A scripted image.',
        });
        return textResult('A scripted image.');
      },
    },
    ...helloReplay.messages.flatMap(m => m.parts).filter(p => p.type === 'toolResult').map(part => ({
      spec: spec(part.name!, { type: 'builtin' }, ['readOnly']),
      execute: async () => {
        await new Promise(r => setTimeout(r, 4000));
        return textResult(String(part.content![0]!.text ?? ''));
      },
    })),
  ];
}

export function createScriptedRunner(ports: AgentPorts, script: Script = 'text'): AgentRunner {
  return new AgentRunner({
    ports: {
      ...ports,
      summarize:
        ports.summarize ??
        (async (req) =>
          `Earlier conversation: ${req.messages
            .map((m) => m.parts.map((p) => p.text ?? p.type).join(' '))
            .join('\n')
            .slice(-2000)}`),
    },
    provider: createScriptedProvider(script),
    tools: scriptedTools(),
    ...(script === 'compaction' ? { contextWindow: 1024 } : {}),
  });
}
