import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ChatSchema, MessageSchema } from '@praxis/protocol';
import { createApp } from '../app.js';
import { createMemoryAdapters } from '../adapters/memory.js';
import { convexHarness } from '../adapters/testing/convex-harness.js';
import { EMBEDDING_DIMENSIONS, hashEmbedder, loadMiniLmEmbedder, terms, type Embedder } from '../embedding.js';
import { MAX_PHRASES_PER_CHAT, SearchIndexer, chatItems, chunk, convexVectorIndex, memoryVectorIndex, phrases, type VectorIndex } from '../search-index.js';
import { SEMANTIC_LIMIT, loadChatDocs } from '../search.js';
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
      // A new message embeds only its own chunk and phrase windows (plus the query).
      const before = w.fixture.embedded();
      await w.service.put('local-user', 'message', 'late', MessageSchema.parse({ type: 'message', id: 'late', chatId: trip, sequence: 9, role: 'user', parts: [{ type: 'text', text: 'Add a calendar for the journey' }], createdAt: w.service.now(), updatedAt: w.service.now() }));
      await w.settle();
      expect(w.fixture.embedded() - before).toBe(1 + phrases('Add a calendar for the journey').length);
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
  it('indexes the title, user and assistant text, and capped phrase windows of each message', () => {
    expect(phrases('Plan to run a half marathon in 12 weeks')).toEqual(['Plan to run a', 'run a half marathon', 'half marathon in 12', 'in 12 weeks']);
    expect(phrases('Packing for Lisbon')).toEqual([]);
    const now = new Date().toISOString();
    const chat = ChatSchema.parse({ type: 'chat', id: 'c', mode: 'ask', title: 'Brave Compass', createdAt: now, updatedAt: now });
    const texts = (items: { text: string }[]) => items.map(i => i.text);
    const items = texts(chatItems({ chat, texts: ['Any tips?', 'Scripted response: train three days a week and taper before the race'] }));
    expect(items).toContain('Brave Compass');
    expect(items).toContain('Any tips?');
    expect(items).toContain('Scripted response: train three days a week and taper before the race');
    expect(items).toContain('days a week and');
    // Many long messages: phrases come from every message's opening in turn, never past the cap.
    const long = Array.from({ length: 40 }, (_, i) => `Message ${i} ${'word '.repeat(30)}`);
    const capped = chatItems({ chat, texts: long }).filter(i => i.text.split(' ').length === 4);
    expect(capped.length).toBeLessThanOrEqual(MAX_PHRASES_PER_CHAT);
    expect(capped.some(i => i.text.startsWith('Message 39'))).toBe(true);
  });

  it('shows at most SEMANTIC_LIMIT semantic-only chats, but every lexical match', async () => {
    const w = await world(memoryVectorIndex());
    w.attach();
    for (let i = 0; i < 12; i++) await w.add('local-user', `Note ${i}`, [`Lisbon suitcase number ${i}`]);
    await w.settle();
    expect((await w.search('vacation luggage')).length).toBe(SEMANTIC_LIMIT);
    expect((await w.search('suitcase')).length).toBe(12);
  });

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

/**
 * WP-H3b recall fixture with the real model: the orchestrator's probe. Six chats with random names (no shared
 * word with the queries), each a user message and the dev:local scripted reply. Skipped when MiniLM is not in
 * the local cache: tests never download it.
 */
const MINILM_CACHE = `${process.env.HOME ?? '.'}/.cache/praxis-embeddings`;
const minilmCached = existsSync(`${MINILM_CACHE}/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx`);
describe.skipIf(!minilmCached)('semantic search: real MiniLM recall (WP-H3b probe)', () => {
  it('finds each chat by meaning, ranks it first, and returns nothing for noise', async () => {
    const embedder = (await loadMiniLmEmbedder(MINILM_CACHE))!;
    expect(embedder.id).toBe('minilm-l6-v2-q8');
    const service = new ApiService(createMemoryAdapters(), true);
    service.search = new SearchIndexer({ embedder, vectors: memoryVectorIndex(), load: (u, c) => loadChatDocs(service, u, c), defer: () => {}, debounceMs: 60_000 });
    const { app } = createApp({ service });
    const now = Date.parse(service.now());
    const chats: [string, string][] = [
      ['Quiet Harbor', 'Packing list for 3 days in Lisbon'],
      ['Amber Fox', 'Match a date like 2026-11-07 with a regular expression'],
      ['Silver Lantern', 'Help me track my monthly expenses and spending'],
      ['Lazy Orchard', 'A quick chickpea curry recipe for tonight'],
      ['Brave Compass', 'My Python script crashes with KeyError when reading JSON'],
      ['Hidden Meadow', 'Plan to run a half marathon in 12 weeks'],
    ];
    for (const [i, [title, text]] of chats.entries()) {
      const at = new Date(now + i).toISOString();
      await service.put('local-user', 'chat', `c${i}`, ChatSchema.parse({ type: 'chat', id: `c${i}`, mode: 'ask', title, createdAt: at, updatedAt: at }));
      for (const [m, t] of [text, `Scripted response: ${text}`].entries())
        await service.put('local-user', 'message', `c${i}-${m}`, MessageSchema.parse({ type: 'message', id: `c${i}-${m}`, chatId: `c${i}`, sequence: m + 1, role: m ? 'assistant' : 'user', parts: [{ type: 'text', text: t }], createdAt: at, updatedAt: at }));
    }
    const search = async (q: string) =>
      ((await (await app.request(`/v1/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: 'Bearer dev-local' } })).json()).items as { chat: { title: string }; snippet: string }[]);
    const cases: [string, string][] = [
      ['packing for a trip', 'Quiet Harbor'],
      ['date regex', 'Amber Fox'],
      ['budget', 'Silver Lantern'],
      ['dinner ideas', 'Lazy Orchard'],
      ['debug code error', 'Brave Compass'],
      ['fitness training', 'Hidden Meadow'],
    ];
    for (const [query, title] of cases) {
      const hits = await search(query);
      expect(hits[0]?.chat.title, query).toBe(title);
      expect(hits.length, query).toBeLessThanOrEqual(SEMANTIC_LIMIT);
    }
    expect((await search('fitness training'))[0]!.snippet).toContain('half marathon');
    // A random name means nothing: a query close to a title alone does not surface the chat.
    expect(await search('zebra quantum')).toEqual([]);
    expect(await search('learn guitar')).toEqual([]);
  }, 60_000);

  it('finds a chat by the assistant reply alone', async () => {
    const embedder = (await loadMiniLmEmbedder(MINILM_CACHE))!;
    const service = new ApiService(createMemoryAdapters(), true);
    service.search = new SearchIndexer({ embedder, vectors: memoryVectorIndex(), load: (u, c) => loadChatDocs(service, u, c), defer: () => {}, debounceMs: 60_000 });
    const { searchChats } = await import('../search.js');
    const now = service.now();
    for (const [id, title, user, reply] of [
      ['a', 'Gentle Atlas', 'Any ideas?', 'Roast the vegetables, then simmer them with coconut milk and spices for a curry.'],
      ['b', 'Rapid Kettle', 'Thoughts?', 'Rebase your branch onto main and force-push it after resolving the conflicts.'],
    ] as const) {
      await service.put('u', 'chat', id, ChatSchema.parse({ type: 'chat', id, mode: 'ask', title, createdAt: now, updatedAt: now }));
      for (const [m, text] of [user, reply].entries())
        await service.put('u', 'message', `${id}${m}`, MessageSchema.parse({ type: 'message', id: `${id}${m}`, chatId: id, sequence: m + 1, role: m ? 'assistant' : 'user', parts: [{ type: 'text', text }], createdAt: now, updatedAt: now }));
    }
    expect((await searchChats(service, 'u', 'dinner recipe'))[0]?.chat.title).toBe('Gentle Atlas');
    expect((await searchChats(service, 'u', 'git merge conflict'))[0]?.chat.title).toBe('Rapid Kettle');
  }, 60_000);
});
