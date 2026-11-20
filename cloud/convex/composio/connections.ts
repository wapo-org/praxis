import { type ComposioAppPage } from '@praxis/protocol';
import { v } from 'convex/values';
import { activeOwner } from '../accountOwner.js';
import { internal } from '../_generated/api.js';
import { authedAction, authedQuery, internalMutation } from '../functions.js';
import { webhookStatus } from './schema.js';

export const markFromWebhook = internalMutation({
  args: { connectedAccountId: v.string(), status: webhookStatus },
  handler: async (ctx, { connectedAccountId, status }) => {
    const row = await ctx.db.query('connections')
      .withIndex('by_connected_account', q => q.eq('connectedAccountId', connectedAccountId))
      .unique();
    if (!row || row.status === status || row.status === 'failed' || !await activeOwner(ctx, row.userId)) {
      return false;
    }
    await ctx.db.patch(row._id, { status, updatedAt: Date.now() });
    return true;
  },
});

export const list = authedQuery({
  args: {},
  handler: async (ctx, { userId }) => {
    return ctx.db.query('connections')
      .withIndex('by_user_toolkit', q => q.eq('userId', userId))
      .collect();
  },
});

export const connect = authedAction({
  args: { toolkit: v.string(), returnTo: v.string() },
  handler: async (ctx, args): Promise<string> => {
    return ctx.runAction(internal.composio.actions.connect, args);
  },
});

export const disconnect = authedAction({
  args: { toolkit: v.string() },
  handler: async (ctx, args): Promise<null> => {
    return ctx.runAction(internal.composio.actions.disconnect, args);
  },
});

export const catalog = authedAction({
  args: {
    search: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { search, cursor, limit }): Promise<ComposioAppPage> => {
    return ctx.runAction(internal.composio.actions.listCatalog, { search, cursor, limit });
  },
});
