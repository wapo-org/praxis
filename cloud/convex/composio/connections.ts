import { ConvexError, v } from 'convex/values';
import { activeOwner } from '../accountOwner.js';
import { internal } from '../_generated/api.js';
import { action, authenticatedUserId, internalMutation, query } from '../functions.js';
import { COMPOSIO_ERRORS } from './constants.js';
import { webhookStatus } from './schema.js';

export const markFromWebhook = internalMutation({
  args: { connectedAccountId: v.string(), status: webhookStatus },
  handler: async (ctx, { connectedAccountId, status }) => {
    const row = await ctx.db.query('connections')
      .withIndex('by_connected_account', q => q.eq('connectedAccountId', connectedAccountId))
      .unique();
    if (row?.status !== 'pending' || !await activeOwner(ctx, row.userId)) return false;
    await ctx.db.patch(row._id, { status, updatedAt: Date.now() });
    return true;
  },
});

export const list = query({
  args: {},
  handler: async ctx => {
    const userId = await authenticatedUserId(ctx);
    if (!await activeOwner(ctx, userId)) throw new ConvexError(COMPOSIO_ERRORS.accountUnavailable);
    return ctx.db.query('connections')
      .withIndex('by_user_toolkit', q => q.eq('userId', userId))
      .collect();
  },
});

export const connect = action({
  args: { toolkit: v.string(), returnTo: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const userId = await authenticatedUserId(ctx);
    return ctx.runAction(internal.composio.actions.connect, { ...args, userId });
  },
});

export const disconnect = action({
  args: { toolkit: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const userId = await authenticatedUserId(ctx);
    return ctx.runAction(internal.composio.actions.disconnect, { ...args, userId });
  },
});
