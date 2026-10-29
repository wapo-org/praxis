import { beforeEach, describe, expect, it } from 'vitest';
import { convexTest } from 'convex-test';
import { makeFunctionReference } from 'convex/server';
import schema from '../../../../convex/schema.js';
import { createMemoryAdapters } from './memory.js';
import { createConvexStore, storeFromRPC } from './convex.js';
import type { Store } from '../contracts.js';
const token='test-server-token-with-more-than-32-characters';
const modules={'../../../../convex/_generated/api.js':async()=>({}), '../../../../convex/store.ts':()=>import('../../../../convex/store.js')};
function localConvex(){
 process.env.PRAXIS_CONVEX_SERVER_TOKEN=token;
 const t=convexTest(schema,modules);
 const rpc={query:(name:string,args:Record<string,unknown>)=>t.query(makeFunctionReference<'query'>(name),{...args,serverToken:token}),mutation:(name:string,args:Record<string,unknown>)=>t.mutation(makeFunctionReference<'mutation'>(name),{...args,serverToken:token})};
 return {t,rpc,store:storeFromRPC(rpc)};
}
function contract(name:string,factory:()=>Store){describe(name,()=>{
 let store:Store;beforeEach(()=>{store=factory();});
 it('isolates identical kind/id addresses by owner',async()=>{await store.put('alice','chat','same',{text:'a'});await store.put('bob','chat','same',{text:'b'});expect((await store.get('alice','chat','same'))?.value).toEqual({text:'a'});expect(await store.get('mallory','chat','same')).toBeNull();expect(await store.list('bob','chat')).toHaveLength(1);});
 it('preserves every immutable revision even for repeated writes in the same millisecond',async()=>{await store.put('alice','chat','x',{n:1});await store.put('bob','chat','hidden',{});await store.put('alice','chat','x',{n:2});await store.delete('alice','chat','x');const a=await store.changes('alice',0,2);expect(a.records.map(r=>r.value)).toEqual([{n:1},{n:2}]);expect(a.hasMore).toBe(true);const b=await store.changes('alice',a.cursor,2);expect(b.records).toHaveLength(1);expect(b.records[0]?.deleted).toBe(true);expect(b.cursor).toBeGreaterThan(a.cursor);expect(b.hasMore).toBe(false);expect((await store.changes('alice',b.cursor,2)).records).toEqual([]);expect(await store.list('alice','chat')).toEqual([]);});
 it('returns owned data without leaking mutable references',async()=>{const value={nested:{n:1}};const row=await store.put('alice','chat','x',value);value.nested.n=2;row.value.nested={n:3};expect((await store.get('alice','chat','x'))?.value).toEqual({nested:{n:1}});});
 it('creates durable tombstones for deletes and can resurrect a row',async()=>{await store.delete('alice','chat','absent');expect((await store.get('alice','chat','absent'))?.deleted).toBe(true);await store.put('alice','chat','absent',{hello:true});expect((await store.list('alice','chat'))[0]?.deleted).toBe(false);});
});}
contract('Store memory contract',()=>createMemoryAdapters().store);
contract('Store Convex executable contract (convex-test database)',()=>localConvex().store);
describe('Convex server boundary',()=>{
 it('rejects missing/wrong server credentials before touching rows',async()=>{const {t}=localConvex();await expect(t.query(makeFunctionReference<'query'>('store:get'),{userId:'a',kind:'chat',id:'x',serverToken:'wrong'})).rejects.toThrow('Server authentication');});
 it('validates pagination and JSON at the API adapter boundary',async()=>{const {store}=localConvex();await expect(store.changes('a',-1,5)).rejects.toThrow();await expect(store.put('a','chat','x',{invalid:undefined} as any)).rejects.toThrow();});
});
const live=!!(process.env.PRAXIS_TEST_CONVEX_URL&&process.env.PRAXIS_TEST_CONVEX_SERVER_TOKEN);
describe.skipIf(!live)('Real Convex env-gated isolation',()=>{it('persists and queries a unique owned record',async()=>{const s=createConvexStore({url:process.env.PRAXIS_TEST_CONVEX_URL!,serverToken:process.env.PRAXIS_TEST_CONVEX_SERVER_TOKEN!});const u=`contract-${crypto.randomUUID()}`;await s.put(u,'test','x',{n:1});expect((await s.get(u,'test','x'))?.value).toEqual({n:1});await s.delete(u,'test','x');});});
