import type {MutationCtx, QueryCtx} from './functions.js';

function legacyUser(ctx: QueryCtx, userId: string) {
  return ctx.db.query('authDocuments')
    .withIndex('model_id', q => q.eq('model', 'user').eq('id', userId)).unique();
}

// Auth v2 owners are `users` ids; anything else is a legacy auth document id.
export async function activeOwner(ctx: QueryCtx, userId: string): Promise<boolean> {
  const id = ctx.db.normalizeId('users', userId);
  if (id) {
    const user = await ctx.db.get(id);
    return !!user && !user.deleting;
  }
  const user = await legacyUser(ctx, userId);
  return !!user && !user.data.deleting;
}

export async function beginOwnerDeletion(ctx: MutationCtx, userId: string): Promise<void> {
  const id = ctx.db.normalizeId('users', userId);
  if (id) {
    if (await ctx.db.get(id)) await ctx.db.patch(id, {deleting: true});
    return;
  }
  const user = await legacyUser(ctx, userId);
  if (user) await ctx.db.patch(user._id, {data: {...user.data, deleting: true}});
}

export async function deleteOwnerUser(ctx: MutationCtx, userId: string): Promise<void> {
  const id = ctx.db.normalizeId('users', userId);
  if (id && await ctx.db.get(id)) await ctx.db.delete(id);
}
