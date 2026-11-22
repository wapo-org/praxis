import type {
  AssistantModelMessage, FilePart, ImagePart, ModelMessage as AiMessage, ReasoningPart, TextPart, ToolCallPart,
  ToolModelMessage, ToolResultPart as AiToolResultPart, UserModelMessage,
} from '@ai-sdk/provider-utils';
import {JsonObjectSchema, JsonValueSchema, type JsonObject, type JsonValue, type Message, type MessagePart} from '@praxis/protocol';
import {canonical} from '../policy.js';
import {
  repairDanglingToolCalls, toModelMessages, type AiPart, type HumanPart, type MessageEnvelope, type ModelMessage,
  type ToolResultPart,
} from '../model-messages.js';

/** Provider-options namespace for what the AI SDK message cannot express; providers ignore unknown namespaces. */
export const PRAXIS_OPTIONS = 'praxis';
const OPENROUTER_OPTIONS = 'openrouter';

type Carried = {part?: JsonObject; absent?: string[]};
type AiContentPart = TextPart | ImagePart | FilePart | ReasoningPart | ToolCallPart;
type Derived = Partial<MessagePart> & {type: MessagePart['type']};

/** The stored fields the derived part gets wrong or lacks, so `restore` rebuilds the stored part exactly. */
function carry(part: MessagePart, derived: Derived): Carried {
  const extras: JsonObject = {};
  for (const [key, value] of Object.entries(part)) {
    const mine = (derived as Record<string, unknown>)[key];
    if (mine === undefined || canonical(mine) !== canonical(value)) extras[key] = JsonValueSchema.parse(value);
  }
  const absent = Object.keys(derived).filter(key => !(key in part));
  return {...(Object.keys(extras).length ? {part: extras} : {}), ...(absent.length ? {absent} : {})};
}

function restore(derived: Derived, carried: Carried | undefined): MessagePart {
  const part: Record<string, unknown> = {...derived, ...carried?.part};
  for (const key of carried?.absent ?? []) delete part[key];
  return part as MessagePart;
}

function carriedOf(options: unknown): Carried | undefined {
  const praxis = (options as Record<string, unknown> | undefined)?.[PRAXIS_OPTIONS];
  return praxis as Carried | undefined;
}

function partOptions(part: MessagePart, derived: Derived) {
  const carried = carry(part, derived);
  return Object.keys(carried).length ? {providerOptions: {[PRAXIS_OPTIONS]: carried}} : {};
}

function envelopeOptions(envelope: MessageEnvelope): Record<string, JsonObject> {
  const options: Record<string, JsonObject> = {[PRAXIS_OPTIONS]: {envelope: JsonObjectSchema.parse(envelope)}};
  const raw = envelope.raw?.data;
  const details = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.reasoning_details : undefined;
  // OpenRouter replays these unchanged, Anthropic signatures included, from the assistant message's options.
  if (Array.isArray(details)) options[OPENROUTER_OPTIONS] = {reasoning_details: details};
  return options;
}

function envelopeOf(message: AiMessage): MessageEnvelope {
  const praxis = message.providerOptions?.[PRAXIS_OPTIONS] as {envelope?: MessageEnvelope} | undefined;
  if (!praxis?.envelope) throw new Error('AI message has no stored envelope');
  return praxis.envelope;
}

function omittedText(part: MessagePart): string {
  return `[${part.type} ${part.attachmentId ?? ''} omitted]`;
}

function mediaOf(part: MessagePart): string | URL | undefined {
  if (part.data) return part.data;
  return part.url ? new URL(part.url) : undefined;
}

function textPart(part: MessagePart, text: string): TextPart {
  return {type: 'text', text, ...partOptions(part, {type: 'text', text})};
}

function imagePart(part: MessagePart, image: string | URL): ImagePart {
  const derived = mediaDerived('image', image, part.mediaType);
  return {type: 'image', image, ...(part.mediaType ? {mediaType: part.mediaType} : {}), ...partOptions(part, derived)};
}

function filePart(part: MessagePart, data: string | URL): FilePart {
  const mediaType = part.mediaType ?? 'application/pdf';
  return {type: 'file', data, mediaType, ...partOptions(part, mediaDerived('document', data, mediaType))};
}

function mediaDerived(type: 'image' | 'document', media: unknown, mediaType: string | undefined): Derived {
  const source = typeof media === 'string' ? {data: media} : media instanceof URL ? {url: media.href} : {};
  return {type, ...source, ...(mediaType ? {mediaType} : {})};
}

function humanPart(part: HumanPart): TextPart | ImagePart | FilePart {
  if (part.type === 'note') return textPart(part, `[Note]\n${part.text ?? ''}`);
  if (part.type === 'text') return textPart(part, part.text ?? '');
  const media = mediaOf(part);
  if (!media) return textPart(part, omittedText(part));
  return part.type === 'image' ? imagePart(part, media) : filePart(part, media);
}

function toolInput(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? '{}');
  } catch {
    return text;
  }
}

function aiPart(part: AiPart): TextPart | FilePart | ReasoningPart | ToolCallPart {
  switch (part.type) {
    case 'text': return textPart(part, part.text ?? '');
    case 'reasoning': {
      const text = part.text ?? '';
      return {type: 'reasoning', text, ...partOptions(part, {type: 'reasoning', text})};
    }
    case 'toolCall': {
      const input = toolInput(part.arguments);
      const derived = toolCallDerived(part.callId ?? '', part.name ?? '', input);
      return {type: 'tool-call', toolCallId: part.callId ?? '', toolName: part.name ?? '', input, ...partOptions(part, derived)};
    }
    case 'image': {
      const media = mediaOf(part);
      return media ? filePart(part, media) : textPart(part, omittedText(part));
    }
  }
}

function toolCallDerived(callId: string, name: string, input: unknown): Derived {
  return {type: 'toolCall', callId, name, arguments: JSON.stringify(input ?? {})};
}

/** What the model reads for a tool result: the same rendering the legacy wire used. */
export function toolResultText(part: MessagePart): string {
  const items = (part.content ?? []).map(item => item.type === 'image'
    ? `[Image ${typeof item.attachmentId === 'string' ? item.attachmentId : ''}]`
    : typeof item.text === 'string' && item.text ? item.text : JSON.stringify(item));
  return items.join('\n') || '(no output)';
}

function toolResult(part: ToolResultPart): AiToolResultPart {
  const value = toolResultText(part);
  const derived: Derived = {type: 'toolResult', callId: part.callId ?? '', name: part.name ?? ''};
  return {
    type: 'tool-result', toolCallId: part.callId ?? '', toolName: part.name ?? '',
    output: part.isError ? {type: 'error-text', value} : {type: 'text', value}, ...partOptions(part, derived),
  };
}

function toAi(model: ModelMessage): AiMessage {
  const providerOptions = envelopeOptions(model.envelope);
  switch (model.kind) {
    case 'human': return {role: 'user', content: model.parts.map(humanPart), providerOptions} satisfies UserModelMessage;
    case 'ai': return {role: 'assistant', content: model.parts.map(aiPart), providerOptions} satisfies AssistantModelMessage;
    case 'tool': return {role: 'tool', content: [toolResult(model.part)], providerOptions} satisfies ToolModelMessage;
  }
}

/** Model view → AI SDK messages, one for one; every stored field rides along under the `praxis` options. */
export function toAiMessages(models: readonly ModelMessage[]): AiMessage[] {
  return models.map(toAi);
}

function derivedFromAi(part: AiContentPart | AiToolResultPart): Derived {
  switch (part.type) {
    case 'text': return {type: 'text', text: part.text};
    case 'reasoning': return {type: 'reasoning', text: part.text};
    case 'tool-call': return toolCallDerived(part.toolCallId, part.toolName, part.input);
    case 'tool-result': return {type: 'toolResult', callId: part.toolCallId, name: part.toolName};
    case 'image': return mediaDerived('image', part.image, part.mediaType);
    case 'file': return mediaDerived('document', part.data, part.mediaType);
  }
  throw new Error('Unknown AI message part');
}

function storedPart(part: unknown): MessagePart {
  const typed = part as AiContentPart | AiToolResultPart;
  return restore(derivedFromAi(typed), carriedOf(typed.providerOptions));
}

function contentOf(message: AiMessage): unknown[] {
  if (typeof message.content === 'string') throw new Error('AI message content must be a part list');
  return message.content;
}

function fromAi(message: AiMessage): ModelMessage {
  const envelope = envelopeOf(message);
  const parts = contentOf(message).map(storedPart);
  switch (message.role) {
    case 'user': return {kind: 'human', envelope, parts: parts as HumanPart[]};
    case 'assistant': return {kind: 'ai', envelope, parts: parts as AiPart[]};
    case 'tool': return {kind: 'tool', envelope, part: parts[0] as ToolResultPart};
    case 'system': throw new Error('System messages are not stored');
  }
}

/** AI SDK messages → model view: the inverse of `toAiMessages`. */
export function fromAiMessages(messages: readonly AiMessage[]): ModelMessage[] {
  return messages.map(fromAi);
}

/** The request history: invalid rows fail closed, dangling calls get an interrupted result, empty responses drop. */
export function requestMessages(history: readonly Message[]): AiMessage[] {
  const models = repairDanglingToolCalls(toModelMessages(history));
  return toAiMessages(models).filter(message => contentOf(message).length > 0);
}

/** JSON-safe view used by tests and the prefix hash: URL objects become strings. */
export function jsonView(messages: readonly AiMessage[]): JsonValue {
  return JsonValueSchema.parse(JSON.parse(JSON.stringify(messages)));
}
