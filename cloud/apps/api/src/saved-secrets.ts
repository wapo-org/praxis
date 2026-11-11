import {randomUUID} from 'node:crypto';
import type {JsonObject, JsonValue} from '@praxis/protocol';
import type {FeatureContext} from './contracts.js';
import {seal,unseal} from './secrets.js';
import {ApiError} from './service.js';

export async function saveSecret(ctx:FeatureContext,name:string,value:string,saved:boolean,chatId:string) {
 const id=randomUUID(),createdAt=new Date().toISOString();
 await ctx.store.put(ctx.userId,'savedSecretValue',id,{cipher:seal(value,ctx.userId,'saved:'+id,ctx.encryptionKey)});
 await ctx.store.put(ctx.userId,'savedSecret',id,{id,name,createdAt,saved,chatId});
 return '{{secret:'+id+'}}';
}
export async function saveVariable(ctx:FeatureContext,name:string,value:JsonValue) {
 if(Buffer.byteLength(JSON.stringify(value))>64_000)throw new ApiError(413,'value_too_large','Saved values must be smaller than 64 KB.');
 const id=randomUUID();
 await ctx.store.put(ctx.userId,'savedVariable',id,{id,name,value,createdAt:new Date().toISOString()});
 return id;
}
export async function savedValues(ctx:FeatureContext) {
 const secrets=(await secretMetadata(ctx)).map(v=>({id:String(v.id),name:String(v.name),createdAt:String(v.createdAt),...(typeof v.lastUsedAt==='string'?{lastUsedAt:v.lastUsedAt}:{lastUsedAt:null}),kind:'secret' as const}));
 const variables=(await ctx.store.list(ctx.userId,'savedVariable')).filter(r=>!r.deleted).map(r=>({id:r.id,name:String(r.value.name),createdAt:String(r.value.createdAt),value:r.value.value??null,...(typeof r.value.lastUsedAt==='string'?{lastUsedAt:r.value.lastUsedAt}:{lastUsedAt:null}),kind:'variable' as const}));
 return [...secrets,...variables].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
}
export async function secretMetadata(ctx:FeatureContext) {
 return (await ctx.store.list(ctx.userId,'savedSecret')).filter(r=>!r.deleted&&r.value.saved===true).map(r=>r.value);
}
/** Resolve only in the execution boundary; callers MUST redact outputs before persisting or emitting. */
export async function executionSecrets(ctx:FeatureContext,chatId:string) {
 const values=new Map<string,string>();
 for(const r of await ctx.store.list(ctx.userId,'savedSecret')) {
  if(r.deleted||(r.value.saved!==true&&r.value.chatId!==chatId))continue;
  const row=await ctx.store.get(ctx.userId,'savedSecretValue',r.id);
  if(row&&!row.deleted&&ctx.encryptionKey)values.set('{{secret:'+r.id+'}}',unseal(String(row.value.cipher),ctx.userId,'saved:'+r.id,ctx.encryptionKey));
 }
 const walk=(value:JsonValue,replace:(s:string)=>string):JsonValue=>typeof value==='string'?replace(value):Array.isArray(value)?value.map(v=>walk(v,replace)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[replace(k),walk(v,replace)])):value;
 return {
  async touch(v:JsonValue) {
    const text=JSON.stringify(v);
    for(const ref of values.keys())if(text.includes(ref)){
      const id=ref.slice(9,-2),row=await ctx.store.get(ctx.userId,'savedSecret',id);
      if(row&&!row.deleted)await ctx.store.put(ctx.userId,'savedSecret',id,{...row.value,lastUsedAt:new Date().toISOString()});
    }
  },
  resolve:(v:JsonValue)=>walk(v,s=>s.replace(/\{\{secret:[^}]+\}\}/g,ref=>{const real=values.get(ref);if(!real)throw new ApiError(409,'secret_missing','This saved secret was removed. Ask the user for it again.');return real;})),
  redact:(v:JsonValue)=>walk(v,s=>{for(const [ref,real] of values)if(real)s=s.split(real).join(ref);return s;}),
 };
}
/** Before the decision is written, replace sensitive form fields with opaque references. */
export async function protectAnswer(ctx:FeatureContext,chatId:string,schema:JsonObject,content:JsonObject):Promise<JsonObject> {
 const next={...content};
 const rawProps=schema.properties;
 const props=rawProps&&typeof rawProps==='object'&&!Array.isArray(rawProps)?rawProps:{};
 const names=Object.keys(props).length?Object.keys(props):['response'];
 for(const name of names) {
  const spec=props[name];
  const sensitive=!!spec&&typeof spec==='object'&&!Array.isArray(spec)&&(spec.format==='password'||spec['x-sensitive']===true);
  const value=next[name],saved=next['__save_'+name]===true;
  if(value===undefined)continue;
  if(sensitive) {
   if(typeof value==='string'&&value.startsWith('{{secret:')) {
    const id=value.slice(9,-2),row=await ctx.store.get(ctx.userId,'savedSecret',id);
    if(!row||row.deleted||row.value.saved!==true)throw new ApiError(409,'secret_missing','Saved secret unavailable. Enter it again.');
   }else next[name]=await saveSecret(ctx,name,typeof value==='string'?value:JSON.stringify(value),saved,chatId);
  }else if(saved)await saveVariable(ctx,name,value);
 }
 for(const key of Object.keys(next))if(key.startsWith('__save_'))delete next[key];
 return next;
}

/** Keyset pagination survives insertions before the current page; cursor is bound to the filters. */
export async function querySavedValues(ctx:FeatureContext,q:{query?:string;kind?:'secret'|'variable';since?:string;cursor?:string;limit:number}) {
 const scope=JSON.stringify([q.query??'',q.kind??'',q.since??'']);
 let after:{createdAt:string;id:string}|undefined;
 if(q.cursor)try{const c=JSON.parse(Buffer.from(q.cursor,'base64url').toString());if(c.scope!==scope||typeof c.createdAt!=='string'||typeof c.id!=='string')throw 0;after=c;}catch{throw new ApiError(400,'invalid_cursor','Invalid saved-values cursor');}
 const needle=q.query?.toLocaleLowerCase();
 const rows=(await savedValues(ctx)).filter(v=>(!q.kind||v.kind===q.kind)&&(!q.since||Date.parse(v.createdAt)>=Date.parse(q.since))&&(!needle||v.name.toLocaleLowerCase().includes(needle)||(v.kind==='variable'&&JSON.stringify(v.value).toLocaleLowerCase().includes(needle)))&&(!after||v.createdAt<after.createdAt||(v.createdAt===after.createdAt&&v.id>after.id)));
 const items=rows.slice(0,q.limit),last=items.at(-1);
 return {items,nextCursor:rows.length>items.length&&last?Buffer.from(JSON.stringify({scope,createdAt:last.createdAt,id:last.id})).toString('base64url'):null};
}
export async function touchSavedValue(ctx:FeatureContext,id:string,kind:'secret'|'variable') {
 const key=kind==='secret'?'savedSecret':'savedVariable',row=await ctx.store.get(ctx.userId,key,id);
 if(row&&!row.deleted)await ctx.store.put(ctx.userId,key,id,{...row.value,lastUsedAt:new Date().toISOString()});
}
