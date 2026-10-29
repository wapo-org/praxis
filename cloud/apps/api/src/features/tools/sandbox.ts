import {getQuickJS,type QuickJSDeferredPromise,type QuickJSHandle} from 'quickjs-emscripten';
import {z} from 'zod';
import {JsonValueSchema,type JsonValue} from '@praxis/protocol';
import type {FeatureContext,FeatureTool} from '../../contracts.js';
import {ApiError} from '../../service.js';
import {publicFetch} from './http.js';
export type ToolExecution=Parameters<FeatureTool['execute']>[1]&{signal?:AbortSignal;callId?:string};
export interface SandboxFiles {list():Promise<string[]>;read(name:string):Promise<Uint8Array>}
const Code=z.object({code:z.string().max(200000),timeout_ms:z.number().int().min(1).max(30000).default(5000)});
const FetchInput=z.object({url:z.string().url(),method:z.enum(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']).default('GET'),headers:z.record(z.string(),z.string()).default({}),body:z.string().max(1000000).optional()});
/** WASM gets JSON/strings only. No Node functions/objects, module loader, or filesystem leak into it. */
export async function runSandbox(args:JsonValue,ctx:FeatureContext,execution:ToolExecution,files:SandboxFiles,toolNames:string[]){
 const input=Code.parse(args);if(execution.mode==='ask')throw new ApiError(403,'mode_denied','Running JavaScript is unavailable in Ask mode');
 const key=JSON.stringify(['tools','js-kv',ctx.userId,execution.chatId]);const saved=await ctx.store.get(ctx.userId,'javascriptKV',execution.chatId);const initial=saved&&!saved.deleted?saved.value.data??{}:{};
 const quickJS=await getQuickJS(),runtime=quickJS.newRuntime();runtime.setMemoryLimit(16*1024*1024);runtime.setMaxStackSize(512*1024);
 const started=Date.now(),deadline=started+input.timeout_ms;const controller=new AbortController();const signal=execution.signal?AbortSignal.any([execution.signal,controller.signal]):controller.signal;
 runtime.setInterruptHandler(()=>Date.now()>=deadline||signal.aborted);
 const vm=runtime.newContext(),deferred=new Set<QuickJSDeferredPromise>(),pending=new Set<Promise<void>>();let alive=true,fetches=0,calls=0,hostFailure:unknown;
 function hostValue(value:unknown){return vm.newString(JSON.stringify(value)??'null');}
 const bridge=vm.newFunction('__host',(opHandle,dataHandle)=>{
  const op=vm.getString(opHandle),raw=vm.getString(dataHandle);if(Buffer.byteLength(raw)>1000000)return {error:vm.newError('Bridge input exceeds limit')};
  const promise=vm.newPromise();deferred.add(promise);
  const work=(async()=>{try{
   if(signal.aborted||Date.now()>=deadline)throw new Error('Execution cancelled or timed out');
   const data=JSON.parse(raw);let result:unknown;
   if(op==='fetch'){
    if(++fetches>16)throw new Error('Fetch call limit exceeded');const request=FetchInput.parse(data);
    if(execution.mode==='plan'&&!['GET','HEAD'].includes(request.method))throw new ApiError(403,'method_denied','Plan mode permits GET and HEAD only');
    const forbidden=['authorization','cookie','host','connection','proxy-authorization','transfer-encoding'];if(Object.keys(request.headers).some(h=>forbidden.includes(h.toLowerCase())))throw new Error('Credential and routing headers are not allowed');
    const {response,bytes}=await publicFetch(ctx,request.url,{method:request.method,headers:request.headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,signal},true,1000000);
    result={status:response.status,statusText:response.statusText,url:request.url,headers:[...response.headers.entries()],body:new TextDecoder().decode(bytes)};
   }else if(op==='fs.list')result=await files.list();
   else if(op==='fs.read'){
    const name=z.string().min(1).max(240).parse(data);if(name.includes('/')||name.includes('\\')||name.includes('\0')||name==='.'||name==='..'||name.startsWith('~'))throw new Error('Expected a plain attached filename');
    const bytes=await files.read(name);if(bytes.length>1000000)throw new Error('File exceeds 1 MB');result=[...bytes];
   }else if(op==='tool'){
    const call=z.object({name:z.string(),args:JsonValueSchema}).parse(data);if(++calls>32)throw new Error('Nested tool call limit exceeded');if(!toolNames.includes(call.name)||call.name==='run_javascript')throw new Error('Tool is unavailable');if(!execution.callTool)throw new Error('Policy tool bridge is unavailable');
    try{result=await execution.callTool(call.name,call.args);}catch(e){hostFailure=e;throw e;}
   }else throw new Error('Unknown bridge operation');
   const encoded=JSON.stringify({ok:true,value:result});if(Buffer.byteLength(encoded)>5000000)throw new Error('Bridge output exceeds limit');
   if(alive&&!signal.aborted){const value=vm.newString(encoded);promise.resolve(value);value.dispose();}
  }catch(e){if(alive&&!signal.aborted){const message=e instanceof ApiError?e.message:e instanceof z.ZodError?'Invalid bridge arguments':e instanceof Error?e.message:'Bridge operation failed';const value=hostValue({ok:false,error:message});promise.resolve(value);value.dispose();}}})();
  pending.add(work);void work.finally(()=>pending.delete(work));return promise.handle;
 });
 vm.setProp(vm.global,'__host',bridge);bridge.dispose();
 let handle:QuickJSHandle|undefined;
 const timeout=setTimeout(()=>controller.abort(),input.timeout_ms);timeout.unref();
 const prelude=`
 const __rpc=async(op,data)=>{const r=JSON.parse(await __host(op,JSON.stringify(data)));if(!r.ok)throw new Error(r.error);return r.value;};
 const __logs=[];let __logBytes=0;const console=Object.fromEntries(['log','info','warn','error','debug'].map(level=>[level,(...a)=>{if(__logs.length>=100)return;const text=a.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' ').slice(0,4000);if((__logBytes+=text.length)<=32000)__logs.push({level,text});}]));
 const __kv=new Map(Object.entries(${JSON.stringify(initial)}));const kv={get:k=>__kv.get(String(k))??null,set:(k,v)=>{k=String(k);if(k.length>200)throw new Error('KV key too long');const n=new Map(__kv);n.set(k,v);if(n.size>256||JSON.stringify(Object.fromEntries(n)).length>262144)throw new Error('KV quota exceeded');__kv.set(k,JSON.parse(JSON.stringify(v)));},delete:k=>__kv.delete(String(k)),keys:()=>[...__kv.keys()].sort()};
 const fs={list:()=>__rpc('fs.list',null),readBytes:async n=>new Uint8Array(await __rpc('fs.read',n)),readText:async n=>{const a=await __rpc('fs.read',n);return decodeURIComponent(escape(String.fromCharCode(...a)));}};
 const fetch=async(url,init={})=>{const r=await __rpc('fetch',{url:String(url),method:String(init.method??'GET').toUpperCase(),headers:init.headers??{},...(init.body!==undefined?{body:typeof init.body==='string'?init.body:JSON.stringify(init.body)}:{})});return {status:r.status,ok:r.status>=200&&r.status<300,statusText:r.statusText,url:r.url,headers:{get:k=>r.headers.find(([n])=>n.toLowerCase()===k.toLowerCase())?.[1]??null,entries:()=>r.headers[Symbol.iterator]()},text:async()=>r.body,json:async()=>JSON.parse(r.body)};};
 const callTool=(name,args={})=>__rpc('tool',{name,args});const tools=Object.create(null);for(const name of ${JSON.stringify(toolNames.filter(n=>n!=='run_javascript'))})tools[name]=args=>callTool(name,args);
 `;
 try{
  const evaluated=vm.evalCode(`(async()=>{${prelude}\nconst result=await(async()=>{${input.code}\n})();const output=JSON.stringify({console:__logs,result:result??null,kv:Object.fromEntries(__kv)});if(output.length>400000)throw new Error('Result exceeds limit');return output;})()`,'run.js');
  if(evaluated.error){const error=vm.dump(evaluated.error);evaluated.error.dispose();return {console:[],error:{name:'JavaScriptError',message:safeError(error)},ms:Date.now()-started};}handle=evaluated.value;
  while(true){
   if(hostFailure)throw hostFailure;
   if(Date.now()>=deadline||signal.aborted)return {console:[],error:{name:execution.signal?.aborted?'AbortError':'TimeoutError',message:'Execution cancelled or timed out'},ms:Date.now()-started};
   const jobs=runtime.executePendingJobs(100);if(jobs.error){const error=vm.dump(jobs.error);jobs.error.dispose();return {console:[],error:{name:'JavaScriptError',message:safeError(error)},ms:Date.now()-started};}
   const state=vm.getPromiseState(handle);
   if(state.type==='fulfilled'){const raw=vm.getString(state.value);state.value.dispose();if(Buffer.byteLength(raw)>400000)throw new Error('Result exceeds limit');const output=z.object({console:z.array(z.object({level:z.string(),text:z.string()})),result:JsonValueSchema,kv:z.record(z.string(),JsonValueSchema)}).parse(JSON.parse(raw));if(Buffer.byteLength(JSON.stringify(output.kv))>262144)throw new Error('KV quota exceeded');await ctx.store.put(ctx.userId,'javascriptKV',execution.chatId,{data:output.kv});return {console:output.console,result:output.result,ms:Date.now()-started};}
   if(state.type==='rejected'){const error=vm.dump(state.error);state.error.dispose();return {console:[],error:{name:'JavaScriptError',message:safeError(error)},ms:Date.now()-started};}
   if(!runtime.hasPendingJob()&&!pending.size)return {console:[],error:{name:'UnsettledPromise',message:'Script returned a promise that cannot settle'},ms:Date.now()-started};
   await new Promise<void>(resolve=>{const t=setTimeout(resolve,1);if(signal.aborted){clearTimeout(t);resolve();}});
  }
 }finally{alive=false;controller.abort();clearTimeout(timeout);handle?.dispose();for(const p of deferred)if(p.alive)p.dispose();vm.dispose();runtime.dispose();}
}
function safeError(value:unknown){if(value&&typeof value==='object'&&'message' in value)return String(value.message).slice(0,2000);return String(value).slice(0,2000);}
