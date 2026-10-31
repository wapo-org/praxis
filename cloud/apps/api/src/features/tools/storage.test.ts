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
 });
 const rpc:ConvexRPC={query:(n,a)=>t.query(makeFunctionReference<'query'>(n),{...a,serverToken:token}),mutation:(n,a)=>t.mutation(makeFunctionReference<'mutation'>(n),{...a,serverToken:token}),action:(n,a)=>t.action(makeFunctionReference<'action'>(n),{...a,serverToken:token})};
 // Storage URLs from convex-test are fake; serve their bytes from the test deployment instead of the network.
 const fetcher=(async(input:RequestInfo|URL)=>{
  const sha=String(input).split('/api/storage/')[1]!;
  const bytes=await t.run(async ctx=>{const doc=(await ctx.db.system.query('_storage').collect()).find(d=>d.sha256===sha);const blob=doc?await ctx.storage.get(doc._id):null;return blob?await blob.arrayBuffer():null;});
  return bytes?new Response(bytes):new Response(null,{status:404});
 }) as typeof fetch;
 return {t,storage:toolsStorageFromRPC(rpc,'https://api.example.com',fetcher)};
}
const localUpload:ClientUpload=async(s,user,url,bytes,type)=>s.acceptUpload!(user,new URL(url.uploadUrl).pathname.split('/').at(-1)!,bytes,type);
toolsStorageContract('tools storage: local',()=>createLocalToolsStorage('http://localhost'),localUpload);
let current:ReturnType<typeof harness>;
/** The client's direct POST to the Convex upload URL, simulated by storing the blob in the test deployment. */
const convexUpload:ClientUpload=async(_s,_user,url,bytes,type)=>{expect(url.method).toBe('POST');expect(url.uploadUrl).toContain('convex.cloud');return current.t.run(ctx=>ctx.storage.store(new Blob([Uint8Array.from(bytes)],{type})));};
toolsStorageContract('tools storage: Convex database (direct upload URL)',()=>(current=harness()).storage,convexUpload);
describe('Convex direct uploads',()=>{
 it('handles 25 MB without passing bytes through a function argument',async()=>{
  const {t,storage}=current=harness(),user='big',size=25_000_000,input={name:'big.bin',mediaType:'application/octet-stream',size};
  const url=await storage.createUpload(user,input);expect(url.method).toBe('POST');
  const id=await t.run(ctx=>ctx.storage.store(new Blob([new Uint8Array(size)],{type:input.mediaType})));
  await storage.verify(user,id,input);expect((await storage.read(user,id)).bytes.byteLength).toBe(size);
 });
 it('rejects a blob that does not match an open ticket and deletes it, and never lets a second owner claim',async()=>{
  const {t,storage}=current=harness(),input={name:'a.txt',mediaType:'text/plain',size:3};
  const stray=await t.run(ctx=>ctx.storage.store(new Blob(['zzz'],{type:'text/plain'})));
  await expect(storage.verify('alice',stray,input)).rejects.toThrow();
  expect(await t.run(async ctx=>(await ctx.storage.get(stray as never))===null)).toBe(true);
  await storage.createUpload('alice',input);await storage.createUpload('mallory',input);
  const id=await t.run(ctx=>ctx.storage.store(new Blob(['abc'],{type:'text/plain'})));
  await storage.verify('alice',id,input);await expect(storage.verify('mallory',id,input)).rejects.toThrow();
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
