import type {Capabilities, Message, MessagePart} from '@praxis/protocol';
import type {ModelProvider, ProviderRequest} from './types.js';

/** Rewrites the request view just before the model call; the snapshot and stored history stay unchanged. */
export type RequestTransform = (request: ProviderRequest, signal: AbortSignal) => Promise<ProviderRequest>;
export type AttachmentResolver = (part: MessagePart, capabilities: Capabilities) => Promise<MessagePart>;

/** Bounds concurrent attachment reads held in memory per request. */
export const MEDIA_CONCURRENCY = 2;
const UNAVAILABLE_REASON_MAX_CHARACTERS = 200;

export async function mapLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}

export function unavailableAttachment(part: MessagePart, error: unknown): MessagePart {
  const reason = error instanceof Error && error.message
    ? error.message.slice(0, UNAVAILABLE_REASON_MAX_CHARACTERS) : 'unknown error';
  console.warn(JSON.stringify({event: 'attachment_unavailable', attachmentId: part.attachmentId, reason}));
  return {type: 'text', text: `[Attachment unavailable: ${reason}]`};
}

function isReference(part: MessagePart): boolean {
  return (part.type === 'image' || part.type === 'document') && !!part.attachmentId && !part.data && !part.url;
}

/** Resolves every reference at most `MEDIA_CONCURRENCY` at a time; a failed read becomes a short text note. */
async function rehydrateParts(
  messages: readonly Message[], one: (part: MessagePart) => Promise<MessagePart>,
): Promise<Message[]> {
  const flat = messages.flatMap((message, mi) => message.parts.map((part, pi) => ({mi, pi, part})));
  const resolved = await mapLimited(flat, MEDIA_CONCURRENCY, ({part}) => one(part));
  const out = messages.map(message => ({...message, parts: [...message.parts]}));
  flat.forEach(({mi, pi}, index) => {
    out[mi]!.parts[pi] = resolved[index]!;
  });
  return out;
}

type PartCache = Map<string, Promise<MessagePart>>;

function cached(cache: PartCache, resolve: (part: MessagePart) => Promise<MessagePart>, keyOf: (part: MessagePart) => string) {
  return (part: MessagePart): Promise<MessagePart> => {
    if (!isReference(part)) return Promise.resolve(part);
    const key = keyOf(part);
    if (!cache.has(key)) cache.set(key, resolve(part).catch(error => unavailableAttachment(part, error)));
    return cache.get(key)!;
  };
}

/** Legacy runner transform: one model request, with its capabilities deciding what a reference becomes. */
export function rehydrateAttachments(resolve: AttachmentResolver): RequestTransform {
  const cache: PartCache = new Map();
  return async request => {
    const caps = request.capabilities;
    const one = cached(cache, part => resolve(part, caps), part => `${part.type}:${part.attachmentId}:${caps.vision ? 1 : 0}${caps.documents ? 1 : 0}`);
    return {...request, messages: await rehydrateParts(request.messages, one)};
  };
}

/** Turn harness transform: the request history only; stored rows and the ledger keep references. */
export function rehydrateMessages(resolve: (part: MessagePart) => Promise<MessagePart>): (messages: readonly Message[]) => Promise<Message[]> {
  return async messages => rehydrateParts(messages, cached(new Map(), resolve, part => `${part.type}:${part.attachmentId}`));
}

/** Applies transforms in order to every request this provider streams. */
export function withRequestTransforms(provider: ModelProvider, transforms: readonly RequestTransform[]): ModelProvider {
  if (!transforms.length) return provider;
  return {
    capabilities: provider.capabilities,
    async *stream(request, signal) {
      let next = request;
      for (const transform of transforms) next = await transform(next, signal);
      yield* provider.stream(next, signal);
    },
  };
}
