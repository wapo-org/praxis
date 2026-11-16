import type {ModelProvider} from '@praxis/agent';
import type {MessagePart} from '@praxis/protocol';

export type ModelCapabilities = ModelProvider['capabilities'];
/** Bounds concurrent file reads in memory per request. */
export const MEDIA_CONCURRENCY = 2;

export async function mapLimited<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await task(items[i]!); } };
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, worker));
  return out;
}

/** Resolves attachment refs with slice caching; failed items degrade to text notes. */
export function withMedia(provider: ModelProvider, resolve: (part: MessagePart, caps: ModelCapabilities) => Promise<MessagePart>): ModelProvider {
  const cache = new Map<string, Promise<MessagePart>>();
  const one = (part: MessagePart, caps: ModelCapabilities) => {
    if ((part.type !== 'image' && part.type !== 'document') || !part.attachmentId || part.data || part.url) return Promise.resolve(part);
    const key = `${part.type}:${part.attachmentId}:${caps.vision ? 1 : 0}${caps.documents ? 1 : 0}`;
    if (!cache.has(key)) cache.set(key, resolve(part, caps).catch(error => unavailable(part, error)));
    return cache.get(key)!;
  };
  return {
    capabilities: provider.capabilities,
    async *stream(request, signal) {
      const flat = request.messages.flatMap((m, mi) => m.parts.map((p, pi) => ({mi, pi, p})));
      const resolved = await mapLimited(flat, MEDIA_CONCURRENCY, ({p}) => one(p, request.capabilities));
      const messages = request.messages.map(m => ({...m, parts: [...m.parts]}));
      flat.forEach(({mi, pi}, i) => { messages[mi]!.parts[pi] = resolved[i]!; });
      yield* provider.stream({...request, messages}, signal);
    },
  };
}

export function unavailable(part: MessagePart, error: unknown): MessagePart {
  const reason = error instanceof Error && error.message ? error.message.slice(0, 200) : 'unknown error';
  console.warn(JSON.stringify({event: 'attachment_unavailable', attachmentId: part.attachmentId, reason}));
  return {type: 'text', text: `[Attachment unavailable: ${reason}]`};
}
