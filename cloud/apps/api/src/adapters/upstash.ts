import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';
import { z } from 'zod';
import { JsonObjectSchema } from '@praxis/protocol';
import type { Events, KV } from '../contracts.js';
import { EventSchema, Limit, Revision, Scope, tupleKey } from './validation.js';
export const APPEND_EVENT_LUA=`
local n = redis.call('INCR', KEYS[1])
if n > 9007199254740991 then return redis.error_reply('event sequence exhausted') end
redis.call('XADD', KEYS[2], tostring(n)..'-0', 'payload', ARGV[1])
return n`;
export interface UpstashOptions {url:string;token:string;prefix?:string}
/** Automatic deserialization is disabled so arbitrary JSON strings survive roundtrips. */
export function createUpstashAdapters(options:UpstashOptions){
 z.string().url().parse(options.url);z.string().min(1).parse(options.token);
 const redis=new Redis({url:options.url,token:options.token,automaticDeserialization:false});
 return upstashFromRedis(redis,options.prefix??'praxis:v1');
}
export function upstashFromRedis(redis:Redis,prefix='praxis:v1'){
 const key=(k:string)=>`${prefix}:kv:${Scope.parse(k)}`;
 const kv:KV={
  get:async<T>(k:string)=>{const value=await redis.get<string>(key(k));return value===null?null:JSON.parse(value) as T;},
  set:async(k,value,ttl)=>{const data=JSON.stringify(value);if(data===undefined)throw new Error('Expected JSON value');if(ttl===undefined)await redis.set(key(k),data);else await redis.set(key(k),data,{ex:z.number().int().positive().parse(ttl)});},
  del:async k=>{await redis.del(key(k));},
 };
 const getdel=async<T>(k:string):Promise<T|null>=>{const data=await redis.getdel<string>(key(k));return data===null?null:JSON.parse(data) as T;};
 const stream=(u:string,c:string)=>`${prefix}:events:${tupleKey(u,c)}`;
 const events:Events={
  append:async(u,c,payload)=>{const k=stream(u,c);const id=z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(await redis.eval(APPEND_EVENT_LUA,[`${k}:seq`,k],[JSON.stringify(JsonObjectSchema.parse(payload))]));return {id,payload:structuredClone(payload)};},
  read:async(u,c,after,limit=100)=>{
   Revision.parse(after);Limit.parse(limit);if(after===Number.MAX_SAFE_INTEGER)return [];
   // Exclusive bounds are supported by Redis Streams; XADD's explicit n-0 IDs are portable safe integers.
   const result=await redis.xrange<{payload:string}>(stream(u,c),`(${after}-0`,'+',limit);
   return Object.entries(result??{}).map(([id,fields])=>EventSchema.parse({id:Number(id.split('-')[0]),payload:JSON.parse(fields.payload)}));
  },
 };
 return {redis,kv,events,getdel,consumeOAuthState:getdel};
}
export function createRateLimiter(redis:Redis,options:{requests?:number;window?:`${number} s`;prefix?:string}={}){
 const limiter=new Ratelimit({redis,limiter:Ratelimit.slidingWindow(options.requests??60,options.window??'60 s'),prefix:options.prefix??'praxis:ratelimit',analytics:false,timeout:0});
 return (userId:string,route:string)=>limiter.limit(tupleKey(userId,route));
}
/** Cache keys retain owner boundaries; call after all writes to a bootstrap-visible resource. */
export async function invalidateOwnerCaches(kv:KV,userId:string){Scope.parse(userId);await kv.del(`bootstrap:${userId}`);}
