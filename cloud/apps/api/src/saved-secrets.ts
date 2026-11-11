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
 const props=schema.properties;
 if(!props||typeof props!=='object'||Array.isArray(props))return next;
 for(const [name,spec] of Object.entries(props)) {
  if(!spec||typeof spec!=='object'||Array.isArray(spec)||(spec.format!=='password'&&spec['x-sensitive']!==true))continue;
  const value=next[name];if(typeof value!=='string')continue;
  if(value.startsWith('{{secret:')) {
   const id=value.slice(9,-2),row=await ctx.store.get(ctx.userId,'savedSecret',id);
   if(!row||row.deleted||row.value.saved!==true)throw new ApiError(409,'secret_missing','Saved secret unavailable. Enter it again.');
  } else next[name]=await saveSecret(ctx,name,value,next['__save_'+name]===true,chatId);
  delete next['__save_'+name];
 }
 return next;
}
