import {IdSchema, MessageSchema} from '@praxis/protocol';
import {ConvexError, v} from 'convex/values';
import {z} from 'zod';
import {ownedChat} from './domainRecords.js';
import {decodeMessage} from './domainValues.js';
import {authedQuery, serverMutation} from './functions.js';
import {writeRecord} from './store.js';

const PAGE_SIZE_MAX = 100;
const COMMIT_MESSAGE_COUNT_MAX = 100;
const sequenceCursor = z.number().int().nonnegative();
const pageSize = z.number().int().min(1).max(PAGE_SIZE_MAX);
const commitMessages = z.array(MessageSchema).min(1).max(COMMIT_MESSAGE_COUNT_MAX);

export const page = authedQuery({
  args: {chatId: v.string(), after: v.optional(v.number()), limit: v.number()},
  handler: async (ctx, {userId, ...args}) => {
    const chatId = IdSchema.parse(args.chatId);
    const after = sequenceCursor.parse(args.after ?? 0);
    const limit = pageSize.parse(args.limit);
    const chat = await ownedChat(ctx, userId, chatId);
    if (!chat || chat.value.deletedAt) return {messages: [], cursor: after, hasMore: false};
    const rows = await ctx.db.query('messages').withIndex('by_chat_sequence', q =>
      q.eq('userId', userId).eq('chatId', chatId).gt('sequence', after)).take(limit + 1);
    const messages = rows.slice(0, limit).map(row => decodeMessage(row.value));
    return {messages, cursor: rows[Math.min(rows.length, limit) - 1]?.sequence ?? after, hasMore: rows.length > limit};
  },
});

export const commit = serverMutation({
  args: {chatId: v.string(), messagesJson: v.string()},
  handler: async (ctx, {userId, chatId, messagesJson}) => {
    const id = IdSchema.parse(chatId);
    const messages = commitMessages.parse(JSON.parse(messagesJson));
    const committed = [];
    for (const message of messages) {
      if (message.chatId !== id) throw new ConvexError('Message chat does not match commit');
      const row = await writeRecord(ctx, {userId, kind: 'message', id: message.id, value: message, deleted: false});
      committed.push(MessageSchema.parse(row.value));
    }
    return committed;
  },
});
