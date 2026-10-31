import {describe,it,expect} from 'vitest';
import {convexTest} from 'convex-test';
import {makeFunctionReference} from 'convex/server';
import schema from '../../../../../convex/schema.js';
import {createConvexRPC,type ConvexRPC} from '../../adapters/convex.js';
import {toolsStorageFromRPC} from './convex-storage.js';
import {createLocalToolsStorage} from './local-storage.js';
import {toolsStorageContract,type ClientUpload} from './storage-contract.js';
const token='test-tools-server-credential-with-32-characters';
function harness(){
 process.env.PRAXIS_CONVEX_SERVER_TOKEN=token;
 const t=convexTest(schema,{
  '../../../../../convex/_generated/api.js':async()=>({}),
  '../../../../../convex/tools.ts':()=>import('../../../../../convex/tools.js'),
  '../../../../../convex/files.ts':()=>import('../../../../../convex/files.js'),
  '../../../../../convex/uploads.ts':()=>import('../../../../../convex/uploads.js'),
  '../../../../../convex/http.ts':()=>import('../../../../../convex/http.js'),
 });
 const rpc:ConvexRPC={query:(n,a)=>t.query(makeFunctionReference<'query'>(n),{...a,serverToken:token}),mutation:(n,a)=>t.mutation(makeFunctionReference<'mutation'>(n),{...a,serverToken:token}),action:(n,a)=>t.action(makeFunctionReference<'action'>(n),{...a,serverToken:token})};
 // Storage URLs from convex-test are fake; serve their bytes from the test deployment instead of the network.
 const fetcher=(async(input:RequestInfo|URL)=>{
  const sha=String(input).split('/api/storage/')[1]!;
  const bytes=await t.run(async ctx=>{const doc=(await ctx.db.system.query('_storage').collect()).find(d=>d.sha256===sha);const blob=doc?await ctx.storage.get(doc._id):null;return blob?await blob.arrayBuffer():null;});
  return bytes?new Response(bytes):new Response(null,{status:404});
 }) as typeof fetch;
 return {t,rpc,storage:toolsStorageFromRPC(rpc,'https://api.example.com',fetcher)};
}
const localUpload:ClientUpload=async(s,user,url,bytes,type)=>s.acceptUpload!(user,new URL(url.uploadUrl).pathname.split('/').at(-1)!,bytes,type);
toolsStorageContract('tools storage: local',()=>createLocalToolsStorage('http://localhost'),localUpload);
let current:ReturnType<typeof harness>;
/** The client's direct POST to the Convex upload URL, simulated by storing the blob in the test deployment. */
const convexUpload:ClientUpload=async(_s,_user,url,bytes,type)=>{
 expect(url.method).toBe('POST');expect(url.uploadUrl).toContain('convex.site');
 const response=await current.t.fetch(new URL(url.uploadUrl).pathname,{method:'POST',headers:{'content-type':type},body:Uint8Array.from(bytes)});
 expect(response.status).toBe(200);return (await response.json()).storageId;
};
toolsStorageContract('tools storage: Convex database (direct upload URL)',()=>(current=harness()).storage,convexUpload);
describe('Convex direct uploads',()=>{
 it('handles 25 MB without passing bytes through a function argument',async()=>{
  const {t,storage}=current=harness(),user='big',size=25_000_000,input={name:'big.bin',mediaType:'application/octet-stream',size};
  const url=await storage.createUpload(user,input);expect(url.method).toBe('POST');
  const id=await convexUpload(storage,user,url,new Uint8Array(size),input.mediaType);
  await storage.verify(user,id,input);expect((await storage.read(user,id)).bytes.byteLength).toBe(size);
 });
 it('binds unclaimed uploads to their original owner and never deletes another upload on mismatch',async()=>{
  const {t,storage}=current=harness(),input={name:'a.txt',mediaType:'text/plain',size:3};
  const stray=await t.run(ctx=>ctx.storage.store(new Blob(['zzz'],{type:'text/plain'})));
  await expect(storage.verify('alice',stray,input)).rejects.toThrow();
  expect(await t.run(async ctx=>(await ctx.storage.get(stray))!==null)).toBe(true);
  const url=await storage.createUpload('alice',input);await storage.createUpload('mallory',input);
  const id=await convexUpload(storage,'alice',url,new TextEncoder().encode('abc'),'text/plain');
  // The original REV-A2 attack claimed or deleted this blob before Alice completed it.
  await expect(storage.verify('mallory',id,input)).rejects.toThrow();
  await expect(storage.verify('mallory',id,{...input,size:4})).rejects.toThrow();
  await expect(storage.delete('mallory',id)).rejects.toThrow();
  await storage.verify('alice',id,input);await storage.verify('alice',id,input);
  expect(new TextDecoder().decode((await storage.read('alice',id)).bytes)).toBe('abc');
  expect((await t.fetch(new URL(url.uploadUrl).pathname,{method:'POST',headers:{'content-type':'text/plain'},body:'abc'})).status).toBe(404);
 });
 it('rejects absent/mismatched MIME, size, expired capabilities and concurrent upload replay',async()=>{
  const {t,storage}=current=harness(),input={name:'a.png',mediaType:'image/png',size:3};
  const path=async()=>new URL((await storage.createUpload('alice',input)).uploadUrl).pathname;
  const url=await path();expect((await t.fetch(url,{method:'POST',body:new Uint8Array(3)})).status).toBe(400);
  expect((await t.fetch(url,{method:'POST',headers:{'content-type':'text/plain'},body:'abc'})).status).toBe(404);
  const expired=await path();await t.run(async ctx=>{const row=await ctx.db.query('files').withIndex('ticket',q=>q.eq('ticket',expired.split('/').at(-1)!)).unique();await ctx.db.patch(row!._id,{expiresAt:0});});
  expect((await t.fetch(expired,{method:'POST',headers:{'content-type':'image/png'},body:'abc'})).status).toBe(404);
  const wrongSize=await path();expect((await t.fetch(wrongSize,{method:'POST',headers:{'content-type':'image/png'},body:'long'})).status).toBe(400);
  const raced=await path();const results=await Promise.all([1,2].map(()=>t.mutation(makeFunctionReference<'mutation'>('uploads:begin'),{ticket:raced.split('/').at(-1)!,mediaType:'image/png'})));
  expect(results.filter(Boolean)).toHaveLength(1);
 });
 it('rejects a headerless unclaimed blob instead of accepting its declared MIME type',async()=>{
  const {t,storage}=current=harness(),input={name:'a.png',mediaType:'image/png',size:3};
  await storage.createUpload('alice',input);
  const id=await t.run(ctx=>ctx.storage.store(new Blob(['abc'])));
  await expect(storage.verify('alice',id,input)).rejects.toThrow();
 });
 it('rejects headerless storage metadata even for an owner-bound upload',async()=>{
  const {t,rpc,storage}=current=harness(),input={name:'a.png',mediaType:'image/png',size:3};
  const url=await storage.createUpload('alice',input),id=await t.run(ctx=>ctx.storage.store(new Blob(['abc'])));
  await t.run(async ctx=>{const row=await ctx.db.query('files').withIndex('ticket',q=>q.eq('ticket',new URL(url.uploadUrl).pathname.split('/').at(-1)!)).unique();await ctx.db.patch(row!._id,{status:'uploaded',storageId:id});});
  expect(await rpc.mutation('files:claim',{userId:'alice',storageId:id,...input})).toEqual({ok:false});
 });
 it('sweeps only expired bound uploads and leaves in-flight claims and unrelated blobs intact',async()=>{
  const {t,rpc,storage}=current=harness(),input={name:'x.txt',mediaType:'text/plain',size:3};
  const url=await storage.createUpload('alice',input),id=await convexUpload(storage,'alice',url,new TextEncoder().encode('abc'),'text/plain');
  const preflight=await t.fetch(new URL(url.uploadUrl).pathname,{method:'OPTIONS'});expect(preflight.status).toBe(204);expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type');
  expect(await rpc.mutation('files:sweep',{})).toBe(0);await storage.verify('alice',id,input);
  const expired=await storage.createUpload('alice',input),old=await convexUpload(storage,'alice',expired,new TextEncoder().encode('xyz'),'text/plain');
  const stray=await t.run(ctx=>ctx.storage.store(new Blob(['stray'])));
  await t.run(async ctx=>{const row=await ctx.db.query('files').withIndex('owner_storage',q=>q.eq('userId','alice').eq('storageId',old as never)).unique();await ctx.db.patch(row!._id,{expiresAt:0});});
  expect(await rpc.mutation('files:sweep',{})).toBe(1);
  expect(await t.run(async ctx=>(await ctx.storage.get(old as never))===null)).toBe(true);
  expect(await t.run(async ctx=>(await ctx.storage.get(stray))!==null)).toBe(true);
  expect(new TextDecoder().decode((await storage.read('alice',id)).bytes)).toBe('abc');
 });
 it('refuses tickets above 25 MB',async()=>{
  const {storage}=current=harness();await expect(storage.createUpload('u',{name:'x',mediaType:'text/plain',size:25_000_001})).rejects.toThrow();
 });
});
describe('local fixture uploads',()=>{
 it('accepts bytes once, only for the ticket owner and exact size',async()=>{
  const s=createLocalToolsStorage('http://localhost'),input={name:'t.txt',mediaType:'text/plain',size:5};const url=await s.createUpload('u',input),token=new URL(url.uploadUrl).pathname.split('/').at(-1)!;
  await expect(s.acceptUpload!('other',token,new TextEncoder().encode('hello'),'text/plain')).rejects.toThrow();
  await expect(s.acceptUpload!('u',token,new Uint8Array(2),'text/plain')).rejects.toThrow();
  await s.acceptUpload!('u',token,new TextEncoder().encode('hello'),'text/plain');
  await expect(s.acceptUpload!('u',token,new TextEncoder().encode('hello'),'text/plain')).rejects.toThrow();
 });
});
describe('tools Convex authentication',()=>{
 it.each(['get','put','remove'])('rejects unauthorized %s',async name=>{
  const {t}=harness(),a={serverToken:'wrong',userId:'a',kind:'skill',id:'x',...(name==='put'?{value:{}}:{})};
  if(name==='get')await expect(t.query(makeFunctionReference<'query'>(`tools:${name}`),a)).rejects.toThrow('Server authentication');
  else await expect(t.mutation(makeFunctionReference<'mutation'>(`tools:${name}`),a)).rejects.toThrow('Server authentication');
 });
});
const live=!!(process.env.PRAXIS_TEST_CONVEX_URL&&process.env.PRAXIS_TEST_CONVEX_SERVER_TOKEN);
describe.skipIf(!live)('live tools storage',()=>{
 toolsStorageContract('Convex live contract',()=>toolsStorageFromRPC(createConvexRPC({url:process.env.PRAXIS_TEST_CONVEX_URL!,serverToken:process.env.PRAXIS_TEST_CONVEX_SERVER_TOKEN!}),'https://api.example.com'),async(_s,_u,url,bytes,type)=>{const r=await fetch(url.uploadUrl,{method:'POST',headers:{'Content-Type':type},body:Uint8Array.from(bytes)});return (await r.json()).storageId;});
});
