import { getAuthUserId } from '@convex-dev/auth/server';
import { ACCOUNT_DELETE_FRESHNESS_MS, AccountDeleteSchema } from '@praxis/protocol';
import { blobOwnerTag } from './blobOwner.js';
import { ConvexError, v } from 'convex/values';
import { components } from './_generated/api.js';
import { mutation, query, serverMutation, serverQuery } from './functions.js';
import type { MutationCtx, QueryCtx } from './functions.js';
import type { Id } from './_generated/dataModel.js';
import {activeOwner, beginOwnerDeletion, deleteOwnerUser} from './accountOwner.js';
import {ACCOUNT_OWNER_ROWS, ACCOUNT_PURGE_BATCH_MAX} from './accountTables.js';
import {purgeOwnedRun} from './workflows/purge.js';

async function revokeOwnerSessions(ctx: MutationCtx, userId: Id<'users'>, keepSessionId?: string): Promise<void> {
  const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId });
  await ctx.runMutation(components.auth.public.revokeSessions, {
    sessionIds: sessions.filter(session => session.sessionId !== keepSessionId).map(session => session.sessionId),
  });
}

// Password and OAuth deletes exist only via cloud/patches/@convex-dev+auth+2.0.0.patch (PRA-64).
async function eraseAuthCredentials(ctx: MutationCtx, userId: Id<'users'>): Promise<void> {
  await revokeOwnerSessions(ctx, userId);
  await ctx.runMutation(components.authPassword.public.deleteUser, { userId });
  await ctx.runMutation(components.authGoogle.provider.deleteUser, { userId });
  await ctx.runMutation(components.authApple.provider.deleteUser, { userId });
  await ctx.runMutation(components.authEmail.verifiedEmails.deleteUser, { userId });
}

async function deletionIdentity(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  const identity = await ctx.auth.getUserIdentity();
  if (!userId || !identity) return null;
  const user = await ctx.db.get(userId);
  if (!user || (user.deleting && user.deletionSessionId !== identity.subject)) return null;
  return { userId, sessionId: identity.subject, pending: user.deleting === true };
}

// Only the session that began deletion may retry after the account is fenced.
export const deletionOwner = query({
  args: {},
  handler: async ctx => {
    const identity = await deletionIdentity(ctx);
    return identity ? { userId: identity.userId, pending: identity.pending } : null;
  },
});

export const confirmDeletion = mutation({
  args: { password: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const input = AccountDeleteSchema.safeParse(args);
    if (!input.success) return null;
    const identity = await deletionIdentity(ctx);
    if (!identity) return null;
    const { userId, sessionId, pending } = identity;
    if (pending) return { userId, sessionId };
    if (input.data.password !== undefined) {
      const emails = await ctx.runQuery(components.authEmail.verifiedEmails.getEmails, { userId });
      if (!emails.length) return null;
      const result = await ctx.runMutation(components.authPassword.public.verifyPassword, {
        userId, password: input.data.password,
      });
      return result.success ? { userId, sessionId } : null;
    }
    const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId });
    const session = sessions.find(item => item.sessionId === sessionId);
    if (!session) return null;
    const age = Date.now() - session.creationTime;
    return age >= 0 && age < ACCOUNT_DELETE_FRESHNESS_MS ? { userId, sessionId } : null;
  },
});

export const active = serverQuery({
  args: { serverToken: v.string(), userId: v.string() },
  handler: async (ctx, a) => {
    return activeOwner(ctx, a.userId);
  },
});
export const begin = serverMutation({
  args: { serverToken: v.string(), userId: v.string(), keepSessionId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const ownerId = ctx.db.normalizeId('users', a.userId);
    if (!ownerId) {
      await beginOwnerDeletion(ctx, a.userId);
      return null;
    }
    const owner = await ctx.db.get(ownerId);
    if (!owner) throw new ConvexError('Account unavailable');
    if (a.keepSessionId !== undefined) {
      const session = await ctx.runQuery(components.auth.public.getSession, { sessionId: a.keepSessionId });
      if (session?.userId !== ownerId || (owner.deleting && owner.deletionSessionId !== a.keepSessionId)) {
        throw new ConvexError('Account deletion session unavailable');
      }
    }
    await ctx.db.patch(ownerId, { deleting: true, deletionSessionId: a.keepSessionId });
    await revokeOwnerSessions(ctx, ownerId, a.keepSessionId);
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
    const ownerId = ctx.db.normalizeId('users', a.userId);
    const owner = ownerId ? await ctx.db.get(ownerId) : null;
    const sweep = (owner?.deletion ?? user?.data.deletion ?? {}) as { blobCursor?: string; blobsDone?: boolean };
    if (!a.blobsDone && !sweep.blobsDone) {
      const page = await ctx.db.system
        .query('_storage')
        .paginate({ cursor: sweep.blobCursor ?? a.blobCursor ?? null, numItems: 100 });
      const tag = await blobOwnerTag(a.userId);
      for (const blob of page.page)
        if (blob.contentType?.split(';').some((v) => v.trim() === tag))
          await ctx.storage.delete(blob._id);
      const deletion = page.isDone ? { blobsDone: true as const } : { blobCursor: page.continueCursor };
      if (owner) await ctx.db.patch(owner._id, { deletion });
      else if (user) await ctx.db.patch(user._id, { data: { ...user.data, deletion } });
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
    // Same transaction as the users-row delete, so no credential outlives the owner it resolves to.
    if (ownerId) await eraseAuthCredentials(ctx, ownerId);
    if (user) await ctx.db.delete(user._id);
    await deleteOwnerUser(ctx, a.userId);
    return { done: true };
  },
});
