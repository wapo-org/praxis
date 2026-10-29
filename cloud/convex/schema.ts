import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
const row = {userId:v.string(),kind:v.string(),id:v.string(),value:v.any(),revision:v.number(),updatedAt:v.string(),deleted:v.boolean()};
export default defineSchema({
 records:defineTable(row).index('owner_kind_id',['userId','kind','id']),
 changes:defineTable(row).index('owner_revision',['userId','revision']),
 sequences:defineTable({userId:v.string(),value:v.number()}).index('owner',['userId']),
 leases:defineTable({userId:v.string(),scope:v.string(),fence:v.number(),holder:v.string(),expiresAt:v.number()}).index('owner_scope',['userId','scope']),
 authDocuments:defineTable({model:v.string(),id:v.string(),data:v.any()}).index('model',['model']).index('model_id',['model','id']).index('model_email',['model','data.email']).index('model_token',['model','data.token']).index('model_user',['model','data.userId']).index('model_identifier',['model','data.identifier']),
 uploads:defineTable({userId:v.string(),ticket:v.string(),uploadUrl:v.string(),expiresAt:v.number(),storageId:v.optional(v.id('_storage')),claimed:v.boolean()}).index('ticket',['ticket']).index('storage',['storageId']),
});
