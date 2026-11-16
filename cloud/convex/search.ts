import { makeFunctionReference } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import type { GenericId as Id } from 'convex/values';
import { action, internalQuery, mutation, query } from './functions.js';
import { bounded, requireServer } from './access.js';

export const DIMENSIONS = 384;
const scopeOf = (userId: string, embedder: string) => `${bounded(userId)}\u0000${bounded(embedder)}`;
const owner = { serverToken: v.string(), userId: v.string(), embedder: v.string() };

/** Item ids for the owner, a page at a time. */
export const ids = query({
  args: { ...owner, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    const page = await ctx.db
      .query('embeddings')
      .withIndex('scope_item', (q) => q.eq('scope', scopeOf(a.userId, a.embedder)))
      .paginate({ cursor: a.cursor, numItems: 500 });
    return { ids: page.page.map((r) => r.itemId), cursor: page.isDone ? null : page.continueCursor };
  },
});

export const upsert = mutation({
  args: {
    ...owner,
    items: v.array(v.object({ itemId: v.string(), chatId: v.string(), text: v.string(), vector: v.array(v.float64()) })),
  },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    if (a.items.length > 64) throw new ConvexError('Too many items');
    const scope = scopeOf(a.userId, a.embedder);
    for (const item of a.items) {
      if (item.vector.length !== DIMENSIONS) throw new ConvexError('Wrong vector size');
      const prior = await ctx.db
        .query('embeddings')
        .withIndex('scope_item', (q) => q.eq('scope', scope).eq('itemId', bounded(item.itemId)))
        .unique();
      const row = { userId: a.userId, scope, itemId: item.itemId, chatId: bounded(item.chatId), text: item.text.slice(0, 2000), vector: item.vector };
      if (prior) await ctx.db.replace(prior._id, row);
      else await ctx.db.insert('embeddings', row);
    }
  },
});

export const remove = mutation({
  args: { ...owner, itemIds: v.array(v.string()) },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    if (a.itemIds.length > 200) throw new ConvexError('Too many items');
    const scope = scopeOf(a.userId, a.embedder);
    for (const itemId of a.itemIds) {
      const row = await ctx.db
        .query('embeddings')
        .withIndex('scope_item', (q) => q.eq('scope', scope).eq('itemId', bounded(itemId)))
        .unique();
      if (row) await ctx.db.delete(row._id);
    }
  },
});

/** Rows for vector hits, read back inside the action (vector search returns ids and scores only). */
export const rows = internalQuery({
  args: { ids: v.array(v.id('embeddings')) },
  handler: async (ctx, a) => Promise.all(a.ids.map((id) => ctx.db.get(id))),
});

export const search = action({
  args: { ...owner, vector: v.array(v.float64()), limit: v.number() },
  handler: async (ctx, a) => {
    await requireServer(a.serverToken);
    if (a.vector.length !== DIMENSIONS) throw new ConvexError('Wrong vector size');
    const scope = scopeOf(a.userId, a.embedder);
    const found = await ctx.vectorSearch('embeddings', 'by_vector', {
      vector: a.vector,
      limit: Math.max(1, Math.min(256, Math.floor(a.limit))),
      filter: (q) => q.eq('scope', scope),
    });
    const docs = (await ctx.runQuery(makeFunctionReference<'query', { ids: Id<'embeddings'>[] }, unknown>('search:rows'), { ids: found.map((f) => f._id) })) as ({
      scope: string;
      itemId: string;
      chatId: string;
      text: string;
    } | null)[];
    return found.flatMap((f, i) => {
      const doc = docs[i];
      return doc && doc.scope === scope ? [{ id: doc.itemId, chatId: doc.chatId, text: doc.text, score: f._score }] : [];
    });
  },
});
