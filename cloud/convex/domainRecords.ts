import {APPROVAL_RECORD_KIND, ChatSchema, IdSchema, MessageSchema, RunSchema, type RunTaint} from '@praxis/protocol';
import {ConvexError} from 'convex/values';
import {z} from 'zod';
import {cancelChatRun} from './runs.js';
import {decodeChat, decodeMessage, encodeChat, encodePart} from './domainValues.js';
import type {Doc} from './_generated/dataModel.js';
import type {MutationCtx, QueryCtx} from './functions.js';
import {approvalValue, ownedApproval, saveApproval} from './approvalRecords.js';

export type DomainKind = 'chat' | 'message' | 'run' | 'outputChunk' | typeof APPROVAL_RECORD_KIND;

export function isDomainKind(kind: string): kind is DomainKind {
  return kind === 'chat' || kind === 'message' || kind === 'run' || kind === 'outputChunk' || kind === APPROVAL_RECORD_KIND;
}

type DomainDoc = Doc<'chats'> | Doc<'messages'> | Doc<'runs'> | Doc<'outputs'> | Doc<'approvals'>;

export function ownedChat(ctx: QueryCtx, userId: string, chatId: string) {
  return ctx.db.query('chats').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', chatId)).unique();
}

export async function requireChat(ctx: QueryCtx, userId: string, chatId: string) {
  const chat = await ownedChat(ctx, userId, chatId);
  if (!chat || chat.value.deletedAt) throw new ConvexError('Chat unavailable');
  return chat;
}

/** Atomic OR inside the caller's mutation: a stale writer can never clear or replace a run's recorded taint. */
export function keptRunTaint(prior: RunTaint | undefined, next: RunTaint | undefined): RunTaint | undefined {
  return prior ?? next;
}

export function ownedRun(ctx: QueryCtx, userId: string, runId: string) {
  return ctx.db.query('runs').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', runId)).unique();
}

function ownedMessage(ctx: QueryCtx, userId: string, id: string) {
  return ctx.db.query('messages').withIndex('by_user_id', q => q.eq('userId', userId).eq('id', id)).unique();
}

export async function domainDocument(ctx: QueryCtx, userId: string, kind: DomainKind, id: string) {
  switch (kind) {
    case APPROVAL_RECORD_KIND:
      return ownedApproval(ctx, userId, id);
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
  if ('argsHash' in doc) return {...base, parentId: doc.runId, value: approvalValue(doc)};
  if ('lastSequence' in doc) return {...base, value: decodeChat(doc.value)};
  if ('sequence' in doc) return {...base, parentId: doc.chatId, value: decodeMessage(doc.value)};
  if ('text' in doc) return {...base, parentId: doc.parentId, value: {chatId: doc.chatId, text: doc.text}};
  return {...base, parentId: doc.chatId, value: doc.value};
}

type Page<T> = {page: T[]; continueCursor: string; isDone: boolean};
type Paged<T> = {paginate(options: {cursor: string | null; numItems: number}): Promise<Page<T>>};
export type DomainListPage = {rows: ReturnType<typeof domainRow>[]; cursor: string | null};

function domainQuery(ctx: QueryCtx, userId: string, kind: DomainKind, parentId?: string): Paged<DomainDoc> | undefined {
  switch (kind) {
    case APPROVAL_RECORD_KIND:
      return parentId === undefined
        ? ctx.db.query('approvals').withIndex('by_user_id', q => q.eq('userId', userId))
        : ctx.db.query('approvals').withIndex('by_user_run', q => q.eq('userId', userId).eq('runId', parentId));
    case 'chat':
      return parentId === undefined ? ctx.db.query('chats').withIndex('by_user_id', q => q.eq('userId', userId)) : undefined;
    case 'message':
      return parentId === undefined
        ? ctx.db.query('messages').withIndex('by_user_id', q => q.eq('userId', userId))
        : ctx.db.query('messages').withIndex('by_chat_sequence', q => q.eq('userId', userId).eq('chatId', parentId));
    case 'run':
      return parentId === undefined
        ? ctx.db.query('runs').withIndex('by_user_id', q => q.eq('userId', userId))
        : ctx.db.query('runs').withIndex('by_user_chat', q => q.eq('userId', userId).eq('chatId', parentId));
    case 'outputChunk':
      return parentId === undefined
        ? ctx.db.query('outputs').withIndex('by_user_id', q => q.eq('userId', userId))
        : ctx.db.query('outputs').withIndex('by_user_output', q => q.eq('userId', userId).eq('parentId', parentId));
  }
}

/** Workflow runs and deleted chats are not Store rows; a filtered page may come back short, the cursor still advances. */
function isStoreRow(doc: DomainDoc): boolean {
  if ('lastSequence' in doc) return !doc.value.deletedAt;
  return !('workflow' in doc && doc.workflow);
}

export async function listDomainRows(
  ctx: QueryCtx, userId: string, kind: DomainKind, page: {cursor: string | null; numItems: number}, parentId?: string,
): Promise<DomainListPage> {
  const query = domainQuery(ctx, userId, kind, parentId);
  if (!query) return {rows: [], cursor: null};
  const result = await query.paginate(page);
  return {
    rows: result.page.filter(isStoreRow).map(doc => domainRow(kind, doc)),
    cursor: result.isDone ? null : result.continueCursor,
  };
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
    case APPROVAL_RECORD_KIND:
      return saveApproval(ctx, input);
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
      const parsed = RunSchema.parse(input.value);
      validateAddress(input, parsed);
      await requireChat(ctx, userId, parsed.chatId);
      const prior = await ownedRun(ctx, userId, id);
      if (prior?.workflow || (prior && prior.chatId !== parsed.chatId)) throw new ConvexError('Run address unavailable');
      const taint = keptRunTaint(prior?.value.taint, parsed.taint);
      const value = {...parsed, ...(taint && {taint})};
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
