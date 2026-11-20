import {ChatSchema, IdSchema, MessageSchema, RunSchema} from '@praxis/protocol';
import {ConvexError} from 'convex/values';
import {z} from 'zod';
import {cancelChatRun} from './runs.js';
import {decodeChat, decodeMessage, encodeChat, encodePart} from './domainValues.js';
import type {Doc} from './_generated/dataModel.js';
import type {MutationCtx, QueryCtx} from './functions.js';

export type DomainKind = 'chat' | 'message' | 'run' | 'outputChunk';

export function isDomainKind(kind: string): kind is DomainKind {
  return kind === 'chat' || kind === 'message' || kind === 'run' || kind === 'outputChunk';
}

type DomainDoc = Doc<'chats'> | Doc<'messages'> | Doc<'runs'> | Doc<'outputs'>;

export function ownedChat(ctx: QueryCtx, userId: string, chatId: string) {
  return ctx.db.query('chats').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', chatId)).unique();
}

export async function requireChat(ctx: QueryCtx, userId: string, chatId: string) {
  const chat = await ownedChat(ctx, userId, chatId);
  if (!chat || chat.value.deletedAt) throw new ConvexError('Chat unavailable');
  return chat;
}

export function ownedRun(ctx: QueryCtx, userId: string, runId: string) {
  return ctx.db.query('runs').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', runId)).unique();
}

function ownedMessage(ctx: QueryCtx, userId: string, id: string) {
  return ctx.db.query('messages').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', id)).unique();
}

export async function domainDocument(ctx: QueryCtx, userId: string, kind: DomainKind, id: string) {
  switch (kind) {
    case 'chat': {
      const row = await ownedChat(ctx, userId, id);
      return row?.value.deletedAt ? null : row;
    }
    case 'message': return ownedMessage(ctx, userId, id);
    case 'run': {
      const row = await ownedRun(ctx, userId, id);
      return row?.workflow ? null : row;
    }
    case 'outputChunk':
      return ctx.db.query('outputs').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', id)).unique();
  }
}

export function domainRow(kind: DomainKind, doc: DomainDoc) {
  const {id, userId, updatedAt, revision} = doc;
  const base = {id, userId, kind, updatedAt, revision, deleted: false};
  if ('lastSequence' in doc) return {...base, value: decodeChat(doc.value)};
  if ('sequence' in doc) return {...base, parentId: doc.chatId, value: decodeMessage(doc.value)};
  if ('text' in doc) return {...base, parentId: doc.parentId, value: {chatId: doc.chatId, text: doc.text}};
  return {...base, parentId: doc.chatId, value: doc.value};
}

export async function listDomainRows(ctx: QueryCtx, userId: string, kind: DomainKind, parentId?: string) {
  let docs: DomainDoc[];
  switch (kind) {
    case 'chat':
      docs = parentId === undefined
        ? await ctx.db.query('chats').withIndex('by_user_id', q => q.eq('userId', userId)).collect()
        : [];
      break;
    case 'message':
      docs = parentId === undefined
        ? await ctx.db.query('messages').withIndex('by_user_id', q => q.eq('userId', userId)).collect()
        : await ctx.db.query('messages').withIndex('by_chat_sequence', q => q.eq('userId', userId).eq('chatId', parentId)).collect();
      break;
    case 'run': {
      const rows = parentId === undefined
        ? await ctx.db.query('runs').withIndex('by_user_id', q => q.eq('userId', userId)).collect()
        : await ctx.db.query('runs').withIndex('by_user_chat', q => q.eq('userId', userId).eq('chatId', parentId)).collect();
      docs = rows.filter(row => !row.workflow);
      break;
    }
    case 'outputChunk':
      docs = parentId === undefined
        ? await ctx.db.query('outputs').withIndex('by_user_id', q => q.eq('userId', userId)).collect()
        : await ctx.db.query('outputs').withIndex('by_user_output', q => q.eq('userId', userId).eq('parentId', parentId)).collect();
      break;
  }
  return docs.filter(doc => !('lastSequence' in doc && doc.value.deletedAt)).map(doc => domainRow(kind, doc));
}

type DomainWrite = {
  userId: string;
  id: string;
  revision: number;
  updatedAt: string;
  parentId?: string;
  value: unknown;
};

function validateAddress(input: DomainWrite, value: {id: string; chatId?: string}) {
  if (input.id !== value.id || (input.parentId !== undefined && input.parentId !== value.chatId)) {
    throw new ConvexError('Record address does not match value');
  }
}

export async function saveDomainRow(ctx: MutationCtx, kind: DomainKind, input: DomainWrite) {
  const {id, userId, updatedAt, revision} = input;
  const metadata = {id, userId, updatedAt, revision};
  switch (kind) {
    case 'chat': {
      const chat = ChatSchema.parse(input.value);
      validateAddress(input, chat);
      const prior = await ownedChat(ctx, userId, id);
      const value = encodeChat(chat);
      const row = {...metadata, value, lastSequence: prior?.lastSequence ?? 0};
      if (prior) await ctx.db.replace(prior._id, row);
      else await ctx.db.insert('chats', row);
      return {value: chat};
    }
    case 'message': {
      const message = MessageSchema.parse(input.value);
      validateAddress(input, message);
      const {chatId, parts, raw} = message;
      const chat = await requireChat(ctx, userId, chatId);
      const prior = await ownedMessage(ctx, userId, id);
      if (prior && prior.chatId !== chatId) throw new ConvexError('Message chat cannot change');
      // Edits advance the sync revision while preserving the message's position in the chat.
      const sequence = prior?.sequence ?? chat.lastSequence + 1;
      if (!Number.isSafeInteger(sequence)) throw new ConvexError('Message sequence exhausted');
      const value = {...message, sequence};
      const row = {...metadata, chatId, sequence, value: {
        ...value, parts: parts.map(encodePart), ...(raw ? {raw: {...raw, data: JSON.stringify(raw.data)}} : {raw: undefined}),
      }};
      if (prior) await ctx.db.replace(prior._id, row);
      else {
        await ctx.db.insert('messages', row);
        await ctx.db.patch(chat._id, {lastSequence: sequence});
      }
      return {value, parentId: chatId};
    }
    case 'run': {
      const value = RunSchema.parse(input.value);
      validateAddress(input, value);
      await requireChat(ctx, userId, value.chatId);
      const prior = await ownedRun(ctx, userId, id);
      if (prior?.workflow || (prior && prior.chatId !== value.chatId)) throw new ConvexError('Run address unavailable');
      const row = {...metadata, chatId: value.chatId, value};
      if (prior) await ctx.db.replace(prior._id, row);
      else await ctx.db.insert('runs', row);
      return {value, parentId: value.chatId};
    }
    case 'outputChunk': {
      const value = outputChunkSchema.parse(input.value);
      const parentId = IdSchema.parse(input.parentId);
      await requireChat(ctx, userId, value.chatId);
      const prior = await ctx.db.query('outputs')
        .withIndex('by_user_id', q => q.eq('userId', userId).eq('id', id)).unique();
      if (prior && (prior.chatId !== value.chatId || prior.parentId !== parentId)) {
        throw new ConvexError('Output chunk address cannot change');
      }
      const row = {...metadata, ...value, parentId};
      if (prior) await ctx.db.replace(prior._id, row);
      else await ctx.db.insert('outputs', row);
      return {value, parentId};
    }
  }
}

const outputChunkSchema = z.object({chatId: IdSchema, text: z.string()}).strict();

export async function deleteDomainRow(ctx: MutationCtx, doc: DomainDoc, updatedAt: string) {
  if ('lastSequence' in doc) {
    await cancelChatRun(ctx, doc.userId, doc.id);
    await ctx.db.patch(doc._id, {value: {...doc.value, deletedAt: updatedAt, updatedAt}});
  } else {
    await ctx.db.delete(doc._id);
  }
}
