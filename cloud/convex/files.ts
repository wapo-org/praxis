import { ConvexError, v } from 'convex/values';
import type { GenericId as Id } from 'convex/values';
import { mutation, query, type QueryCtx } from './functions.js';
import { bounded, requireServer } from './access.js';

/**
 * Owner-bound file storage. The API opens a ticket (owner, name, type, exact size) and hands the client a
 * one-time Convex upload URL; bytes go straight to Convex storage, never through a function argument.
 * The API then claims the returned storageId for that ticket: Convex's own `_storage` metadata must match
 * the ticket's size and type, and a storageId can be claimed once, by one owner.
 */
export const MAX_BYTES = 25_000_000;

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

/** A one-time direct-upload URL (POST raw bytes with Content-Type; responds `{"storageId": "..."}`). */
export const generateUploadUrl = mutation({
  args: { serverToken: v.string() },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Binds an uploaded blob to the owner's matching pending ticket. Idempotent for the same owner and file. */
export const claim = mutation({
  args: {
    serverToken: v.string(),
    userId: v.string(),
    storageId: v.string(),
    name: v.string(),
    mediaType: v.string(),
    size: v.number(),
    chatId: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    [a.userId, a.name, a.mediaType].forEach(bounded);
    const storageId = ctx.db.system.normalizeId('_storage', a.storageId);
    if (!storageId) return { ok: false };
    const same = (row: { name: string; mediaType: string; size: number; chatId?: string }) =>
      row.name === a.name && row.mediaType === a.mediaType && row.size === a.size && row.chatId === a.chatId;
    const claimed = await ctx.db.query('files').withIndex('storage', (q) => q.eq('storageId', storageId)).first();
    if (claimed) {
      if (claimed.userId === a.userId && claimed.status === 'ready' && same(claimed)) return { ok: true };
      return { ok: false };
    }
    const meta = await ctx.db.system.get(storageId);
    if (!meta) return { ok: false };
    const tickets = await ctx.db
      .query('files')
      .withIndex('owner_status', (q) => q.eq('userId', a.userId).eq('status', 'pending'))
      .take(200);
    const ticket = tickets.find((row) => row.expiresAt > Date.now() && same(row));
    const type = meta.contentType?.split(';')[0]?.trim();
    if (!ticket || meta.size !== a.size || (type && type !== a.mediaType)) {
      // Unclaimed and unmatched: drop the orphan blob so it can't be claimed later. (Returning instead of
      // throwing keeps this delete: a throwing mutation would roll it back.)
      await ctx.storage.delete(storageId);
      return { ok: false };
    }
    await ctx.db.patch(ticket._id, { status: 'ready', storageId, sha256: meta.sha256 });
    return { ok: true };
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

/** Short-lived read URL for an owned, ready file (the API fetches it; clients never see it). */
export const url = query({
  args: { serverToken: v.string(), userId: v.string(), storageId: v.string() },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    bounded(a.userId);
    const row = await owned(ctx, a.userId, a.storageId);
    if (!row || row.status !== 'ready' || !row.storageId) return null;
    const href = await ctx.storage.getUrl(row.storageId);
    return href ? { url: href, mediaType: row.mediaType, size: row.size } : null;
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
