import { v, ConvexError } from 'convex/values';
import { requireServer } from './access.js';
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

/** Public Convex functions; every handler MUST call requireServer first. */
export const query: QueryBuilder<DataModel, 'public'> = queryGeneric;
export const mutation: MutationBuilder<DataModel, 'public'> = ((definition: any) => {
  if (!definition.args?.userId) return mutationGeneric(definition);
  const original=definition.handler;
  return mutationGeneric({...definition,args:{...definition.args,requireOwner:v.optional(v.boolean())},handler:async(ctx:any,a:any)=>{
    await requireServer(a.serverToken);
    if (a.requireOwner && !await activeOwner(ctx, a.userId)) {
      throw new ConvexError('Account unavailable');
    }
    return original(ctx,a);
  }});
}) as MutationBuilder<DataModel, 'public'>;
export const action: ActionBuilder<DataModel, 'public'> = actionGeneric;

export const internalQuery: QueryBuilder<DataModel, 'internal'> = internalQueryGeneric;
export const internalMutation: MutationBuilder<DataModel, 'internal'> = internalMutationGeneric;

export const httpAction = httpActionGeneric;
