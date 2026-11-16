import { ChatSchema, MessageSchema } from '@praxis/protocol';
import { createMemoryAdapters } from '../src/adapters/memory.js';
import { selectEmbedder } from '../src/embedding.js';
import { SearchIndexer, memoryVectorIndex } from '../src/search-index.js';
import { loadChatDocs, searchChats } from '../src/search.js';
import { ApiService } from '../src/service.js';

const embedder = (await selectEmbedder({ ...process.env, PRAXIS_EMBEDDER: process.argv[2] ?? 'minilm' }, true))!;
const service = new ApiService(createMemoryAdapters(), true);
const now = service.now();
const topics = ['Trip packing list', 'Regex help', 'Kettle descaling', 'Budget review', 'Lisbon itinerary', 'SQL joins', 'Garden planning', 'Bike repair', 'Tax forms', 'Birthday ideas'];
const lines = ['Packing list for 3 days in Lisbon', 'Match a date like 2026-11-07', 'How do I descale a kettle with vinegar?', 'Monthly spending went up in October', 'What should I see in Alfama?', 'Explain a left join with an example', 'When to plant tomatoes', 'My chain keeps slipping', 'Which form do I need for freelance income?', 'Gift ideas for a ten year old'];
for (let i = 0; i < 2000; i++) {
  const id = `c${i}`;
  await service.put('u', 'chat', id, ChatSchema.parse({ type: 'chat', id, mode: 'ask', title: `${topics[i % 10]} ${i}`, createdAt: now, updatedAt: now }));
  for (let m = 0; m < 3; m++)
    await service.put('u', 'message', `${id}-${m}`, MessageSchema.parse({ type: 'message', id: `${id}-${m}`, chatId: id, sequence: m + 1, role: m % 2 ? 'assistant' : 'user', parts: [{ type: 'text', text: `${lines[(i + m) % 10]} (note ${i}-${m}).` }], createdAt: now, updatedAt: now }));
}
const indexer = new SearchIndexer({ embedder, vectors: memoryVectorIndex(), load: (u, c) => loadChatDocs(service, u, c), defer: () => {}, debounceMs: 60_000 });
service.search = indexer;
let t = performance.now();
await indexer.sync('u', await loadChatDocs(service, 'u'));
console.log(`${embedder.id}: backfill of 2000 chats (8000 texts) ${Math.round(performance.now() - t)} ms`);
const queries = ['how to pack for a trip', 'date regex', 'cleaning limescale', 'money spent', 'things to do in Portugal', 'database query', 'vegetables', 'bicycle problem', 'taxes', 'present for a kid'];
const times: number[] = [];
for (let i = 0; i < 100; i++) {
  t = performance.now();
  const hits = await searchChats(service, 'u', queries[i % 10]!);
  times.push(performance.now() - t);
  if (i < 10) console.log(`  ${queries[i]} → ${hits.slice(0, 2).map(h => h.chat.title.replace(/ \d+$/, '')).join(', ')} (${hits.length})`);
}
times.sort((a, b) => a - b);
console.log(`p50 ${times[50]!.toFixed(1)} ms, p95 ${times[95]!.toFixed(1)} ms, max ${times[99]!.toFixed(1)} ms`);
