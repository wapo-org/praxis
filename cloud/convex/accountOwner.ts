import type {QueryCtx} from './functions.js';

export async function activeOwner(ctx: QueryCtx, userId: string): Promise<boolean> {
  const id = ctx.db.normalizeId('users', userId);
  if (!id) return false;
  const user = await ctx.db.get(id);
  return user !== null && !user.deleting;
}
