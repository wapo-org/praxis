import { getAuthUserId } from '@convex-dev/auth/server';
import { v, ConvexError } from 'convex/values';
import { internal } from './_generated/api.js';
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
  type GenericActionCtx,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type MutationBuilder,
  type QueryBuilder,
} from 'convex/server';
import type schema from './schema.js';

export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type ActionCtx = GenericActionCtx<DataModel>;

type WrappedDefinition = {
  args?: unknown;
  returns?: unknown;
  handler: (ctx: unknown, args: Record<string, unknown>) => unknown;
};

type OwnerArgs = Record<string, unknown> & {userId: string};
type ServerArgs = OwnerArgs & {serverToken: string; requireOwner?: boolean};

function definitionOf(value: unknown): WrappedDefinition {
  if (typeof value === 'function') {
    return {handler: value as WrappedDefinition['handler']};
  }
  if (!value || typeof value !== 'object' || !('handler' in value) || typeof value.handler !== 'function') {
    throw new TypeError('A Convex function definition must provide a handler');
  }
  return value as WrappedDefinition;
}

function withDefinition(definition: WrappedDefinition, handler: WrappedDefinition['handler']) {
  return {...definition, handler};
}

async function authenticatedUserId(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<string> {
  const userId = await getAuthUserId(ctx as unknown as QueryCtx);
  if (!userId) throw new ConvexError('Authentication required');
  return userId;
}

async function assertActiveOwner(ctx: QueryCtx | MutationCtx | ActionCtx, userId: string): Promise<void> {
  const active = 'db' in ctx
    ? await activeOwner(ctx, userId)
    : await ctx.runQuery(internal.functions.ownerActive, {userId});
  if (!active) throw new ConvexError('Account unavailable');
}

function authDefinition(definition: unknown, checkOwner: boolean) {
  const original = definitionOf(definition);
  return withDefinition(original, async (ctx, args) => {
    const userId = await authenticatedUserId(ctx as QueryCtx | MutationCtx | ActionCtx);
    if (checkOwner) await assertActiveOwner(ctx as QueryCtx | MutationCtx | ActionCtx, userId);
    return original.handler(ctx, {...args, userId});
  });
}

function serverDefinition(definition: unknown, checkOwner: boolean) {
  const original = definitionOf(definition);
  return withDefinition(
    {...original, args: {...(original.args as Record<string, unknown> | undefined), requireOwner: v.optional(v.boolean())}},
    async (ctx, args) => {
      const serverArgs = args as ServerArgs;
      await requireServer(serverArgs.serverToken);
      bounded(serverArgs.userId);
      if (checkOwner && serverArgs.requireOwner) await assertActiveOwner(ctx as QueryCtx | MutationCtx | ActionCtx, serverArgs.userId);
      return original.handler(ctx, args);
    },
  );
}

export const query: QueryBuilder<DataModel, 'public'> = queryGeneric;
export const mutation: MutationBuilder<DataModel, 'public'> = mutationGeneric;
export const action: ActionBuilder<DataModel, 'public'> = actionGeneric;

export const authedMutation = ((definition: unknown) => mutationGeneric(authDefinition(definition, true) as never)) as unknown as MutationBuilder<DataModel, 'public'>;
export const authedAction = ((definition: unknown) => actionGeneric(authDefinition(definition, true) as never)) as unknown as ActionBuilder<DataModel, 'public'>;

export const serverQuery = ((definition: unknown) => queryGeneric(serverDefinition(definition, false) as never)) as unknown as QueryBuilder<DataModel, 'public'>;
export const serverMutation = ((definition: unknown) => mutationGeneric(serverDefinition(definition, true) as never)) as unknown as MutationBuilder<DataModel, 'public'>;
export const serverAction = ((definition: unknown) => actionGeneric(serverDefinition(definition, false) as never)) as unknown as ActionBuilder<DataModel, 'public'>;

export const ownerActive = internalQueryGeneric({
  args: {userId: v.string()},
  handler: async (ctx, {userId}) => activeOwner(ctx, userId),
});

export const internalQuery: QueryBuilder<DataModel, 'internal'> = internalQueryGeneric;
export const internalMutation: MutationBuilder<DataModel, 'internal'> = internalMutationGeneric;

export const httpAction = httpActionGeneric;
