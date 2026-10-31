import {v, ConvexError} from 'convex/values';
import {query, mutation, type QueryCtx} from './functions.js';
import {bounded, requireServer} from './access.js';
const address={serverToken:v.string(),userId:v.string(),kind:v.string(),id:v.string()};
function row(ctx:QueryCtx,a:{userId:string;kind:string;id:string}) {
 [a.userId,a.kind,a.id].forEach(bounded);
 if(!['skill','javascriptKV'].includes(a.kind))throw new ConvexError('Invalid tools state kind');
 return ctx.db.query('toolState').withIndex('owner_kind_id',q=>q.eq('userId',a.userId).eq('kind',a.kind).eq('id',a.id)).unique();
}
function files(ctx:QueryCtx,a:{userId:string;id:string}) {
 return ctx.db.query('toolSkillFiles').withIndex('owner_skill',q=>q.eq('userId',a.userId).eq('skillId',a.id)).collect();
}
export const get=query({args:address,handler:async(ctx,a)=>{
 await requireServer(a.serverToken);const existing=await row(ctx,a);if(!existing)return null;
 if(a.kind!=='skill'||!existing.value.hasFiles)return existing.value;
 const {hasFiles:_,...value}=existing.value;return {...value,files:Object.fromEntries((await files(ctx,a)).map(f=>[f.path,f.content]))};
}});
export const put=mutation({args:{...address,value:v.any()},handler:async(ctx,a)=>{
 await requireServer(a.serverToken);
 if(!a.value||typeof a.value!=='object'||Array.isArray(a.value)||JSON.stringify(a.value).length>6_000_000)throw new ConvexError('Invalid tools state value');
 const existing=await row(ctx,a);
 let value=a.value;
 if(a.kind==='skill'){
  const {files:bundle,...rest}=a.value;
  if(bundle!==undefined&&(!bundle||typeof bundle!=='object'||Array.isArray(bundle)||Object.keys(bundle).length>100))throw new ConvexError('Invalid skill files');
  for(const f of await files(ctx,a))await ctx.db.delete(f._id);
  for(const [path,content]of Object.entries(bundle??{})){
   if(typeof content!=='string'||new TextEncoder().encode(content).length>500_000)throw new ConvexError('Skill file exceeds 500 KB');
   if(!path||path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..'))throw new ConvexError('Invalid skill file path');
   await ctx.db.insert('toolSkillFiles',{userId:a.userId,skillId:a.id,path,content});
  }
  value={...rest,...(bundle===undefined?{}:{hasFiles:true})};
 }
 if(JSON.stringify(value).length>400_000)throw new ConvexError('Tools state metadata exceeds 400 KB');
 if(existing)await ctx.db.patch(existing._id,{value});
 else await ctx.db.insert('toolState',{userId:a.userId,kind:a.kind,id:a.id,value});
 return null;
}});
export const remove=mutation({args:address,handler:async(ctx,a)=>{
 await requireServer(a.serverToken);const existing=await row(ctx,a);if(existing)await ctx.db.delete(existing._id);
 if(a.kind==='skill')for(const f of await files(ctx,a))await ctx.db.delete(f._id);return null;
}});
