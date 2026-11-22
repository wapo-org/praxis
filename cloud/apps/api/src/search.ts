import type { Chat, Message } from '@praxis/protocol';
import { terms } from './embedding.js';
import { messageText, type ChatDoc, type VectorHit } from './search-index.js';
import type { ApiService } from './service.js';

/** How long a search may spend embedding not-yet-indexed text before it answers (the rest continues after). */
export const RECONCILE_BUDGET_MS = 60;
const SNIPPET = 160;
/** Semantic-only matches shown at most (lexical matches are not capped here). */
export const SEMANTIC_LIMIT = 8;
/** A semantic-only match must reach this share of the best match's score (a relative cut-off). */
export const RELATIVE_CUTOFF = 0.5;
export const TITLE_WEIGHT = 0.8;

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
  const titles = new Map(docs.map(({ chat }) => [chat.id, chat.title]));
  // Each chat's best hit, a title hit weighted down.
  const best = new Map<string, VectorHit>();
  for (const hit of hits) {
    const score = hit.text === titles.get(hit.chatId) ? hit.score * TITLE_WEIGHT : hit.score;
    if (score > (best.get(hit.chatId)?.score ?? -Infinity)) best.set(hit.chatId, { ...hit, score });
  }
  const queryTerms = new Set(terms(raw));
  const top = Math.max(0, ...[...best.values()].map(hit => hit.score));
  const threshold = Math.max(indexer?.embedder.threshold ?? 1, top * RELATIVE_CUTOFF);
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
      // A phrase hit shows the message around it, not the bare four words.
      const around = chunk ? texts.find(text => text.includes(chunk)) : undefined;
      snippet = around ? excerpt(around, around.indexOf(chunk!)) : chunk ? excerpt(chunk, 0) : lexical ? window(lexical, words) : window(texts[0] ?? '', words);
    }
    return [{ chat, snippet, score, exact }];
  });
  let semanticOnly = 0;
  return ranked
    .sort((a, b) => b.score - a.score || b.chat.updatedAt.localeCompare(a.chat.updatedAt) || a.chat.id.localeCompare(b.chat.id))
    .filter(({ exact }) => exact || ++semanticOnly <= SEMANTIC_LIMIT)
    .map(({ chat, snippet }) => ({ chat, snippet }));
}

/** SNIPPET characters of `text` from a little before `at`, with ellipses where it is cut. */
function excerpt(text: string, at: number) {
  const start = at > 40 ? text.lastIndexOf(' ', at - 40) + 1 : 0;
  const end = start + SNIPPET;
  return `${start ? '…' : ''}${text.slice(start, end)}${text.length > end ? '…' : ''}`;
}
