import { v } from 'convex/values';
import { activeOwner } from '../accountOwner.js';
import { internalMutation } from '../functions.js';
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
