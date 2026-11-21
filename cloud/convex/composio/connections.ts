import { type ComposioAppPage } from '@praxis/protocol';
import { v } from 'convex/values';
import { activeOwner } from '../accountOwner.js';
import { internal } from '../_generated/api.js';
import { authedAction, authedQuery, internalMutation } from '../functions.js';
import { webhookStatus } from './schema.js';
import { takeBounded } from '../boundedRead.js';
import { CONNECTIONS_PER_USER_MAX } from '../listConstants.js';

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
    return takeBounded(ctx.db.query('connections').withIndex('by_user_toolkit', q => q.eq('userId', userId)),
      CONNECTIONS_PER_USER_MAX, 'connection');
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
