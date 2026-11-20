import {CapabilitiesSchema, MessageSchema, type Message, type MessagePart} from '@praxis/protocol';
import {SealedSecret} from '@praxis/types';
import helloReplayJson from './hello-replay.json' with {type: 'json'};
import {createOpenRouterProvider} from './openrouter.js';
import {collectResponse} from './collect.js';
import {recordedTransport, recording} from './recorded-transport.js';
import {turnOutput} from './turn-output.js';
import type {ProviderResponse} from './types.js';

const TIME = '2026-11-17T12:00:00.000Z';
const helloReplay = helloReplayJson as unknown as {messages: Array<{sequence: number; role: Message['role']; parts: MessagePart[]}>};

/** The captured hello-replay chat (reasoning signatures, block ids, tool results), as stored rows. */
export function capturedChat(): Message[] {
  return helloReplay.messages.map(message => MessageSchema.parse({
    type: 'message', id: `hello-${message.sequence}`, chatId: 'chat', runId: 'run-hello', role: message.role,
    parts: message.parts, sequence: message.sequence, createdAt: TIME, updatedAt: TIME,
  }));
}

/** What the composer stores for a prompt: mode note, text and attachment references (never inline bytes). */
export function promptWithAttachments(id: string): Message {
  return MessageSchema.parse({
    type: 'message', id, chatId: 'chat', role: 'user', clientTurnId: `turn-${id}`, promptStartedAt: TIME,
    createdAt: TIME, updatedAt: TIME,
    parts: [
      {type: 'note', text: 'Current mode: build. Effort: high.'},
      {type: 'text', text: 'What is in these files?'},
      {type: 'image', attachmentId: `${id}-image`, mediaType: 'image/png'},
      {type: 'document', attachmentId: `${id}-pdf`, mediaType: 'application/pdf'},
    ],
  });
}

async function decoded(name: string): Promise<ProviderResponse> {
  const transport = recordedTransport(recording(name));
  const capabilities = CapabilitiesSchema.parse({tools: true, vision: true, reasoningEffort: true});
  const provider = createOpenRouterProvider({apiKey: SealedSecret.of('sk-or-v1-corpus'), capabilities}, transport.fetcher);
  const request = {model: 'anthropic/claude-sonnet-5.5', system: '', messages: [], tools: [], capabilities, maxTokens: 64};
  return collectResponse(provider, request, new AbortController().signal);
}

/** Turns as the harness commits them, from the OpenRouter decoder on the four recorded stream shapes. */
export async function committedTurns(): Promise<Message[]> {
  const out: Message[] = [];
  for (const name of ['text.sse', 'tool-call.sse', 'reasoning.sse', 'image.sse']) {
    const response = await decoded(name);
    const calls = response.parts.filter(part => part.type === 'toolCall').map(part => ({
      id: part.callId!,
      saved: {
        call: {tool: part.name!, args: JSON.parse(part.arguments ?? '{}')},
        result: {ok: true as const, taint: {tainted: true}, result: {
          untrustedSource: true, value: {content: [{type: 'text', text: 'external'}], isError: false, outputRef: 'out-1'},
        }},
      },
    }));
    let next = 0;
    const output = turnOutput({
      chatId: 'chat', runId: 'run', response, calls, offered: [], tainted: false, nowIso: TIME,
      newId: () => `${name}-${next++}`,
    });
    out.push(...output.messages);
  }
  return out;
}

/** The legacy runner's layout: tool results in a user message, an interrupted result, an empty message. */
export function legacyShapes(): Message[] {
  const base = {type: 'message' as const, chatId: 'chat', createdAt: TIME, updatedAt: TIME};
  return [
    {...base, id: 'legacy-call', role: 'assistant', parts: [{type: 'toolCall', callId: 'c1', name: 'read', arguments: '{}'}]},
    {...base, id: 'legacy-result', role: 'user', parts: [
      {type: 'toolResult', callId: 'c1', name: 'read', isError: true, content: [{type: 'text', text: 'Tool execution was interrupted.'}]},
      {type: 'text', text: 'Try again.'},
    ]},
    {...base, id: 'legacy-empty', role: 'assistant', parts: []},
  ];
}
