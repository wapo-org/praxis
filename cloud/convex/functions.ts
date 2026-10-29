import {queryGeneric,mutationGeneric,type QueryBuilder,type MutationBuilder,type DataModelFromSchemaDefinition,type GenericMutationCtx} from 'convex/server';
import type schema from './schema.js';
export type DataModel=DataModelFromSchemaDefinition<typeof schema>;
export type MutationCtx=GenericMutationCtx<DataModel>;
export const query:QueryBuilder<DataModel,'public'>=queryGeneric;
export const mutation:MutationBuilder<DataModel,'public'>=mutationGeneric;
