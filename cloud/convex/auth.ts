import { v, ConvexError } from 'convex/values';
import { mutation,query } from './functions.js';
import { requireServer } from './access.js';
import { z } from 'zod';
const Where=z.object({field:z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),operator:z.enum(['eq','ne','lt','lte','gt','gte','in','not_in','contains','starts_with','ends_with']).default('eq'),value:z.union([z.string(),z.number(),z.boolean(),z.array(z.string()),z.array(z.number()),z.null()]),connector:z.enum(['AND','OR']).default('AND'),mode:z.enum(['sensitive','insensitive']).default('sensitive')});
const Input=z.object({model:z.enum(['user','session','account','verification','rateLimit']),where:z.array(Where).max(30).default([]),data:z.record(z.string(),z.json()).optional(),update:z.record(z.string(),z.json()).optional(),select:z.array(z.string()).optional(),limit:z.number().int().min(0).max(10000).default(100),offset:z.number().int().nonnegative().default(0),sortBy:z.object({field:z.string(),direction:z.enum(['asc','desc'])}).optional(),join:z.unknown().optional(),increment:z.record(z.string(),z.number()).optional(),set:z.record(z.string(),z.json()).optional()});
type Input=z.infer<typeof Input>;
function matches(data:Record<string,any>,where:Input['where']){
 const match=(w:Input['where'][number])=>{let a=data[w.field]??null,b:any=w.value;if(w.mode==='insensitive'){if(typeof a==='string')a=a.toLowerCase();if(typeof b==='string')b=b.toLowerCase();if(Array.isArray(b))b=b.map(v=>typeof v==='string'?v.toLowerCase():v);}switch(w.operator){case'eq':return a===b;case'ne':return a!==b;case'lt':return a<b;case'lte':return a<=b;case'gt':return a>b;case'gte':return a>=b;case'in':return Array.isArray(b)&&b.includes(a);case'not_in':return Array.isArray(b)&&!b.includes(a);case'contains':return typeof a==='string'&&a.includes(String(b));case'starts_with':return typeof a==='string'&&a.startsWith(String(b));case'ends_with':return typeof a==='string'&&a.endsWith(String(b));}};
 // Better Auth uses AND filters plus optional OR alternatives, with AND taking precedence.
 const and=where.filter(w=>w.connector!=='OR'),or=where.filter(w=>w.connector==='OR');return (and.length>0&&and.every(match))||or.some(match)||where.length===0;
}
async function rows(ctx:any,input:Input){
 if(input.join&&Object.keys(input.join as object).length)throw new ConvexError('Auth joins are disabled');
 const eq=input.where.find(w=>w.operator==='eq'&&w.mode!=='insensitive'&&w.connector==='AND'&&['id','email','token','userId','identifier'].includes(w.field));
 // OR filters cannot restrict to one side without losing valid rows.
 const indexed=eq&&!input.where.some(w=>w.connector==='OR')?eq:undefined;
 let query=ctx.db.query('authDocuments');
 if(indexed){const index={id:'model_id',email:'model_email',token:'model_token',userId:'model_user',identifier:'model_identifier'}[indexed.field]!;query=query.withIndex(index,(q:any)=>q.eq('model',input.model).eq(indexed.field==='id'?'id':`data.${indexed.field}`,indexed.value));}
 else query=query.withIndex('model',(q:any)=>q.eq('model',input.model));
 const result=(await query.collect()).filter((r:any)=>matches(r.data,input.where));
 if(input.sortBy){const {field,direction}=input.sortBy;result.sort((a:any,b:any)=>{const x=a.data[field],y=b.data[field];return (x===y?0:x<y?-1:1)*(direction==='asc'?1:-1);});}
 return result;
}
function select(data:any,fields?:string[]){return fields?Object.fromEntries(fields.filter(f=>Object.hasOwn(data,f)).map(f=>[f,data[f]])):data;}
const args={serverToken:v.string(),operation:v.string(),input:v.any()};
export const read=query({args,handler:async(ctx,a)=>{
 await requireServer(a.serverToken);const input=Input.parse(a.input),all=await rows(ctx,input);
 if(a.operation==='count')return all.length;
 if(a.operation==='findOne')return all[0]?select(all[0].data,input.select):null;
 if(a.operation==='findMany')return all.slice(input.offset,input.offset+input.limit).map((r:any)=>select(r.data,input.select));
 throw new ConvexError('Unknown auth read');
}});
export const execute=mutation({args,handler:async(ctx,a)=>{
 await requireServer(a.serverToken);const input=Input.parse(a.input);
 if(a.operation==='create'){
  const data=input.data;if(!data||typeof data.id!=='string'||!data.id)throw new ConvexError('Auth ID required');
  const all=await ctx.db.query('authDocuments').withIndex('model',q=>q.eq('model',input.model)).collect();
  if(all.some(r=>r.id===data.id||(input.model==='user'&&r.data.email===data.email)||(input.model==='session'&&r.data.token===data.token)||(input.model==='account'&&r.data.providerId===data.providerId&&r.data.accountId===data.accountId)))throw new ConvexError('Auth unique constraint');
  await ctx.db.insert('authDocuments',{model:input.model,id:data.id,data});return select(data,input.select);
 }
 const all=await rows(ctx,input),many=a.operation==='updateMany'||a.operation==='deleteMany',selected=many?all:all.slice(0,1);
 if(['delete','deleteMany','consumeOne'].includes(a.operation)){for(const r of selected)await ctx.db.delete(r._id);return a.operation==='consumeOne'?(selected[0]?.data??null):a.operation==='deleteMany'?selected.length:null;}
 if(a.operation==='update'||a.operation==='updateMany'||a.operation==='incrementOne'){
  for(const r of selected){const data={...r.data,...input.update,...input.set};if(data.id!==r.id)throw new ConvexError('Immutable auth ID');for(const [field,n]of Object.entries(input.increment??{})){if(typeof data[field]!=='number')throw new ConvexError('Invalid counter');data[field]+=n;}await ctx.db.patch(r._id,{data});r.data=data;}
  return many?selected.length:(selected[0]?.data??null);
 }
 throw new ConvexError('Unknown auth mutation');
}});
