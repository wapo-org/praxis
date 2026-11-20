import type {Capabilities, MessagePart} from '@praxis/protocol';
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

/** A failed read becomes a short text note, so one missing attachment cannot fail the turn. */
export function rehydrateAttachments(resolve: AttachmentResolver): RequestTransform {
  const cache = new Map<string, Promise<MessagePart>>();
  const one = (part: MessagePart, caps: Capabilities): Promise<MessagePart> => {
    if (!isReference(part)) return Promise.resolve(part);
    const key = `${part.type}:${part.attachmentId}:${caps.vision ? 1 : 0}${caps.documents ? 1 : 0}`;
    if (!cache.has(key)) cache.set(key, resolve(part, caps).catch(error => unavailableAttachment(part, error)));
    return cache.get(key)!;
  };
  return async request => {
    const flat = request.messages.flatMap((message, mi) => message.parts.map((part, pi) => ({mi, pi, part})));
    const resolved = await mapLimited(flat, MEDIA_CONCURRENCY, ({part}) => one(part, request.capabilities));
    const messages = request.messages.map(message => ({...message, parts: [...message.parts]}));
    flat.forEach(({mi, pi}, index) => {
      messages[mi]!.parts[pi] = resolved[index]!;
    });
    return {...request, messages};
  };
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
