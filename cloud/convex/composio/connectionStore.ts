import { v } from 'convex/values';
import { activeOwner } from '../accountOwner.js';
import { internalMutation, internalQuery, type QueryCtx } from '../functions.js';

const scope = { userId: v.string(), toolkit: v.string() };
const link = {
  connectedAccountId: v.string(),
  redirectUrl: v.string(),
  expiresAt: v.number(),
};

function connection(ctx: QueryCtx, {userId, toolkit}: {userId: string; toolkit: string}) {
  return ctx.db.query('connections')
    .withIndex('by_user_toolkit', q => q.eq('userId', userId).eq('toolkit', toolkit))
    .unique();
}

export const get = internalQuery({
  args: scope,
  handler: async (ctx, args) => {
    if (!await activeOwner(ctx, args.userId)) return { active: false as const };
    return { active: true as const, row: await connection(ctx, args) };
  },
});

export const beginConnect = internalMutation({
  args: scope,
  handler: async (ctx, args) => {
    if (!await activeOwner(ctx, args.userId)) return { status: 'unavailable' as const };
    const row = await connection(ctx, args);
    if (!row) return { status: 'create' as const };
    if (row.status === 'connected') return { status: 'connected' as const };

    if (row.status === 'pending') {
      const now = Date.now();
      if (row.expiresAt > now) return { status: 'reused' as const, redirectUrl: row.redirectUrl };
      // Fence late webhooks before revoking an expired account.
      await ctx.db.patch(row._id, { status: 'failed', updatedAt: now });
    }
    return { status: 'create' as const, previousAccountId: row.connectedAccountId };
  },
});

export const store = internalMutation({
  args: {
    ...scope,
    ...link,
    previousAccountId: v.optional(v.string()),
  },
  handler: async (ctx, {previousAccountId, userId, toolkit, ...candidate}) => {
    if (!await activeOwner(ctx, userId)) return { status: 'unavailable' as const };
    const current = await connection(ctx, {userId, toolkit});
    const now = Date.now();

    if (current?.connectedAccountId === candidate.connectedAccountId
      && (current.status === 'connected' || (current.status === 'pending' && current.expiresAt > now))) {
      return { status: 'saved' as const, redirectUrl: current.redirectUrl };
    }
    if (current?.status === 'pending' && current.expiresAt > now) {
      return { status: 'reused' as const, redirectUrl: current.redirectUrl };
    }
    if (current?.status === 'connected' || current?.connectedAccountId !== previousAccountId || candidate.expiresAt <= now) {
      return { status: 'changed' as const };
    }

    if (current) await ctx.db.delete(current._id);
    await ctx.db.insert('connections', {
      userId, toolkit, ...candidate, status: 'pending', createdAt: now, updatedAt: now,
    });
    return { status: 'saved' as const, redirectUrl: candidate.redirectUrl };
  },
});

export const remove = internalMutation({
  args: { ...scope, connectedAccountId: v.string() },
  handler: async (ctx, args) => {
    const row = await connection(ctx, args);
    if (row?.connectedAccountId === args.connectedAccountId) await ctx.db.delete(row._id);
  },
});
