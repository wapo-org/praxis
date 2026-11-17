import type {QueryCtx} from './functions.js';

export async function activeOwner(ctx: QueryCtx, userId: string): Promise<boolean> {
  const user = await ctx.db.query('authDocuments')
    .withIndex('model_id', q => q.eq('model', 'user').eq('id', userId)).unique();
  return !!user && !user.data.deleting;
}
