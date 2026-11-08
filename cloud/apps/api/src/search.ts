import type { Chat, Message } from '@praxis/protocol';
import { terms } from './embedding.js';
import { messageText, type ChatDoc, type VectorHit } from './search-index.js';
import type { ApiService } from './service.js';

/** How long a search may spend embedding not-yet-indexed text before it answers (the rest continues after). */
export const RECONCILE_BUDGET_MS = 60;
const SNIPPET = 160;
/** How far below the best vector hit a semantic-only match may score. */
export const SEMANTIC_BAND = 0.12;

/** Every chat with its messages' text, in message order. */
export async function loadChatDocs(service: ApiService, userId: string, chatId?: string): Promise<ChatDoc[]> {
  const [chats, messages] = await Promise.all([
    chatId ? service.list<Chat>(userId, 'chat').then(all => all.filter(c => c.id === chatId)) : service.list<Chat>(userId, 'chat'),
    service.list<Message>(userId, 'message', chatId),
  ]);
  const byChat = new Map<string, Message[]>();
  for (const message of messages) {
    const list = byChat.get(message.chatId) ?? [];
    list.push(message);
    byChat.set(message.chatId, list);
  }
  return chats.map(chat => ({
    chat,
    texts: (byChat.get(chat.id) ?? [])
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.createdAt.localeCompare(b.createdAt))
      .map(messageText)
      .filter(Boolean),
  }));
}

/** The window around the first query word in `text`, or its start. */
function window(text: string, words: string[]) {
  const lower = text.toLocaleLowerCase();
  const position = Math.min(...words.map(w => lower.indexOf(w)).filter(n => n >= 0));
  const start = Number.isFinite(position) ? Math.max(0, position - 40) : 0;
  const end = start + SNIPPET;
  return `${start ? '…' : ''}${text.slice(start, end)}${text.length > end ? '…' : ''}`;
}

/**
 * Hybrid search: lexical (every query word in the title or one message, as before) fused with vector
 * similarity over titles and message chunks. A chat appears when it matches every word or is semantically
 * close (the embedder's threshold); stemmed word overlap ("packing" ~ "pack") adds to its rank. Ranked by
 * the fused score, then recency. The snippet is the best-matching text: the lexical window when the words
 * occur, else the closest chunk.
 */
export async function searchChats(service: ApiService, userId: string, query: string) {
  const raw = query.trim().toLocaleLowerCase();
  const words = raw.split(/\s+/u).filter(Boolean);
  if (!words.length) return [];
  const docs = await loadChatDocs(service, userId);
  const indexer = service.search;
  let hits: VectorHit[] = [];
  if (indexer) {
    try {
      await indexer.reconcile(userId, docs, RECONCILE_BUDGET_MS);
      hits = await indexer.query(userId, query.trim(), 200);
    } catch (error) {
      // Search still answers lexically when the vector side fails.
      console.error(JSON.stringify({ type: 'search_vector_error', error: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }));
    }
  }
  const best = new Map<string, VectorHit>();
  for (const hit of hits) if (!best.has(hit.chatId)) best.set(hit.chatId, hit);
  const queryTerms = new Set(terms(raw));
  // Semantic-only hits must clear the embedder's threshold and sit near the best hit, so a vague query
  // returns the few close chats, not every loosely related one.
  const top = hits[0]?.score ?? 0;
  const threshold = Math.max(indexer?.embedder.threshold ?? 1, top - SEMANTIC_BAND);
  const ranked = docs.flatMap(({ chat, texts }) => {
    const all = (text: string) => words.every(w => text.toLocaleLowerCase().includes(w));
    const matched = texts.find(text => all(`${chat.title} ${text}`));
    const exact = !!matched || all(chat.title);
    // Partial overlap on stemmed words ("packing" ~ "pack"): the share of the query's meaningful words found.
    const chatTerms = new Set(terms(`${chat.title} ${texts.join(' ')}`));
    const overlap = queryTerms.size ? [...queryTerms].filter(t => chatTerms.has(t)).length / queryTerms.size : 0;
    const hit = best.get(chat.id);
    const semantic = hit && hit.score >= threshold ? hit.score : 0;
    if (!exact && !semantic) return [];
    const score = (exact ? 1 : 0) + 0.6 * overlap + (hit ? Math.max(0, hit.score) : 0);
    let snippet: string;
    if (matched) snippet = window(matched, words);
    else {
      const lexical = texts.find(text => words.some(w => text.toLocaleLowerCase().includes(w)));
      const chunk = hit && hit.text !== chat.title ? hit.text : undefined;
      snippet = chunk ? `${chunk.slice(0, SNIPPET)}${chunk.length > SNIPPET ? '…' : ''}` : lexical ? window(lexical, words) : window(texts[0] ?? '', words);
    }
    return [{ chat, snippet, score }];
  });
  return ranked
    .sort((a, b) => b.score - a.score || b.chat.updatedAt.localeCompare(a.chat.updatedAt) || a.chat.id.localeCompare(b.chat.id))
    .map(({ chat, snippet }) => ({ chat, snippet }));
}
