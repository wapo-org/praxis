import { v } from 'convex/values';
import { requireServer } from './access.js';
import { requireActiveOwner } from './ownerFunctions.js';
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

/** Public Convex functions; every handler MUST call requireServer first. */
export const query: QueryBuilder<DataModel, 'public'> = queryGeneric;
const buildMutation: MutationBuilder<DataModel, 'public'> = mutationGeneric;

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
