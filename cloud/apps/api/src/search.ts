import type { Chat, Message } from '@praxis/protocol';
import type { ApiService } from './service.js';

/** Reads through the owner-scoped Store contract, shared by memory and Convex. */
export async function searchChats(service: ApiService, userId: string, query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length) return [];
  const [chats, messages] = await Promise.all([
    service.list<Chat>(userId, 'chat'), service.list<Message>(userId, 'message'),
  ]);
  const byChat = new Map<string, string[]>();
  for (const message of messages) {
    const text = message.parts.filter(p => p.type === 'text').map(p => p.text ?? '').join(' ').replace(/\s+/gu, ' ');
    const values = byChat.get(message.chatId) ?? [];
    values.push(text);
    byChat.set(message.chatId, values);
  }
  return chats.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).flatMap(chat => {
    const texts = byChat.get(chat.id) ?? [];
    const matches = (text: string) => words.every(w => text.toLocaleLowerCase().includes(w));
    const matched = texts.find(text => matches(`${chat.title} ${text}`));
    if (!matched && !matches(chat.title)) return [];
    const text = matched ?? texts[0] ?? '';
    const lower = text.toLocaleLowerCase();
    const position = Math.min(...words.map(w => lower.indexOf(w)).filter(n => n >= 0));
    const start = Number.isFinite(position) ? Math.max(0, position - 40) : 0;
    const end = start + 160;
    return [{ chat, snippet: `${start ? '…' : ''}${text.slice(start, end)}${text.length > end ? '…' : ''}` }];
  });
}
