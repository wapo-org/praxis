import {getAuthUserId} from '@convex-dev/auth/server';
import {mutationGeneric, queryGeneric, type MutationBuilder, type QueryBuilder} from 'convex/server';
import {ConvexError, v, type ObjectType, type PropertyValidators} from 'convex/values';
import {bounded, requireServer} from './access.js';
import {activeOwner} from './accountOwner.js';
import type {DataModel, MutationCtx, QueryCtx} from './functions.js';

async function authenticatedOwner(ctx: QueryCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError('Authentication required');
  await requireActiveOwner(ctx, userId);
  return userId;
}

export async function requireActiveOwner(ctx: QueryCtx, userId: string) {
  if (!await activeOwner(ctx, userId)) throw new ConvexError('Account unavailable');
}

type OwnedDefinition<Ctx, Args extends PropertyValidators, Result> = {
  args: Args & {userId?: never; ownerId?: never; serverToken?: never};
  handler: (ctx: Ctx, userId: string, args: ObjectType<Args>) => Result;
};

const buildQuery: QueryBuilder<DataModel, 'public'> = queryGeneric;

export function authedQuery<Args extends PropertyValidators, Result>(
  definition: OwnedDefinition<QueryCtx, Args, Result>,
) {
  return buildQuery({
    args: definition.args,
    handler: async (ctx, args) => definition.handler(ctx, await authenticatedOwner(ctx), args as ObjectType<Args>),
  });
}

const buildMutation: MutationBuilder<DataModel, 'public'> = mutationGeneric;

export function authedMutation<Args extends PropertyValidators, Result>(
  definition: OwnedDefinition<MutationCtx, Args, Result>,
) {
  return buildMutation({
    args: definition.args,
    handler: async (ctx: MutationCtx, args) => definition.handler(ctx, await authenticatedOwner(ctx), args as ObjectType<Args>),
  });
}

const serverScope = {serverToken: v.string(), userId: v.string()};

export function serverMutation<Args extends PropertyValidators, Result>(
  definition: OwnedDefinition<MutationCtx, Args, Result>,
) {
  return buildMutation({
    args: {...definition.args, ...serverScope},
    handler: async (ctx: MutationCtx, args) => {
      const {serverToken, userId, ...input} = args;
      await requireServer(serverToken);
      await requireActiveOwner(ctx, bounded(userId));
      return definition.handler(ctx, userId, input as ObjectType<Args>);
    },
  });
}
