import { internalMutation } from '../functions.js';
import { PENDING_EXPIRY_BATCH_MAX } from './constants.js';

/** Deletes abandoned Connect Link rows; connected and failed rows are never touched. */
export const expirePending = internalMutation({
  args: {},
  handler: async ctx => {
    const now = Date.now();
    const expired = await ctx.db.query('connections')
      .withIndex('by_status_expires', q => q.eq('status', 'pending').lte('expiresAt', now))
      .take(PENDING_EXPIRY_BATCH_MAX);
    for (const row of expired) await ctx.db.delete(row._id);
    return { deleted: expired.length };
  },
});
