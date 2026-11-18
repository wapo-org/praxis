import type {MutationCtx, QueryCtx} from './functions.js';

export async function activeOwner(ctx: QueryCtx, userId: string): Promise<boolean> {
  const id = ctx.db.normalizeId('users', userId);
  if (!id) return false;
  const user = await ctx.db.get(id);
  return !!user && !user.deleting;
}

export async function deleteOwnerUser(ctx: MutationCtx, userId: string): Promise<void> {
  const id = ctx.db.normalizeId('users', userId);
  if (id && await ctx.db.get(id)) await ctx.db.delete(id);
}
