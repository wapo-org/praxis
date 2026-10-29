import { query, mutation, type MutationCtx } from './functions.js';
import { v, ConvexError } from 'convex/values';
import { requireServer, bounded } from './access.js';
const scope={serverToken:v.string(),userId:v.string()};
const address={...scope,kind:v.string(),id:v.string()};
const publicRow=(r:any)=>r?({userId:r.userId,kind:r.kind,id:r.id,value:r.value,revision:r.revision,updatedAt:r.updatedAt,deleted:r.deleted}):null;
export const get=query({args:address,handler:async(ctx,a)=>{await requireServer(a.serverToken);bounded(a.userId);return publicRow(await ctx.db.query('records').withIndex('owner_kind_id',q=>q.eq('userId',a.userId).eq('kind',a.kind).eq('id',a.id)).unique());}});
export const list=query({args:{...scope,kind:v.string()},handler:async(ctx,a)=>{await requireServer(a.serverToken);bounded(a.userId);return (await ctx.db.query('records').withIndex('owner_kind_id',q=>q.eq('userId',a.userId).eq('kind',a.kind)).collect()).filter(r=>!r.deleted).map(publicRow);}});
export const changes=query({args:{...scope,after:v.number(),limit:v.number()},handler:async(ctx,a)=>{
 await requireServer(a.serverToken);bounded(a.userId);if(!Number.isSafeInteger(a.after)||a.after<0||!Number.isInteger(a.limit)||a.limit<1||a.limit>1000)throw new ConvexError('Invalid pagination');
 const all=await ctx.db.query('changes').withIndex('owner_revision',q=>q.eq('userId',a.userId).gt('revision',a.after)).take(a.limit+1);
 const records=all.slice(0,a.limit).map(publicRow);return {records,cursor:records.at(-1)?.revision??a.after,hasMore:all.length>a.limit};
}});
async function write(ctx:MutationCtx,a:{userId:string;kind:string;id:string;value:any;deleted:boolean}){
 [a.userId,a.kind,a.id].forEach(bounded);
 if(a.value===null||typeof a.value!=='object'||Array.isArray(a.value))throw new ConvexError('Expected JSON object');
 // Roundtrip rejects Convex-only values and NaN at this server boundary.
 const json=JSON.stringify(a.value);if(json.length>900000)throw new ConvexError('Record too large');
 const seq=await ctx.db.query('sequences').withIndex('owner',q=>q.eq('userId',a.userId)).unique();const revision=(seq?.value??0)+1;
 if(!Number.isSafeInteger(revision))throw new ConvexError('Revision exhausted');
 if(seq)await ctx.db.patch(seq._id,{value:revision});else await ctx.db.insert('sequences',{userId:a.userId,value:revision});
 const row={userId:a.userId,kind:a.kind,id:a.id,value:JSON.parse(json),revision,updatedAt:new Date().toISOString(),deleted:a.deleted};
 const old=await ctx.db.query('records').withIndex('owner_kind_id',q=>q.eq('userId',a.userId).eq('kind',a.kind).eq('id',a.id)).unique();
 if(old)await ctx.db.replace(old._id,row);else await ctx.db.insert('records',row);
 await ctx.db.insert('changes',row);return row;
}
export const put=mutation({args:{...address,value:v.any()},handler:async(ctx,a)=>{await requireServer(a.serverToken);return write(ctx,{...a,deleted:false});}});
export const remove=mutation({args:address,handler:async(ctx,a)=>{await requireServer(a.serverToken);await write(ctx,{...a,value:{},deleted:true});return null;}});
export const putFenced=mutation({args:{...address,value:v.any(),scope:v.string(),holder:v.string(),fence:v.number(),expectedRevision:v.optional(v.number())},handler:async(ctx,a)=>{
 await requireServer(a.serverToken);
 const lease=await ctx.db.query('leases').withIndex('owner_scope',q=>q.eq('userId',a.userId).eq('scope',a.scope)).unique();
 if(!lease||lease.holder!==a.holder||lease.fence!==a.fence||lease.expiresAt<=Date.now())throw new ConvexError('Stale worker fence');
 if(a.expectedRevision!==undefined){const old=await ctx.db.query('records').withIndex('owner_kind_id',q=>q.eq('userId',a.userId).eq('kind',a.kind).eq('id',a.id)).unique();if((old?.revision??0)!==a.expectedRevision)throw new ConvexError('Checkpoint version conflict');}
 return write(ctx,{...a,deleted:false});
}});
