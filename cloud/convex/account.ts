import { getAuthUserId } from '@convex-dev/auth/server';
import { ACCOUNT_DELETE_FRESHNESS_MS, AccountDeleteSchema } from '@praxis/protocol';
import { blobOwnerTag } from './blobOwner.js';
import { ConvexError, v } from 'convex/values';
import { components, internal } from './_generated/api.js';
import { mutation, query, serverAccountMutation, serverQuery } from './functions.js';
import type { MutationCtx, QueryCtx } from './functions.js';
import type { Id } from './_generated/dataModel.js';
import {activeOwner} from './accountOwner.js';
import {ACCOUNT_OWNER_ROWS, ACCOUNT_PURGE_BATCH_MAX} from './accountTables.js';
import { ACCOUNT_DELETE_RETRY_MS } from './accountRecovery.js';
import {purgeOwnedRun} from './workflows/purge.js';

async function revokeOwnerSessions(ctx: MutationCtx, userId: Id<'users'>, keepSessionId?: string): Promise<void> {
  const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId });
  await ctx.runMutation(components.auth.public.revokeSessions, {
    sessionIds: sessions.filter(session => session.sessionId !== keepSessionId).map(session => session.sessionId),
  });
}

async function eraseAuthCredentials(ctx: MutationCtx, userId: Id<'users'>): Promise<void> {
  await revokeOwnerSessions(ctx, userId);
  await ctx.runMutation(components.authPassword.public.deleteUser, { userId });
  await ctx.runMutation(components.authGoogle.provider.deleteUser, { userId });
  await ctx.runMutation(components.authEmail.verifiedEmails.deleteUser, { userId });
  // Keep the OAuth email reserved until the associated credentials are erased.
  const emails = await ctx.db.query('oauthEmails').withIndex('user', q => q.eq('userId', userId)).collect();
  for (const email of emails) await ctx.db.delete(email._id);
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
    const hasPassword = await ctx.runQuery(components.authPassword.public.hasPassword, { userId });
    if (hasPassword) {
      if (input.data.password === undefined) return null;
      const result = await ctx.runMutation(components.authPassword.public.verifyPassword, {
        userId, password: input.data.password,
      });
      return result.success ? { userId, sessionId } : null;
    }
    if (input.data.password !== undefined) return null;
    const sessions = await ctx.runQuery(components.auth.public.listSessions, { userId });
    const session = sessions.find(item => item.sessionId === sessionId);
    if (!session) return null;
    const age = Date.now() - session.creationTime;
    return age >= 0 && age < ACCOUNT_DELETE_FRESHNESS_MS ? { userId, sessionId } : null;
  },
});

export const active = serverQuery({
  args: {},
  handler: async (ctx, { userId }) => {
    return activeOwner(ctx, userId);
  },
});

export const pending = serverQuery({
  args: {},
  handler: async (ctx, { userId }) => {
    const ownerId = ctx.db.normalizeId('users', userId);
    return ownerId !== null && (await ctx.db.get(ownerId))?.deleting === true;
  },
});

// Server callers pass auth-v2 `users` ids only; anything else is not an account.
async function ownerRow(ctx: MutationCtx, userId: string) {
  const ownerId = ctx.db.normalizeId('users', userId);
  if (!ownerId) throw new ConvexError('Account unavailable');
  return { ownerId, owner: await ctx.db.get(ownerId) };
}

export const begin = serverAccountMutation({
  args: { keepSessionId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const { ownerId, owner } = await ownerRow(ctx, a.userId);
    if (!owner) throw new ConvexError('Account unavailable');
    if (a.keepSessionId !== undefined) {
      const session = await ctx.runQuery(components.auth.public.getSession, { sessionId: a.keepSessionId });
      if (session?.userId !== ownerId || (owner.deleting && owner.deletionSessionId !== a.keepSessionId)) {
        throw new ConvexError('Account deletion session unavailable');
      }
    }
    if (!owner.deleting) {
      await ctx.db.patch(ownerId, { deleting: true, deletionSessionId: a.keepSessionId });
      await ctx.scheduler.runAfter(ACCOUNT_DELETE_RETRY_MS, internal.accountRecovery.dispatch, { userId: ownerId });
    }
    await revokeOwnerSessions(ctx, ownerId, a.keepSessionId);
    return null;
  },
});
/** Bounded retryable purge erasing rows, blobs, and file tickets atomically. */
export const purge = serverAccountMutation({
  args: {
    blobCursor: v.optional(v.string()),
    blobsDone: v.optional(v.boolean()),
  },
  handler: async (ctx, a) => {
    const { ownerId, owner } = await ownerRow(ctx, a.userId);
    if (!owner) return {done: true};
    if (!owner.deleting) throw new ConvexError('Account deletion has not begun');

    if (await purgeOwnedRun(ctx, ownerId)) return {done: false};
    for (const rowsOf of Object.values(ACCOUNT_OWNER_ROWS)) {
      const rows = await rowsOf(ctx, ownerId, ACCOUNT_PURGE_BATCH_MAX);
      if (rows.length) {
        for (const row of rows) {
          if (row.storageId) await ctx.storage.delete(row.storageId);
          await ctx.db.delete(row._id);
        }
        return { done: false };
      }
    }
    // Cursor lives on the user row so retried batches resume.
    const sweep: {blobCursor?: string; blobsDone?: boolean} = owner.deletion ?? {};
    if (!a.blobsDone && !sweep.blobsDone) {
      const page = await ctx.db.system
        .query('_storage')
        .paginate({ cursor: sweep.blobCursor ?? a.blobCursor ?? null, numItems: 100 });
      const tag = await blobOwnerTag(ownerId);
      for (const blob of page.page)
        if (blob.contentType?.split(';').some((v) => v.trim() === tag))
          await ctx.storage.delete(blob._id);
      const deletion = page.isDone ? { blobsDone: true as const } : { blobCursor: page.continueCursor };
      await ctx.db.patch(ownerId, { deletion });
      if (!page.isDone) return { done: false, blobCursor: page.continueCursor };
    }
    // Same transaction as the users-row delete, so no credential outlives the owner it resolves to.
    await eraseAuthCredentials(ctx, ownerId);
    await ctx.db.delete(ownerId);
    return { done: true };
  },
});
