import type { Chat } from '@praxis/protocol';

export const CHAT_GROUPS = ['Pinned', 'Today', 'Yesterday', 'Previous 7 Days', 'Older'] as const;
export type ChatGroup = (typeof CHAT_GROUPS)[number];

export function dateGroup(chat: Chat, now: Date): ChatGroup {
  if (chat.pinned) return 'Pinned';
  const date = new Date(chat.updatedAt);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const week = new Date(today);
  week.setDate(today.getDate() - 7);
  if (date >= today) return 'Today';
  if (date >= yesterday) return 'Yesterday';
  return date >= week ? 'Previous 7 Days' : 'Older';
}

export function groupChats(chats: Chat[], query: string, now: Date): Array<{ group: ChatGroup; chats: Chat[] }> {
  const needle = query.trim().toLocaleLowerCase();
  const visible = chats
    .filter((chat) => chat.title.toLocaleLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return CHAT_GROUPS.map((group) => ({
    group,
    chats: visible.filter((chat) => dateGroup(chat, now) === group),
  })).filter((entry) => entry.chats.length > 0);
}
