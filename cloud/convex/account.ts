import { blobOwnerTag } from './blobOwner.js';
import { v } from 'convex/values';
import { serverMutation, serverQuery } from './functions.js';
import {activeOwner, beginOwnerDeletion, deleteOwnerUser} from './accountOwner.js';
import {ACCOUNT_OWNER_ROWS, ACCOUNT_PURGE_BATCH_MAX} from './accountTables.js';
import {purgeOwnedRun} from './workflows/purge.js';
export const active = serverQuery({
  args: { serverToken: v.string(), userId: v.string() },
  handler: async (ctx, a) => {
    return activeOwner(ctx, a.userId);
  },
});
export const begin = serverMutation({
  args: { serverToken: v.string(), userId: v.string() },
  handler: async (ctx, a) => {
    await beginOwnerDeletion(ctx, a.userId);
    return null;
  },
});
/** Bounded retryable purge erasing rows, blobs, and file tickets atomically. */
export const purge = serverMutation({
  args: {
    serverToken: v.string(),
    userId: v.string(),
    keepSessionId: v.optional(v.string()),
    retainClerk: v.optional(v.boolean()),
    blobCursor: v.optional(v.string()),
    blobsDone: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    if (await purgeOwnedRun(ctx, a.userId)) return {done: false};
    for (const rowsOf of Object.values(ACCOUNT_OWNER_ROWS)) {
      const rows = await rowsOf(ctx, a.userId, ACCOUNT_PURGE_BATCH_MAX);
      if (rows.length) {
        for (const row of rows) {
          if (row.storageId) await ctx.storage.delete(row.storageId);
          await ctx.db.delete(row._id);
        }
        return { done: false };
      }
    }
    const user = await ctx.db
      .query('authDocuments')
      .withIndex('model_id', (q) => q.eq('model', 'user').eq('id', a.userId))
      .unique();
    // Cursor lives on the user row so retried batches resume.
    const sweep = (user?.data.deletion ?? {}) as { blobCursor?: string; blobsDone?: boolean };
    if (!a.blobsDone && !sweep.blobsDone) {
      const page = await ctx.db.system
        .query('_storage')
        .paginate({ cursor: sweep.blobCursor ?? a.blobCursor ?? null, numItems: 100 });
      const tag = await blobOwnerTag(a.userId);
      for (const blob of page.page)
        if (blob.contentType?.split(';').some((v) => v.trim() === tag))
          await ctx.storage.delete(blob._id);
      const deletion = page.isDone ? { blobsDone: true } : { blobCursor: page.continueCursor };
      if (user) await ctx.db.patch(user._id, { data: { ...user.data, deletion } });
      if (!page.isDone) return { done: false, blobCursor: page.continueCursor };
    }
    // Retain user row until final batch so email stays available for verification cleanup.
    const email = user?.data.email;
    const owned = new Map();
    for (const model of ['session', 'account', 'verification', 'rateLimit']) {
      const rows = await ctx.db
        .query('authDocuments')
        .withIndex('model_user', (q) => q.eq('model', model).eq('data.userId', a.userId))
        .take(101);
      for (const row of rows)
        if (
          !(row.model === 'session' && row.id === a.keepSessionId) &&
          !(row.model === 'account' && (row.data.providerId === 'credential' || (a.retainClerk && row.data.providerId === 'clerk')))
        )
          owned.set(row._id, row);
    }
    for (const value of [
      a.userId,
      ...(typeof email === 'string' ? [email, `email-verification:${email}`] : []),
    ]) {
      for (const model of ['verification', 'rateLimit'])
        for (const index of ['model_identifier', 'model_value'] as const) {
          const rows = await (ctx.db.query('authDocuments') as any)
            .withIndex(index, (q: any) =>
              q
                .eq('model', model)
                .eq(index === 'model_value' ? 'data.value' : 'data.identifier', value),
            )
            .take(100);
          for (const row of rows) owned.set(row._id, row);
        }
    }
    if (owned.size) {
      for (const row of [...owned.values()].slice(0, 100)) await ctx.db.delete(row._id);
      return { done: false, blobsDone: true };
    }
    // Finish the distributed Clerk deletion only after all owned data is gone, keeping its binding retryable.
    if (a.retainClerk) return { done: false, ready: true, blobsDone: true };
    const retained = await ctx.db
      .query('authDocuments')
      .withIndex('model_user', (q) => q.eq('model', 'session').eq('data.userId', a.userId))
      .take(100);
    for (const row of retained) await ctx.db.delete(row._id);
    const credentials = await ctx.db
      .query('authDocuments')
      .withIndex('model_user', (q) => q.eq('model', 'account').eq('data.userId', a.userId))
      .collect();
    for (const row of credentials) await ctx.db.delete(row._id);
    if (user) await ctx.db.delete(user._id);
    await deleteOwnerUser(ctx, a.userId);
    return { done: true };
  },
});
