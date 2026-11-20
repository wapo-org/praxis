import {MessageSchema, type Message, type MessagePart} from '@praxis/protocol';

/** A stored message without its parts: the identity every model message carries back to storage. */
export type MessageEnvelope = Omit<Message, 'parts'>;
export type HumanPart = MessagePart & {type: 'text' | 'note' | 'image' | 'document'};
export type AiPart = MessagePart & {type: 'text' | 'reasoning' | 'toolCall' | 'image'};
export type ToolResultPart = MessagePart & {type: 'toolResult'};

/** Request-scoped model view: request transforms rewrite it, while storage keeps the original messages. */
export type ModelMessage =
  | {kind: 'human'; envelope: MessageEnvelope; parts: HumanPart[]}
  | {kind: 'ai'; envelope: MessageEnvelope; parts: AiPart[]}
  | {kind: 'tool'; envelope: MessageEnvelope; part: ToolResultPart};

export const INTERRUPTED_TOOL_TEXT = 'Tool execution was interrupted.';

export class MessageMappingError extends Error {
  constructor(readonly messageId: string, reason: string) {
    super(`Message ${messageId} cannot be mapped: ${reason}`);
    this.name = 'MessageMappingError';
  }
}

const HUMAN_TYPES = new Set<MessagePart['type']>(['text', 'note', 'image', 'document']);
const AI_TYPES = new Set<MessagePart['type']>(['text', 'reasoning', 'toolCall', 'image']);

function isToolResult(part: MessagePart): part is ToolResultPart {
  return part.type === 'toolResult';
}

function isHumanPart(part: MessagePart): part is HumanPart {
  return HUMAN_TYPES.has(part.type);
}

function isAiPart(part: MessagePart): part is AiPart {
  return AI_TYPES.has(part.type);
}

/** Results answer the previous response, so a user message leads with them and a response trails with them. */
function splitResults(message: Message): {results: ToolResultPart[]; rest: MessagePart[]} {
  const first = message.parts.findIndex(isToolResult);
  if (first === -1) return {results: [], rest: message.parts};
  const count = message.parts.filter(isToolResult).length;
  const leading = message.role === 'user';
  const start = leading ? 0 : message.parts.length - count;
  if (first !== start || !message.parts.slice(start, start + count).every(isToolResult)) {
    const where = leading ? 'before' : 'after';
    throw new MessageMappingError(message.id, `tool results must come ${where} the other parts of a ${message.role} message`);
  }
  const results = message.parts.slice(start, start + count) as ToolResultPart[];
  const rest = leading ? message.parts.slice(count) : message.parts.slice(0, start);
  return {results, rest};
}

function envelopeOf(message: Message): MessageEnvelope {
  const {parts: _parts, ...envelope} = message;
  return envelope;
}

function humanParts(message: Message, parts: MessagePart[]): HumanPart[] {
  const invalid = parts.find(part => !isHumanPart(part));
  if (invalid) throw new MessageMappingError(message.id, `a user message cannot hold a ${invalid.type} part`);
  return parts as HumanPart[];
}

function aiParts(message: Message, parts: MessagePart[]): AiPart[] {
  const invalid = parts.find(part => !isAiPart(part));
  if (invalid) throw new MessageMappingError(message.id, `an assistant message cannot hold a ${invalid.type} part`);
  return parts as AiPart[];
}

function mapOne(message: Message): ModelMessage[] {
  const envelope = envelopeOf(message);
  const {results, rest} = splitResults(message);
  const tools = results.map((part): ModelMessage => ({kind: 'tool', envelope, part}));
  // An empty body still maps, so a message with no parts survives the round trip.
  const body = rest.length > 0 || results.length === 0;
  if (message.role === 'user') {
    const human: ModelMessage[] = body ? [{kind: 'human', envelope, parts: humanParts(message, rest)}] : [];
    return [...tools, ...human];
  }
  const ai: ModelMessage[] = body ? [{kind: 'ai', envelope, parts: aiParts(message, rest)}] : [];
  return [...ai, ...tools];
}

/** Stored chat → model view. Fails closed: a message `MessageSchema` rejects, or an impossible layout, throws. */
export function toModelMessages(messages: readonly Message[]): ModelMessage[] {
  const ids = new Set<string>();
  return messages.flatMap(input => {
    const message = MessageSchema.parse(input);
    if (ids.has(message.id)) throw new MessageMappingError(message.id, 'duplicate message id');
    ids.add(message.id);
    return mapOne(message);
  });
}

function partsOf(model: ModelMessage): MessagePart[] {
  return model.kind === 'tool' ? [model.part] : model.parts;
}

/** Model view → stored chat: consecutive model messages that share an envelope id form one stored message. */
export function toStoredMessages(models: readonly ModelMessage[]): Message[] {
  const out: Message[] = [];
  let previousId: string | undefined;
  for (const model of models) {
    const last = out.at(-1);
    if (last && previousId === model.envelope.id) {
      last.parts.push(...partsOf(model));
      continue;
    }
    out.push(MessageSchema.parse({...model.envelope, parts: [...partsOf(model)]}));
    previousId = model.envelope.id;
  }
  return out;
}

/** Groups the model view back into stored-message runs, for consumers that render per stored message. */
export function groupByEnvelope(models: readonly ModelMessage[]): ModelMessage[][] {
  const groups: ModelMessage[][] = [];
  for (const model of models) {
    const last = groups.at(-1);
    if (last && last[0]!.envelope.id === model.envelope.id) last.push(model);
    else groups.push([model]);
  }
  return groups;
}

function interrupted(envelope: MessageEnvelope, call: AiPart): ModelMessage {
  const part: ToolResultPart = {
    type: 'toolResult', callId: call.callId, name: call.name, isError: true,
    content: [{type: 'text', text: INTERRUPTED_TOOL_TEXT}],
  };
  return {kind: 'tool', envelope, part};
}

function answeredAfter(models: readonly ModelMessage[], index: number): Set<string> {
  const answered = new Set<string>();
  for (let i = index + 1; i < models.length; i++) {
    const model = models[i]!;
    if (model.kind !== 'tool') break;
    if (model.part.callId) answered.add(model.part.callId);
  }
  return answered;
}

/** Request view only: storage keeps a crashed turn's dangling call, so every later turn rebuilds the same bytes. */
export function repairDanglingToolCalls(models: readonly ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  models.forEach((model, index) => {
    out.push(model);
    if (model.kind !== 'ai') return;
    const answered = answeredAfter(models, index);
    const dangling = model.parts.filter(part => part.type === 'toolCall' && !answered.has(part.callId ?? ''));
    out.push(...dangling.map(call => interrupted(model.envelope, call)));
  });
  return out;
}
