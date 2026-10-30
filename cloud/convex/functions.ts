import {
  actionGeneric,
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

/** Public functions. Every handler MUST call `requireServer` first. */
export const query: QueryBuilder<DataModel, 'public'> = queryGeneric;
export const mutation: MutationBuilder<DataModel, 'public'> = mutationGeneric;
export const action: ActionBuilder<DataModel, 'public'> = actionGeneric;

/** Internal functions are not reachable from outside the deployment. */
export const internalQuery: QueryBuilder<DataModel, 'internal'> = internalQueryGeneric;
export const internalMutation: MutationBuilder<DataModel, 'internal'> = internalMutationGeneric;
