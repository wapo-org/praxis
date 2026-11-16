import {ChatSchema, MessageSchema} from '@praxis/protocol';
import {createMemoryAdapters} from '../adapters/memory.js';
import {hashEmbedder} from '../embedding.js';
import {SearchIndexer, memoryVectorIndex} from '../search-index.js';
import {loadChatDocs} from '../search.js';
import {ApiService} from '../service.js';

export const SEARCH_QUERIES = ['how to pack for a trip', 'date regex', 'kettle harbor', 'budget'];
const MESSAGES_PER_CHAT = 3;
const WORDS = 'alpha beta gamma delta lisbon packing regex date budget travel kettle harbor ember compass meadow comet'.split(' ');

export async function searchWorkload(chatCount: number) {
  const base = createMemoryAdapters();
  const work = {listCalls: 0, rowsRead: 0, messageChatReads: 0};
  const service = new ApiService({...base, store: {
    ...base.store,
    async list(...args) {
      work.listCalls++;
      const rows = await base.store.list(...args);
      work.rowsRead += rows.length;
      return args[1] !== 'message' ? rows : rows.map(row => ({
        ...row, value: {...row.value, get chatId() {
          work.messageChatReads++;
          return row.value.chatId!;
        }},
      }));
    },
  }}, true);
  const vectors = memoryVectorIndex();
  const indexer = new SearchIndexer({embedder: hashEmbedder, vectors,
    load: (user, chat) => loadChatDocs(service, user, chat)});
  const now = service.now();
  for (let i = 0; i < chatCount; i++) {
    const id = `c${i}`;
    await service.put('u', 'chat', id, ChatSchema.parse({type: 'chat', id, mode: 'ask',
      title: `${WORDS[i % WORDS.length]} ${WORDS[(i * 7) % WORDS.length]} ${i}`, createdAt: now, updatedAt: now}));
    for (let m = 0; m < MESSAGES_PER_CHAT; m++) {
      await service.put('u', 'message', `${id}-${m}`, MessageSchema.parse({
        type: 'message', id: `${id}-${m}`, chatId: id, sequence: m + 1, role: 'user',
        parts: [{type: 'text', text: `${WORDS[(i + m) % WORDS.length]} notes about ${WORDS[(i * 3 + m) % WORDS.length]} and ${WORDS[(i * 5 + m) % WORDS.length]} for item ${i}.`}],
        createdAt: now, updatedAt: now,
      }));
    }
  }
  service.search = indexer;
  await indexer.sync('u', await loadChatDocs(service, 'u'));
  const vectorCount = (await vectors.ids('u', hashEmbedder.id)).size;
  return {service, vectors, vectorCount, work, messageCount: chatCount * MESSAGES_PER_CHAT,
    resetWork() {
      work.listCalls = 0;
      work.rowsRead = 0;
      work.messageChatReads = 0;
    },
  };
}
