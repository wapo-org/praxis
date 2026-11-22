import {internal} from '../_generated/api.js';
import {internalMutation, internalQuery} from '../functions.js';
import {v} from 'convex/values';
import {CONTEXT_EMBEDDING_DIMENSIONS, CONTEXT_EMBEDDING_MODEL, CONTEXT_REEMBED_BATCH_MAX} from './constants.js';

export const staleCount = internalQuery({
  args: {userId: v.string()},
  handler: async (ctx, {userId}) => {
    const rows = await ctx.db.query('contextItems').withIndex('owner_status', q => q.eq('userId', userId)).collect();
    return rows.filter(row => row.enabled && (row.model !== CONTEXT_EMBEDDING_MODEL || row.dimensions !== CONTEXT_EMBEDDING_DIMENSIONS)).length;
  },
});

export const scheduleReembed = internalMutation({
  args: {userId: v.string(), cursor: v.union(v.string(), v.null())},
  handler: async (ctx, {userId, cursor}) => {
    const page = await ctx.db.query('contextItems').withIndex('owner_status', q => q.eq('userId', userId))
      .paginate({cursor, numItems: CONTEXT_REEMBED_BATCH_MAX});
    let scheduled = 0;
    for (const row of page.page) {
      if (!row.enabled || row.model === CONTEXT_EMBEDDING_MODEL && row.dimensions === CONTEXT_EMBEDDING_DIMENSIONS) continue;
      await ctx.db.patch(row._id, {status: 'pending', attempts: 0});
      scheduled++;
    }
    if (scheduled > 0) await ctx.scheduler.runAfter(0, internal.context.embed.embedPending, {userId});
    return {cursor: page.isDone ? null : page.continueCursor, done: page.isDone, scheduled};
  },
});
