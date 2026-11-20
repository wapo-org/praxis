import {ChatInputSchema, ChatPatchSchema, ChatSchema, IdSchema} from '@praxis/protocol';
import {ConvexError, v} from 'convex/values';
import {ownedChat} from './domainRecords.js';
import {decodeChat} from './domainValues.js';
import {authedMutation, authedQuery} from './functions.js';
import {writeRecord} from './store.js';
import {convexValidator} from './zodValidator.js';

export const list = authedQuery({
  args: {},
  handler: async (ctx, {userId}) => {
    const rows = await ctx.db.query('chats')
      .withIndex('by_user_updated', q => q.eq('userId', userId)).order('desc').collect();
    return rows.filter(row => !row.value.deletedAt).map(row => decodeChat(row.value));
  },
});

export const get = authedQuery({
  args: {chatId: v.string()},
  handler: async (ctx, {userId, chatId}) => {
    const chat = await ownedChat(ctx, userId, IdSchema.parse(chatId));
    return chat && !chat.value.deletedAt ? decodeChat(chat.value) : null;
  },
});

export const create = authedMutation({
  args: {input: convexValidator(ChatInputSchema)},
  handler: async (ctx, {userId, input}) => {
    const parsed = ChatInputSchema.parse(input);
    const id = parsed.id ?? crypto.randomUUID();
    if (await ownedChat(ctx, userId, id)) throw new ConvexError('Chat ID unavailable');
    const now = new Date().toISOString();
    const chat = ChatSchema.parse({...parsed, type: 'chat', id, createdAt: now, updatedAt: now});
    await writeRecord(ctx, {userId, kind: 'chat', id, value: chat, deleted: false});
    return chat;
  },
});

const chatChanges = ChatPatchSchema.omit({id: true, type: true});

export const patch = authedMutation({
  args: {chatId: v.string(), input: convexValidator(ChatPatchSchema)},
  handler: async (ctx, {userId, chatId, input}) => {
    const id = IdSchema.parse(chatId);
    const prior = await ownedChat(ctx, userId, id);
    if (!prior || prior.value.deletedAt) return null;
    const changes = chatChanges.parse(ChatPatchSchema.parse(input));
    const titleRevision = changes.title === undefined ? prior.value.titleRevision : crypto.randomUUID();
    const chat = ChatSchema.parse({
      ...decodeChat(prior.value), ...changes, titleRevision, updatedAt: new Date().toISOString(),
    });
    await writeRecord(ctx, {userId, kind: 'chat', id, value: chat, deleted: false});
    return chat;
  },
});

export const remove = authedMutation({
  args: {chatId: v.string()},
  handler: async (ctx, {userId, chatId}) => {
    const id = IdSchema.parse(chatId);
    const prior = await ownedChat(ctx, userId, id);
    if (!prior || prior.value.deletedAt) return false;
    await writeRecord(ctx, {userId, kind: 'chat', id, value: {}, deleted: true});
    return true;
  },
});
