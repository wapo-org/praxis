import { ConvexError, v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import type { GenericId as Id } from 'convex/values';
import { action, internalMutation, internalQuery, mutation, query, type QueryCtx } from './functions.js';
import { bounded, requireServer } from './access.js';

/**
 * Owner-bound file storage. Bytes reach Convex only through the API (server credential),
 * so a storageId is bound to its owner when it is created and never taken from a client claim.
 */
const MAX_BYTES = 16 * 1024 * 1024 - 64 * 1024;

const pendingRef = makeFunctionReference<'query'>('files:pending');
const commitRef = makeFunctionReference<'mutation'>('files:commit');
const ownedRef = makeFunctionReference<'query'>('files:ownedInternal');

function owned(ctx: QueryCtx, userId: string, storageId: string) {
  return ctx.db
    .query('files')
    .withIndex('owner_storage', (q) => q.eq('userId', userId).eq('storageId', storageId as Id<'_storage'>))
    .unique();
}

function ticketRow(ctx: QueryCtx, userId: string, ticket: string) {
  return ctx.db
    .query('files')
    .withIndex('owner_ticket', (q) => q.eq('userId', userId).eq('ticket', ticket))
    .unique();
}

export const createTicket = mutation({
  args: {
    serverToken: v.string(),
    userId: v.string(),
    ticket: v.string(),
    name: v.string(),
    mediaType: v.string(),
    size: v.number(),
    chatId: v.optional(v.string()),
    expiresAt: v.number(),
  },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    [a.userId, a.ticket, a.name, a.mediaType].forEach(bounded);
    if (a.chatId !== undefined) bounded(a.chatId);
    if (!Number.isInteger(a.size) || a.size < 1 || a.size > MAX_BYTES) throw new ConvexError('Invalid upload size');
    if (await ticketRow(ctx, a.userId, a.ticket)) throw new ConvexError('Upload ticket exists');
    await ctx.db.insert('files', {
      userId: a.userId,
      ticket: a.ticket,
      name: a.name,
      mediaType: a.mediaType,
      size: a.size,
      ...(a.chatId === undefined ? {} : { chatId: a.chatId }),
      expiresAt: a.expiresAt,
      status: 'pending',
    });
    return null;
  },
});

export const pending = internalQuery({
  args: { userId: v.string(), ticket: v.string() },
  handler: async (ctx, a) => {
    const row = await ticketRow(ctx, a.userId, a.ticket);
    if (!row || row.status !== 'pending' || row.expiresAt <= Date.now()) return null;
    return { mediaType: row.mediaType, size: row.size };
  },
});

export const commit = internalMutation({
  args: { userId: v.string(), ticket: v.string(), storageId: v.id('_storage') },
  handler: async (ctx, a) => {
    const row = await ticketRow(ctx, a.userId, a.ticket);
    const meta = await ctx.db.system.get(a.storageId);
    if (!row || row.status !== 'pending' || row.expiresAt <= Date.now() || !meta || meta.size !== row.size) {
      await ctx.storage.delete(a.storageId);
      throw new ConvexError('Upload ticket not found');
    }
    await ctx.db.patch(row._id, { status: 'ready', storageId: a.storageId, sha256: meta.sha256 });
    return null;
  },
});

/** Stores bytes for a pending ticket of the same owner, media type and exact size. */
export const store = action({
  args: { serverToken: v.string(), userId: v.string(), ticket: v.string(), mediaType: v.string(), bytes: v.bytes() },
  handler: async (ctx, a): Promise<string> => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    const ticket = (await ctx.runQuery(pendingRef, { userId: a.userId, ticket: a.ticket })) as
      | { mediaType: string; size: number }
      | null;
    if (!ticket) throw new ConvexError('Upload ticket not found');
    if (ticket.mediaType !== a.mediaType || ticket.size !== a.bytes.byteLength) {
      throw new ConvexError('Upload size or media type differs from request');
    }
    const storageId = await ctx.storage.store(new Blob([a.bytes], { type: a.mediaType }));
    await ctx.runMutation(commitRef, { userId: a.userId, ticket: a.ticket, storageId });
    return storageId;
  },
});

export const metadata = query({
  args: { serverToken: v.string(), userId: v.string(), storageId: v.string() },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    const row = await owned(ctx, a.userId, a.storageId);
    if (!row || row.status !== 'ready') return null;
    return {
      name: row.name,
      mediaType: row.mediaType,
      size: row.size,
      ...(row.chatId === undefined ? {} : { chatId: row.chatId }),
      ...(row.sha256 === undefined ? {} : { sha256: row.sha256 }),
    };
  },
});

export const ownedInternal = internalQuery({
  args: { userId: v.string(), storageId: v.string() },
  handler: async (ctx, a) => {
    const row = await owned(ctx, a.userId, a.storageId);
    return row && row.status === 'ready' ? { storageId: row.storageId!, mediaType: row.mediaType } : null;
  },
});

export const read = action({
  args: { serverToken: v.string(), userId: v.string(), storageId: v.string() },
  handler: async (ctx, a): Promise<{ bytes: ArrayBuffer; mediaType: string } | null> => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    const row = (await ctx.runQuery(ownedRef, { userId: a.userId, storageId: a.storageId })) as
      | { storageId: Id<'_storage'>; mediaType: string }
      | null;
    if (!row) return null;
    const blob = await ctx.storage.get(row.storageId);
    if (!blob) return null;
    return { bytes: await blob.arrayBuffer(), mediaType: row.mediaType };
  },
});

export const remove = mutation({
  args: { serverToken: v.string(), userId: v.string(), storageId: v.string() },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    const row = await owned(ctx, a.userId, a.storageId);
    if (!row) return false;
    if (row.storageId) await ctx.storage.delete(row.storageId);
    await ctx.db.delete(row._id);
    return true;
  },
});

/** Deletes up to 100 expired, never-completed tickets. Safe to call from a cron or the API. */
export const sweep = mutation({
  args: { serverToken: v.string() },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    const expired = await ctx.db
      .query('files')
      .withIndex('status_expires', (q) => q.eq('status', 'pending').lt('expiresAt', Date.now()))
      .take(100);
    for (const row of expired) await ctx.db.delete(row._id);
    return expired.length;
  },
});
