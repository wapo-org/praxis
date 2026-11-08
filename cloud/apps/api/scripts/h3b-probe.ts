// WP-H3b probe: the orchestrator's six random-title chats against real MiniLM; per-chat best scores.
// npx tsx apps/api/scripts/h3b-probe.ts
import { ChatSchema, MessageSchema } from '@praxis/protocol';
import { createMemoryAdapters } from '../src/adapters/memory.js';
import { loadMiniLmEmbedder } from '../src/embedding.js';
import { SearchIndexer, memoryVectorIndex } from '../src/search-index.js';
import { loadChatDocs, searchChats } from '../src/search.js';
import { ApiService } from '../src/service.js';
export const PROBE_CHATS: [string, string][] = [
  ['Quiet Harbor', 'Packing list for 3 days in Lisbon'],
  ['Amber Fox', 'Match a date like 2026-11-07 with a regular expression'],
  ['Silver Lantern', 'Help me track my monthly expenses and spending'],
  ['Lazy Orchard', 'A quick chickpea curry recipe for tonight'],
  ['Brave Compass', 'My Python script crashes with KeyError when reading JSON'],
  ['Hidden Meadow', 'Plan to run a half marathon in 12 weeks'],
];
const embedder = (await loadMiniLmEmbedder())!;
const service = new ApiService(createMemoryAdapters(), true);
const now = Date.parse(service.now());
for (const [i, [title, text]] of PROBE_CHATS.entries()) {
  const id = `c${i}`;
  await service.put('u', 'chat', id, ChatSchema.parse({ type: 'chat', id, mode: 'ask', title, createdAt: new Date(now).toISOString(), updatedAt: new Date(now + i).toISOString() }));
  for (const [m, t] of [text, `Scripted response: ${text}`].entries())
    await service.put('u', 'message', `${id}-${m}`, MessageSchema.parse({ type: 'message', id: `${id}-${m}`, chatId: id, sequence: m + 1, role: m ? 'assistant' : 'user', parts: [{ type: 'text', text: t }], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }));
}
const indexer = new SearchIndexer({ embedder, vectors: memoryVectorIndex(), load: (u, c) => loadChatDocs(service, u, c), defer: () => {}, debounceMs: 60_000 });
service.search = indexer;
await indexer.sync('u', await loadChatDocs(service, 'u'));
for (const q of ['packing for a trip', 'date regex', 'budget', 'dinner ideas', 'debug code error', 'fitness training', 'zebra quantum', 'weather tomorrow']) {
  const hits = await indexer.query('u', q, 200);
  const best = new Map<string, number>();
  for (const h of hits) if (!best.has(h.chatId)) best.set(h.chatId, h.score);
  const got = await searchChats(service, 'u', q);
  console.log(q.padEnd(20), [...best].map(([c, s]) => `${PROBE_CHATS[Number(c.slice(1))]![0].split(' ')[1]}:${s.toFixed(2)}`).join(' '), '→', got.map(g => g.chat.title).join(', ') || 'NOTHING');
}
