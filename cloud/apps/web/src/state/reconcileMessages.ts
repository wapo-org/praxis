import type { Message } from '@praxis/protocol';

const isToolResult = (m: Message) => m.parts.length > 0 && m.parts.every((p) => p.type === 'toolResult');
/** A human prompt: role user and not a wire tool result (those are role user too, with the same turn ID). */
const isPrompt = (m: Message) => m.role === 'user' && !isToolResult(m);

const sortMessages = (list: Message[]) =>
  list.sort(
    (a, b) =>
      (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );

export function reconcileMessages(existing: Message[], committed: Message[]): Message[] {
  const committedPromptTurns = new Set(committed.filter(isPrompt).flatMap((m) => (m.clientTurnId ? [m.clientTurnId] : [])));
  const byId = new Map<string, Message>();
  for (const m of existing) {
    const replacedOptimistic = m.id.startsWith('optimistic-') && !!m.clientTurnId && committedPromptTurns.has(m.clientTurnId);
    if (!replacedOptimistic) byId.set(m.id, m);
  }
  for (const m of committed) byId.set(m.id, m);
  return sortMessages(Array.from(byId.values()));
}

export function mergeFetchedMessages(existing: Message[], fetched: Message[]): Message[] {
  const fetchedPromptTurns = new Set(fetched.filter(isPrompt).flatMap((m) => (m.clientTurnId ? [m.clientTurnId] : [])));
  const byId = new Map<string, Message>();
  for (const m of fetched) byId.set(m.id, m);
  for (const m of existing) {
    if (m.id.startsWith('optimistic-') && (!m.clientTurnId || !fetchedPromptTurns.has(m.clientTurnId))) {
      byId.set(m.id, m);
    }
  }
  return sortMessages(Array.from(byId.values()));
}
