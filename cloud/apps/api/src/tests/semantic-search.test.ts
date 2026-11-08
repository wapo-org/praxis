import { describe, expect, it } from 'vitest';
import { ChatSchema, MessageSchema } from '@praxis/protocol';
import { createApp } from '../app.js';
import { createMemoryAdapters } from '../adapters/memory.js';
import { convexHarness } from '../adapters/testing/convex-harness.js';
import { EMBEDDING_DIMENSIONS, hashEmbedder, terms, type Embedder } from '../embedding.js';
import { SearchIndexer, chunk, convexVectorIndex, memoryVectorIndex, type VectorIndex } from '../search-index.js';
import { loadChatDocs } from '../search.js';
import { ApiService } from '../service.js';

/**
 * A deterministic stand-in for a sentence model: words map onto a few concept axes (so "vacation luggage"
 * meets "Trip packing list" with no shared word); other words land on hashed residue axes.
 */
const CONCEPTS: Record<string, number> = {
  trip: 0, travel: 0, vacation: 0, journey: 0, lisbon: 0, holiday: 0,
  pack: 1, suitcase: 1, luggage: 1, bag: 1,
  regex: 2, regexp: 2, pattern: 2, match: 2, expression: 2,
  date: 3, calendar: 3, day: 3, 2026: 3,
  grocery: 4, budget: 4, food: 4,
};
function fixtureEmbedder() {
  const calls: string[][] = [];
  const embedder: Embedder = {
    id: 'fixture-v1',
    threshold: 0.5,
    async embed(texts) {
      calls.push(texts);
      return texts.map(text => {
        const v = new Float32Array(EMBEDDING_DIMENSIONS);
        for (const t of terms(text)) {
          const axis = CONCEPTS[t];
          if (axis !== undefined) v[axis]! += 1;
          else v[16 + ([...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 300)]! += 0.35;
        }
        let n = 0;
        for (const x of v) n += x * x;
        n = Math.sqrt(n) || 1;
        return v.map(x => x / n);
      });
    },
  };
  return { embedder, calls, embedded: () => calls.flat().length };
}

async function world(vectors: VectorIndex, adapters = createMemoryAdapters()) {
  const fixture = fixtureEmbedder();
  const service = new ApiService(adapters, true);
  const work: Promise<unknown>[] = [];
  const indexer = new SearchIndexer({ embedder: fixture.embedder, vectors, load: (u, c) => loadChatDocs(service, u, c), defer: w => work.push(w), debounceMs: 0 });
  const { app } = createApp({ service });
  const now = service.now();
  let n = 0;
  const add = async (owner: string, title: string, messages: string[]) => {
    const id = `chat-${++n}`;
    await service.put(owner, 'chat', id, ChatSchema.parse({ type: 'chat', id, mode: 'ask', title, createdAt: now, updatedAt: new Date(Date.parse(now) + n).toISOString() }));
    for (const [i, text] of messages.entries())
      await service.put(owner, 'message', `${id}-m${i}`, MessageSchema.parse({ type: 'message', id: `${id}-m${i}`, chatId: id, sequence: i + 1, role: i % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text }], createdAt: now, updatedAt: now }));
    return id;
  };
  const search = async (q: string) =>
    (await (await app.request(`/v1/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: 'Bearer dev-local' } })).json()).items as { chat: { id: string; title: string }; snippet: string }[];
  const settle = async () => {
    await new Promise(r => setTimeout(r, 5));
    while (work.length) await work.shift();
  };
  return { service, indexer, fixture, add, search, settle, attach: () => (service.search = indexer) };
}

async function seedSource(add: Awaited<ReturnType<typeof world>>['add']) {
  // The owner's v2 source chats, plus an unrelated one and another owner's.
  const trip = await add('local-user', 'Trip packing list', ['Packing list for 3 days in Lisbon', 'Scripted response: Packing list for 3 days in Lisbon']);
  const regex = await add('local-user', 'Regex help', ['Match a date like 2026-11-07', 'Scripted response: Match a date like 2026-11-07']);
  await add('local-user', 'New chat4et', ['fhfgj', 'Scripted response: fhfgj']);
  await add('local-user', 'Grocery budget', ['Weekly food spending']);
  await add('other', 'Vacation suitcase', ['Private travel plans']);
  return { trip, regex };
}

const modes: [string, () => VectorIndex][] = [
  ['memory', memoryVectorIndex],
  ['convex', () => convexVectorIndex(convexHarness().rpc)],
];
for (const [mode, makeIndex] of modes)
  describe(`semantic search: ${mode} vectors`, () => {
    it('finds chats by meaning, ranks the closest first and shows the best-matching chunk', async () => {
      const w = await world(makeIndex());
      w.attach();
      const { trip, regex } = await seedSource(w.add);
      await w.settle();
      // The owner's examples: no chat contains every word, so lexical search alone found nothing.
      expect((await w.search('how to pack for a trip'))[0]!.chat.id).toBe(trip);
      expect((await w.search('date regex'))[0]!.chat.id).toBe(regex);
      // Meaning with no shared word at all.
      const luggage = await w.search('vacation luggage');
      expect(luggage.map(h => h.chat.id)).toEqual([trip]);
      expect(luggage[0]!.snippet).toContain('Lisbon');
      // Lexical matches still work, with the old snippet window; unrelated queries find nothing.
      expect((await w.search('fhfgj')).map(h => h.chat.title)).toEqual(['New chat4et']);
      expect(await w.search('zebra quantum')).toEqual([]);
      // Owners never see each other's vectors.
      expect((await w.search('suitcase travel plans')).map(h => h.chat.title)).not.toContain('Vacation suitcase');
    });

    it('indexes incrementally on write, drops deleted text, and backfills existing data on the first search', async () => {
      const w = await world(makeIndex());
      // Data written before the index existed: the first search is the backfill.
      const { trip } = await seedSource(w.add);
      w.attach();
      expect((await w.search('vacation luggage'))[0]!.chat.id).toBe(trip);
      await w.settle();
      const backfilled = w.fixture.embedded();
      // A new message embeds only its own chunk (plus the query).
      const before = w.fixture.embedded();
      await w.service.put('local-user', 'message', 'late', MessageSchema.parse({ type: 'message', id: 'late', chatId: trip, sequence: 9, role: 'user', parts: [{ type: 'text', text: 'Add a calendar for the journey' }], createdAt: w.service.now(), updatedAt: w.service.now() }));
      await w.settle();
      expect(w.fixture.embedded() - before).toBe(1);
      expect(backfilled).toBeGreaterThan(5);
      // Searching again embeds nothing but the query.
      const again = w.fixture.embedded();
      await w.search('calendar');
      expect(w.fixture.embedded() - again).toBe(1);
      // Deleting the chat removes its vectors.
      for (const id of ['late', `${trip}-m0`, `${trip}-m1`]) await w.service.remove('local-user', 'message', id);
      await w.service.remove('local-user', 'chat', trip);
      await w.settle();
      expect([...(await w.indexer.vectors.ids('local-user', 'fixture-v1'))].some(id => id.startsWith(`${trip}:`))).toBe(false);
      expect(await w.search('vacation luggage')).toEqual([]);
    });
  });

describe('semantic search: parts', () => {
  it('chunks long messages at sentence boundaries within the size', () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const parts = chunk(text, 120);
    expect(parts.every(p => p.length <= 120)).toBe(true);
    expect(parts.join(' ')).toBe(text);
    expect(chunk('x'.repeat(500), 200).every(p => p.length <= 200)).toBe(true);
  });

  it('answers lexically when the vector side fails', async () => {
    const broken: VectorIndex = { ...memoryVectorIndex(), ids: async () => { throw new Error('down'); } };
    const w = await world(broken);
    w.attach();
    await seedSource(w.add);
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      expect((await w.search('fhfgj')).map(h => h.chat.title)).toEqual(['New chat4et']);
    } finally {
      console.error = original;
    }
    expect(errors.length).toBeGreaterThan(0);
  });

  it('meets p95 < 150 ms over 2,000 chats in dev (memory vectors, offline embedder)', async () => {
    const service = new ApiService(createMemoryAdapters(), true);
    const indexer = new SearchIndexer({ embedder: hashEmbedder, vectors: memoryVectorIndex(), load: (u, c) => loadChatDocs(service, u, c), defer: () => {}, debounceMs: 60_000 });
    const now = service.now();
    const words = 'alpha beta gamma delta lisbon packing regex date budget travel kettle harbor ember compass meadow comet'.split(' ');
    for (let i = 0; i < 2000; i++) {
      const id = `c${i}`;
      await service.put('u', 'chat', id, ChatSchema.parse({ type: 'chat', id, mode: 'ask', title: `${words[i % 16]} ${words[(i * 7) % 16]} ${i}`, createdAt: now, updatedAt: now }));
      for (let m = 0; m < 3; m++)
        await service.put('u', 'message', `${id}-${m}`, MessageSchema.parse({ type: 'message', id: `${id}-${m}`, chatId: id, sequence: m + 1, role: 'user', parts: [{ type: 'text', text: `${words[(i + m) % 16]} notes about ${words[(i * 3 + m) % 16]} and ${words[(i * 5 + m) % 16]} for item ${i}.` }], createdAt: now, updatedAt: now }));
    }
    service.search = indexer;
    await indexer.sync('u', await loadChatDocs(service, 'u'));
    const { searchChats } = await import('../search.js');
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t = performance.now();
      await searchChats(service, 'u', ['how to pack for a trip', 'date regex', 'kettle harbor', 'budget'][i % 4]!);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.info(`search p95 over 2000 chats / 8000 vectors: ${p95.toFixed(1)} ms`);
    expect(p95).toBeLessThan(150);
  }, 60_000);
});
