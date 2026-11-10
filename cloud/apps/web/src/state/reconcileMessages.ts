import type { Message } from '@praxis/protocol';

const isToolResult = (m: Message) => m.parts.length > 0 && m.parts.every((p) => p.type === 'toolResult');
/** A human prompt: role user and not a wire tool result (those are role user too, with the same turn ID). */
const isPrompt = (m: Message) => m.role === 'user' && !isToolResult(m);

/**
 * Merges committed messages into a chat's list. Only the optimistic prompt is replaced, and only by the
 * committed prompt of the same turn. Tool results share the turn's clientTurnId and the wire role `user`;
 * matching on those alone used to drop the real prompt on every tool result until the run ended.
 */
export function reconcileMessages(existing: Message[], committed: Message[]): Message[] {
  const committedPromptTurns = new Set(committed.filter(isPrompt).flatMap((m) => (m.clientTurnId ? [m.clientTurnId] : [])));
  const byId = new Map<string, Message>();
  for (const m of existing) {
    const replacedOptimistic = m.id.startsWith('optimistic-') && !!m.clientTurnId && committedPromptTurns.has(m.clientTurnId);
    if (!replacedOptimistic) byId.set(m.id, m);
  }
  for (const m of committed) byId.set(m.id, m);
  return Array.from(byId.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
