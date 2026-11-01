import { v } from 'convex/values';
import { mutation, query } from './functions.js';
import { requireServer } from './access.js';
export const active=query({args:{serverToken:v.string(),userId:v.string()},handler:async(ctx,a)=>{
 await requireServer(a.serverToken);const user=await ctx.db.query('authDocuments').withIndex('model_id',q=>q.eq('model','user').eq('id',a.userId)).unique();return !!user&&!user.data.deleting;
}});
export const begin=mutation({args:{serverToken:v.string(),userId:v.string()},handler:async(ctx,a)=>{
 await requireServer(a.serverToken);const user=await ctx.db.query('authDocuments').withIndex('model_id',q=>q.eq('model','user').eq('id',a.userId)).unique();
 if(user)await ctx.db.patch(user._id,{data:{...user.data,deleting:true}});return null;
}});
/** Each mutation is bounded and retries safely. Blobs and file tickets disappear in the same transaction. */
export const purge=mutation({args:{serverToken:v.string(),userId:v.string(),keepSessionId:v.optional(v.string())},handler:async(ctx,a)=>{
 await requireServer(a.serverToken);
 const tables=['records','changes','sequences','toolState','toolSkillFiles','files'] as const;
 const indexes={records:'owner_kind_id',changes:'owner_revision',sequences:'owner',toolState:'owner_kind_id',toolSkillFiles:'owner_skill',files:'owner_status'} as const;
 for(const table of tables){
  const rows=await (ctx.db.query(table) as any).withIndex(indexes[table],(q:any)=>q.eq('userId',a.userId)).take(100);
  if(rows.length){for(const row of rows){if(table==='files'&&row.storageId)await ctx.storage.delete(row.storageId);await ctx.db.delete(row._id);}return {done:false};}
 }
 const user=await ctx.db.query('authDocuments').withIndex('model_id',q=>q.eq('model','user').eq('id',a.userId)).unique();
 // Retain the user row until the last batch so its email remains available for verification cleanup.
 const email=user?.data.email;
 const owned=new Map();
 for(const model of ['session','account','verification','rateLimit']){
  const rows=await ctx.db.query('authDocuments').withIndex('model_user',q=>q.eq('model',model).eq('data.userId',a.userId)).take(101);
  for(const row of rows)if(!(row.model==='session'&&row.id===a.keepSessionId)&&!(row.model==='account'&&row.data.providerId==='credential'))owned.set(row._id,row);
 }
 for(const value of [a.userId,...(typeof email==='string'?[email,`email-verification:${email}`]:[])]){
  for(const model of ['verification','rateLimit'])for(const index of ['model_identifier','model_value'] as const){
   const rows=await (ctx.db.query('authDocuments') as any).withIndex(index,(q:any)=>q.eq('model',model).eq(index==='model_value'?'data.value':'data.identifier',value)).take(100);
   for(const row of rows)owned.set(row._id,row);
  }
 }
 if(owned.size){for(const row of [...owned.values()].slice(0,100))await ctx.db.delete(row._id);return {done:false};}
 const retained=await ctx.db.query('authDocuments').withIndex('model_user',q=>q.eq('model','session').eq('data.userId',a.userId)).take(100);
 for(const row of retained)await ctx.db.delete(row._id);
 const credentials=await ctx.db.query('authDocuments').withIndex('model_user',q=>q.eq('model','account').eq('data.userId',a.userId)).collect();for(const row of credentials)await ctx.db.delete(row._id);
 if(user)await ctx.db.delete(user._id);
 return {done:true};
}});
