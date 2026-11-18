import { getAuthUserId } from '@convex-dev/auth/server';
import { v, ConvexError, type PropertyValidators, type ObjectType } from 'convex/values';
import { bounded, requireServer } from './access.js';
import { activeOwner } from './accountOwner.js';
import {
  actionGeneric,
  httpActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
  type ActionBuilder,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type MutationBuilder,
  type QueryBuilder,
} from 'convex/server';
import type schema from './schema.js';

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;

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

export function authedQuery<Args extends PropertyValidators, Result>(
  definition: OwnedDefinition<QueryCtx, Args, Result>,
) {
  return query({
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

export const query: QueryBuilder<DataModel, 'public'> = queryGeneric;

type LegacyMutation = {
  args?: Record<string, unknown>;
  handler: (ctx: MutationCtx, args: Record<string, unknown>) => unknown;
};

export const mutation = ((definition: LegacyMutation) => {
  if (!definition.args?.userId) return mutationGeneric(definition as never);
  return buildMutation({
    ...definition,
    args: {...definition.args, serverToken: v.string(), userId: v.string(), requireOwner: v.optional(v.boolean())},
    handler: async (ctx: MutationCtx, args) => {
      await requireServer(args.serverToken);
      if (args.requireOwner) await requireActiveOwner(ctx, args.userId);
      return definition.handler(ctx, args);
    },
  });
}) as unknown as MutationBuilder<DataModel, 'public'>;
export const action: ActionBuilder<DataModel, 'public'> = actionGeneric;

export const internalQuery: QueryBuilder<DataModel, 'internal'> = internalQueryGeneric;
export const internalMutation: MutationBuilder<DataModel, 'internal'> = internalMutationGeneric;

export const httpAction = httpActionGeneric;
