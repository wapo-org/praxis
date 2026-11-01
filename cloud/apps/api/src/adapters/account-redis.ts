import {createHash} from 'node:crypto';
import type {Redis} from '@upstash/redis';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** All account writes register their physical Redis key atomically, while the account is active. */
export const OWNER_WRITE_LUA=`
if redis.call('GET',KEYS[1]) ~= 'active' then return redis.error_reply('Account unavailable') end
redis.call('SADD',KEYS[2],KEYS[3])
if ARGV[2] == '' then return redis.call('SET',KEYS[3],ARGV[1]) end
return redis.call('SET',KEYS[3],ARGV[1],'EX',ARGV[2])`;
export function accountRedis(redis: Pick<Redis,'set'|'get'|'del'|'smembers'|'eval'>,prefix='praxis:v1'){
 const active=(u:string)=>`${prefix}:owner:${hash(u)}:active`,index=(u:string)=>`${prefix}:owner:${hash(u)}:keys`;
 return {
  activate:async(u:string)=>{await redis.set(active(u),'active',{nx:true});},
  isActive:async(u:string)=>await redis.get(active(u))==='active',
  freeze:async(u:string)=>{await redis.del(active(u));},
  write:async(u:string,key:string,value:string,ttl?:number)=>{await redis.eval(OWNER_WRITE_LUA,[active(u),index(u),key],[value,ttl===undefined?'':String(ttl)]);},
  async purge(u:string){await redis.del(active(u));for(;;){const keys=await redis.smembers<string[]>(index(u));if(!keys.length)break;await redis.del(...keys);await redis.del(index(u));}await redis.del(index(u));},
  keys:(u:string)=>({active:active(u),index:index(u)}),
 };
}
export const OWNER_LIMIT_LUA=`
if redis.call('GET',KEYS[1]) ~= 'active' then return -1 end
redis.call('SADD',KEYS[2],KEYS[3])
local n=redis.call('INCR',KEYS[3]);redis.call('EXPIRE',KEYS[3],ARGV[1]);return n`;
