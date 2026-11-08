import { createHash } from 'node:crypto';
import type { Chat, Message } from '@praxis/protocol';
import { cosine, type Embedder } from './embedding.js';

/**
 * The semantic half of search: every chat's title and message chunks, embedded once and kept by content.
 * An item's id is `${chatId}:${hash(text)}`, so indexing is a set difference: new text is embedded, text that
 * is gone is dropped, unchanged text is never embedded twice. Writes schedule a debounced reindex of their
 * chat; a search reconciles whatever is still missing within a time budget (that is also the backfill).
 */
export interface IndexItem {
  id: string;
  chatId: string;
  text: string;
  vector: Float32Array;
}
export interface VectorHit {
  id: string;
  chatId: string;
  text: string;
  score: number;
}
/** Storage for item vectors, scoped by owner and embedder. Memory in dev and tests, Convex in production. */
export interface VectorIndex {
  ids(userId: string, embedder: string): Promise<Set<string>>;
  upsert(userId: string, embedder: string, items: IndexItem[]): Promise<void>;
  remove(userId: string, embedder: string, ids: string[]): Promise<void>;
  search(userId: string, embedder: string, vector: Float32Array, limit: number): Promise<VectorHit[]>;
}

export function memoryVectorIndex(): VectorIndex {
  const owners = new Map<string, Map<string, IndexItem>>();
  const scope = (userId: string, embedder: string) => {
    const key = `${userId}\u0000${embedder}`;
    let items = owners.get(key);
    if (!items) owners.set(key, (items = new Map()));
    return items;
  };
  return {
    async ids(userId, embedder) {
      return new Set(scope(userId, embedder).keys());
    },
    async upsert(userId, embedder, items) {
      const map = scope(userId, embedder);
      for (const item of items) map.set(item.id, item);
    },
    async remove(userId, embedder, ids) {
      const map = scope(userId, embedder);
      for (const id of ids) map.delete(id);
    },
    async search(userId, embedder, vector, limit) {
      // Brute-force cosine: 10k × 384 is ~4 M multiply-adds, a few ms.
      const top: VectorHit[] = [];
      for (const item of scope(userId, embedder).values()) {
        const score = cosine(vector, item.vector);
        if (top.length < limit || score > top[top.length - 1]!.score) {
          top.push({ id: item.id, chatId: item.chatId, text: item.text, score });
          top.sort((a, b) => b.score - a.score);
          if (top.length > limit) top.pop();
        }
      }
      return top;
    },
  };
}

export const CHUNK_CHARS = 320;
/** Embedding cost cap per chat: its title plus the first chunks of its messages. */
export const MAX_CHUNKS_PER_CHAT = 64;

export const messageText = (message: Message) =>
  message.parts
    .filter(p => p.type === 'text')
    .map(p => p.text ?? '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();

/** Sentence-packed chunks of at most CHUNK_CHARS (a longer sentence is cut at a space). */
export function chunk(text: string, size = CHUNK_CHARS): string[] {
  const out: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) out.push(current.trim());
    current = '';
  };
  for (let sentence of text.split(/(?<=[.!?])\s+/u)) {
    while (sentence.length > size) {
      const cut = sentence.lastIndexOf(' ', size);
      const at = cut > size / 2 ? cut : size;
      push();
      out.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at).trim();
    }
    if (current && current.length + 1 + sentence.length > size) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return out;
}

export interface ChatDoc {
  chat: Chat;
  /** Each message's flattened text, in order. */
  texts: string[];
}

/** Words per phrase window and the step between windows (they overlap by half). */
export const PHRASE_WORDS = 4;
export const PHRASE_STRIDE = 2;
/** Embedding cost cap per chat for phrase windows, taken from each message's opening in turn. */
export const MAX_PHRASES_PER_CHAT = 48;

/**
 * Overlapping short windows of a text. A sentence model scores a short query far better against a short phrase
 * than against the whole sentence around it ("debug code error" meets "script crashes with KeyError" at 0.40,
 * the full message at 0.26), so phrases lift recall without lowering the bar for noise. Texts no longer than a
 * window have none: their chunk already is the phrase.
 */
export function phrases(text: string, size = PHRASE_WORDS, stride = PHRASE_STRIDE): string[] {
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length <= size) return [];
  const out: string[] = [];
  for (let i = 0; ; i += stride) {
    out.push(words.slice(i, i + size).join(' '));
    if (i + size >= words.length) break;
  }
  return out;
}

/** Phrases from every message (user and assistant alike), round-robin from each opening, up to the cap. */
function chatPhrases(texts: string[]): string[] {
  const lists = texts.map(text => phrases(chunk(text)[0] ?? ''));
  const out: string[] = [];
  for (let i = 0; out.length < MAX_PHRASES_PER_CHAT && lists.some(list => i < list.length); i++)
    for (const list of lists) if (i < list.length && out.length < MAX_PHRASES_PER_CHAT) out.push(list[i]!);
  return out;
}

/**
 * The items a chat should have in the index, content-addressed: its title, every message's chunks (user and
 * assistant), and phrase windows of each message's opening.
 */
export function chatItems(doc: ChatDoc): { id: string; chatId: string; text: string }[] {
  const texts = [
    ...[doc.chat.title, ...doc.texts.flatMap(t => chunk(t))].filter(t => t.trim()).slice(0, 1 + MAX_CHUNKS_PER_CHAT),
    ...chatPhrases(doc.texts),
  ];
  const seen = new Set<string>();
  return texts.flatMap(text => {
    const id = `${doc.chat.id}:${createHash('sha1').update(text).digest('base64url').slice(0, 16)}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, chatId: doc.chat.id, text }];
  });
}

export interface SearchIndexerOptions {
  embedder: Embedder;
  vectors: VectorIndex;
  /** Reads a user's chats and messages (the service's owner-scoped store). */
  load: (userId: string, chatId?: string) => Promise<ChatDoc[]>;
  /** Keeps background work alive after a response (Vercel waitUntil); defaults to fire and forget. */
  defer?: (work: Promise<unknown>) => void;
  debounceMs?: number;
}

export class SearchIndexer {
  readonly embedder: Embedder;
  readonly vectors: VectorIndex;
  private known = new Map<string, Promise<Set<string>>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Map<string, Promise<void>>();
  constructor(private options: SearchIndexerOptions) {
    this.embedder = options.embedder;
    this.vectors = options.vectors;
  }

  /** The ids this owner has in the index, read once per process and kept in step by this indexer. */
  private ids(userId: string) {
    let ids = this.known.get(userId);
    if (!ids) {
      ids = this.vectors.ids(userId, this.embedder.id).catch(error => {
        this.known.delete(userId);
        throw error;
      });
      this.known.set(userId, ids);
    }
    return ids;
  }

  /** A chat or message was written: reindex that chat once the writes settle (streaming writes many times). */
  touch(userId: string, chatId: string) {
    const key = `${userId}\u0000${chatId}`;
    clearTimeout(this.timers.get(key));
    const timer = setTimeout(() => {
      this.timers.delete(key);
      const work = this.options.load(userId, chatId).then(docs => this.sync(userId, docs, { chatIds: [chatId] }));
      this.background(work);
    }, this.options.debounceMs ?? 1200);
    (timer as { unref?: () => void }).unref?.();
    this.timers.set(key, timer);
  }

  private background(work: Promise<unknown>) {
    const guarded = work.catch(error => console.error(JSON.stringify({ type: 'search_index_error', error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' })));
    if (this.options.defer) this.options.defer(guarded);
  }

  /**
   * Brings the index in line with `docs`: embeds missing items (newest chats first) until `budgetMs` runs out,
   * drops items whose text is gone. With `chatIds`, only those chats are compared (a write); otherwise the
   * whole owner (a search: this is also the backfill). Returns how many items are still missing.
   */
  async sync(userId: string, docs: ChatDoc[], options: { chatIds?: string[]; budgetMs?: number } = {}): Promise<number> {
    const key = `${userId}\u0000${options.chatIds?.join(',') ?? '*'}`;
    // One sync per scope at a time; a concurrent caller waits for it and then compares again.
    await this.running.get(key);
    let release!: () => void;
    this.running.set(key, new Promise<void>(resolve => (release = resolve)));
    try {
      const started = performance.now();
      const ids = await this.ids(userId);
      const scope = options.chatIds ? new Set(options.chatIds) : null;
      const wanted = new Map<string, { id: string; chatId: string; text: string }>();
      for (const doc of [...docs].sort((a, b) => b.chat.updatedAt.localeCompare(a.chat.updatedAt)))
        for (const item of chatItems(doc)) wanted.set(item.id, item);
      const stale = [...ids].filter(id => !wanted.has(id) && (!scope || scope.has(id.slice(0, id.lastIndexOf(':')))));
      if (stale.length) {
        await this.vectors.remove(userId, this.embedder.id, stale);
        for (const id of stale) ids.delete(id);
      }
      const missing = [...wanted.values()].filter(item => !ids.has(item.id));
      let done = 0;
      while (done < missing.length) {
        if (options.budgetMs !== undefined && performance.now() - started > options.budgetMs) break;
        const batch = missing.slice(done, done + 32);
        const vectors = await this.embedder.embed(batch.map(item => item.text));
        await this.vectors.upsert(userId, this.embedder.id, batch.map((item, i) => ({ ...item, vector: vectors[i]! })));
        for (const item of batch) ids.add(item.id);
        done += batch.length;
      }
      return missing.length - done;
    } finally {
      this.running.delete(key);
      release();
    }
  }

  /** Search-time reconcile: up to `budgetMs` inline, the rest continues in the background. */
  async reconcile(userId: string, docs: ChatDoc[], budgetMs: number) {
    const left = await this.sync(userId, docs, { budgetMs });
    if (left > 0) this.background(this.sync(userId, docs));
    return left;
  }

  async query(userId: string, text: string, limit: number): Promise<VectorHit[]> {
    const [vector] = await this.embedder.embed([text]);
    return this.vectors.search(userId, this.embedder.id, vector!, limit);
  }

  /** Forgets cached ids (account erasure, tests). */
  forget(userId: string) {
    this.known.delete(userId);
  }
}

/** Minimal RPC surface (adapters/convex.ts ConvexRPC). */
interface VectorRPC {
  query(name: string, args: Record<string, unknown>): Promise<unknown>;
  mutation(name: string, args: Record<string, unknown>): Promise<unknown>;
  action(name: string, args: Record<string, unknown>): Promise<unknown>;
}

/** Production: the Convex `embeddings` table and its vector index (convex/search.ts). */
export function convexVectorIndex(rpc: VectorRPC): VectorIndex {
  return {
    async ids(userId, embedder) {
      const out = new Set<string>();
      let cursor: string | null = null;
      do {
        const page = (await rpc.query('search:ids', { userId, embedder, cursor })) as { ids: string[]; cursor: string | null };
        for (const id of page.ids) out.add(id);
        cursor = page.cursor;
      } while (cursor);
      return out;
    },
    async upsert(userId, embedder, items) {
      for (let i = 0; i < items.length; i += 32)
        await rpc.mutation('search:upsert', {
          userId,
          embedder,
          items: items.slice(i, i + 32).map(item => ({ itemId: item.id, chatId: item.chatId, text: item.text, vector: Array.from(item.vector) })),
        });
    },
    async remove(userId, embedder, ids) {
      for (let i = 0; i < ids.length; i += 200) await rpc.mutation('search:remove', { userId, embedder, itemIds: ids.slice(i, i + 200) });
    },
    async search(userId, embedder, vector, limit) {
      return (await rpc.action('search:search', { userId, embedder, vector: Array.from(vector), limit })) as VectorHit[];
    },
  };
}
