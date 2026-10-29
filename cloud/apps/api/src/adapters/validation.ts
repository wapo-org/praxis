import { z } from 'zod';
import { JsonObjectSchema } from '@praxis/protocol';
export const Scope = z.string().min(1).max(500);
export const Revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Limit = z.number().int().min(1).max(1000);
export const RecordSchema = z.object({userId:Scope,kind:Scope,id:Scope,value:JsonObjectSchema,revision:Revision,updatedAt:z.iso.datetime(),deleted:z.boolean()});
export const ChangePageSchema = z.object({records:z.array(RecordSchema),cursor:Revision,hasMore:z.boolean()});
export const EventSchema = z.object({id:Revision.positive(),payload:JsonObjectSchema});
export const tupleKey = (...parts:string[]) => JSON.stringify(parts.map(p=>Scope.parse(p)));
