import {ConvexError, v} from 'convex/values';
import {z} from 'zod';
import {ToolSpecSchema, type Message, type Mode, type ToolSpec} from '@praxis/protocol';
import {internalQuery, type QueryCtx} from '../functions.js';
import {decodeChat, decodeMessage} from '../domainValues.js';
import {ownedChat} from '../domainRecords.js';
import {runScope} from '../workflows/validators.js';
import {AGENT_ERRORS, HISTORY_MESSAGES_MAX, MODEL_KEY_ID, MODEL_KEY_KIND} from './constants.js';

/** What one turn reads from Convex; the sealed key stays ciphertext until the action unseals it. */
export interface TurnHydration {
  mode: Mode;
  modelId?: string;
  effort?: string;
  /** Frozen per chat; absent before the first setup is frozen. */
  system?: string;
  tools: ToolSpec[];
  history: Message[];
  sealedKey?: string;
}

const SealedRow = z.object({sealed: z.string()});

async function sealedModelKey(ctx: QueryCtx, userId: string): Promise<string | undefined> {
  const row = await ctx.db.query('records').withIndex('owner_kind_id', q => q
    .eq('userId', userId).eq('kind', MODEL_KEY_KIND).eq('id', MODEL_KEY_ID)).unique();
  if (!row || row.deleted) return undefined;
  const parsed = SealedRow.safeParse(JSON.parse(row.valueJson));
  return parsed.success ? parsed.data.sealed : undefined;
}

export const hydrate = internalQuery({
  args: {...runScope, expectedTurnIndex: v.number()},
  handler: async (ctx, {userId, chatId}): Promise<TurnHydration> => {
    const row = await ownedChat(ctx, userId, chatId);
    if (!row || row.value.deletedAt) throw new ConvexError('Chat unavailable');
    const chat = decodeChat(row.value);
    const rows = await ctx.db.query('messages').withIndex('by_chat_sequence', q => q.eq('userId', userId).eq('chatId', chatId))
      .take(HISTORY_MESSAGES_MAX + 1);
    if (rows.length > HISTORY_MESSAGES_MAX) throw new ConvexError(AGENT_ERRORS.history);
    const sealedKey = await sealedModelKey(ctx, userId);
    return {
      mode: chat.mode,
      ...(chat.modelId ? {modelId: chat.modelId} : {}),
      ...(chat.effort ? {effort: chat.effort} : {}),
      ...(chat.setup ? {system: chat.setup.system} : {}),
      tools: z.array(ToolSpecSchema).parse(chat.setup?.tools ?? []),
      history: rows.map(message => decodeMessage(message.value)),
      ...(sealedKey ? {sealedKey} : {}),
    };
  },
});
