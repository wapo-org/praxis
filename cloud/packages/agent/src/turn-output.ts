import {
  TAINT_SOURCE_CHARACTERS_MAX, MessageSchema, type JsonObject, type Message, type MessagePart, type RunTaint, type ToolSpec, type Usage,
} from '@praxis/protocol';
import {ToolResultSchema, type ProviderResponse} from './types.js';
import {taintLabel} from './run-boundary.js';
import {toModelMessages, toStoredMessages, type ModelMessage, type MessageEnvelope} from './model-messages.js';
import type {SavedCall} from './one-turn-state.js';

/** What one turn hands the store to commit atomically under its fence. */
export interface TurnOutput {
  /** Assistant-role only: the response, then one message holding its tool results. */
  messages: Message[];
  usage: Usage;
  /** The first result of this turn that carried untrusted content; the run's earlier taint is kept by the store. */
  taint?: RunTaint;
  /** The snapshot's taint joined with this turn's results. */
  tainted: boolean;
  end: {status: 'ready'} | {status: 'completed'};
}

export interface TurnOutputInput {
  chatId: string;
  runId: string;
  response: ProviderResponse;
  /** Saved calls with their ids, in the order the model issued them. */
  calls: ReadonlyArray<{id: string; saved: SavedCall}>;
  /** The frozen offered catalog: labels where untrusted content came from. */
  offered: readonly ToolSpec[];
  tainted: boolean;
  nowIso: string;
  newId(): string;
}

function errorText(saved: SavedCall): string {
  if (saved.result.ok) return '';
  const {code, message, remediation} = saved.result.error;
  return `[${code}] ${message}\nRemediation: ${remediation}`;
}

function untrusted(saved: SavedCall): boolean {
  if (!saved.result.ok) return saved.result.untrustedSource;
  const value = ToolResultSchema.safeParse(saved.result.result.value);
  return saved.result.result.untrustedSource || (value.success && value.data.tainted === true);
}

function resultBody(saved: SavedCall): Pick<MessagePart, 'content' | 'isError' | 'outputRef'> {
  if (!saved.result.ok) return {content: [{type: 'text', text: errorText(saved)}], isError: true};
  const value = ToolResultSchema.safeParse(saved.result.result.value);
  // runOneTurn only saves results that passed ToolResultSchema; anything else is a corrupt ledger entry.
  if (!value.success) throw new Error('Saved tool result does not match ToolResultSchema');
  const content: JsonObject[] = value.data.content;
  return {content, isError: value.data.isError, ...(value.data.outputRef ? {outputRef: value.data.outputRef} : {})};
}

function sourceLabel(name: string, offered: readonly ToolSpec[]): string {
  const spec = offered.find(candidate => candidate.name === name);
  return spec ? taintLabel(spec) : name.slice(0, TAINT_SOURCE_CHARACTERS_MAX);
}

function resultPart(id: string, saved: SavedCall, offered: readonly ToolSpec[]): MessagePart {
  const taintSource = untrusted(saved) ? sourceLabel(saved.call.tool, offered) : undefined;
  return {type: 'toolResult', callId: id, name: saved.call.tool, ...resultBody(saved), ...(taintSource ? {taintSource} : {})};
}

function envelope(input: TurnOutputInput, raw?: Message['raw']): MessageEnvelope {
  return {
    type: 'message', id: input.newId(), chatId: input.chatId, runId: input.runId, role: 'assistant',
    createdAt: input.nowIso, updatedAt: input.nowIso, ...(raw ? {raw} : {}),
  };
}

/** The model view of one turn: the response, then its tool results in call order. */
export function turnModelMessages(input: TurnOutputInput): ModelMessage[] {
  const response = MessageSchema.parse({...envelope(input, input.response.raw), parts: input.response.parts});
  const models = toModelMessages([response]);
  if (!input.calls.length) return models;
  const results = envelope(input);
  return [...models, ...input.calls.map(({id, saved}): ModelMessage => ({
    kind: 'tool', envelope: results, part: {...resultPart(id, saved, input.offered), type: 'toolResult'},
  }))];
}

/** Maps the model response and its saved calls to the messages and flags one turn commits. */
export function turnOutput(input: TurnOutputInput): TurnOutput {
  const messages = toStoredMessages(turnModelMessages(input));
  const first = messages.flatMap(message => message.parts).find(part => part.taintSource && part.callId);
  const taint: RunTaint | undefined = first ? {tainted: true, source: first.taintSource!, callId: first.callId!} : undefined;
  // Results go back to the model, so a turn with calls (or a provider pause) always needs another turn.
  const more = input.calls.length > 0 || input.response.stop === 'pauseTurn';
  return {
    messages, usage: input.response.usage, ...(taint ? {taint} : {}),
    tainted: input.tainted || taint !== undefined, end: {status: more ? 'ready' : 'completed'},
  };
}
