import {afterEach,expect,it} from 'vitest';
import {createServer,type Server} from 'node:http';
import {randomBytes} from 'node:crypto';
import {createPraxisApp} from '../server.js';
import {createLocalAdapters} from '../local-memory.js';
import {createExecutionDriver} from '../execution.js';
import {createHTTPProvider} from '@praxis/agent';
import {CapabilitiesSchema,ChatSchema,StartRunSchema} from '@praxis/protocol';
import {makeTitle} from '../attachments.js';
import {titleModels} from '../title-model.js';
const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(resolve=>{s.close(()=>resolve());s.closeAllConnections();})));});
const priced=(id:string,extra:object={})=>({id,pricing:{prompt:'0.000001',completion:'0.000002'},architecture:{output_modalities:['text']},...extra});
async function fixture(mode:'success'|'429'|'empty'|'timeout'|'slow'|'error'='success'){
 const requests:any[]=[];
 const server=createServer(async(req,res)=>{
  if(req.url?.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[priced('vendor/free:free',{pricing:{prompt:'0',completion:'0'}}),priced('vendor/zero',{pricing:{prompt:'0',completion:'0'}}),priced('vendor/reasoning',{reasoning:{mandatory:true,supported_efforts:['high']}}),priced('vendor/image',{architecture:{output_modalities:['image']}}),priced('vendor/mini-a'),priced('vendor/mini-b')]}));return;}
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
  if(mode==='error'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'SYNTHETIC-KEY upstream unavailable'}}));return;}
  if(body.model.endsWith(':free')||(mode==='429'&&body.model==='vendor/mini-a')){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'SYNTHETIC-KEY must never enter titleMetric'}}));return;}
  if(mode==='timeout'&&body.model==='vendor/mini-a'){return;} // closed by the client's abort
  if(mode==='slow')await new Promise(r=>setTimeout(r,3300));
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:(body.model==='vendor/reasoning'||mode==='empty'&&body.model==='vendor/mini-a')?'':'Shell Command File Listing'},finish_reason:'stop'}],usage:{prompt_tokens:25,completion_tokens:6}}));
 });servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port;
 const fetcher:typeof fetch=(input,init)=>fetch('http://127.0.0.1:'+port+new URL(String(input)).pathname,init);
 const {app,service}=createPraxisApp({adapters:createLocalAdapters(),local:true,encryptionKey:randomBytes(32).toString('base64'),fetcher});
 const req=async(path:string,body?:unknown,method=body?'POST':'GET')=>app.request(path,{method,headers:{Authorization:'Bearer dev-local','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const provider=await req('/v1/providers',{type:'provider.input',name:'Fake OpenRouter',flavor:'openAIChat',baseUrl:'https://openrouter.ai/api/v1',apiKey:'SYNTHETIC-KEY'}).then(r=>r.json());
 await req('/v1/consents',{type:'consent',host:'openrouter.ai',allowed:true});
 expect((await req('/v1/providers/'+provider.id+'/refresh-models',{type:'models.refresh'})).ok).toBe(true);
 const chat=await req('/v1/chats',{type:'chat.input',providerId:provider.id,modelId:'vendor/mini-a'}).then(r=>r.json());
 const title=()=>service.driver!.title!('local-user',chat,'Run a shell command that lists files');
 const metric=()=>service.require<any>('local-user','titleMetric',chat.id);
 return {service,req,chat,requests,title,metric,provider: createHTTPProvider({baseUrl:'https://openrouter.ai/api/v1',flavor:'openAIChat',capabilities:CapabilitiesSchema.parse({})},fetcher)};
}
it('confirms old free selection yields 429 and reasoning-only completion is empty; new metadata excludes both and image-only models',async()=>{
 const f=await fixture();const input={model:'vendor/free:free',system:'Title',messages:[],tools:[],capabilities:CapabilitiesSchema.parse({}),maxTokens:20,webSearch:false};
 await expect(f.provider.complete(input,AbortSignal.timeout(3000))).rejects.toMatchObject({status:429});
 const reasoning=await f.provider.complete({...input,model:'vendor/reasoning'},AbortSignal.timeout(3000));expect(reasoning.parts[0]?.text).toBe('');
 const selected=titleModels((await f.service.list<any>('local-user','model')).filter(m=>m.providerId===f.chat.providerId));expect(selected.map(m=>m.id)).toEqual(['vendor/mini-a','vendor/mini-b']);
 expect(await f.title()).toBe('Shell Command File Listing');expect(f.requests.at(-1)).toMatchObject({model:'vendor/mini-a',stream:false,max_tokens:32,reasoning:{effort:'none',exclude:true}});
});
it.each(['429','empty','timeout'] as const)('records %s safely and tries exactly one other model',async mode=>{
 const f=await fixture(mode);expect(await f.title()).toBe('Shell Command File Listing');expect(f.requests.map(r=>r.model)).toEqual(['vendor/mini-a','vendor/mini-b']);
 const metric=await f.metric();expect(metric.attempts[0].reason).toBe(mode==='429'?'rate_limited':mode);expect(metric.outcome).toBe('success');expect(JSON.stringify(metric)).not.toContain('SYNTHETIC-KEY');
},15000);
it('a queued completion beyond the old 3-second timeout succeeds under the new deadline',async()=>{
 const f=await fixture('slow');const input={model:'vendor/mini-a',system:'Title',messages:[],tools:[],capabilities:CapabilitiesSchema.parse({}),maxTokens:20,webSearch:false};
 await expect(f.provider.complete(input,AbortSignal.timeout(3000))).rejects.toBeDefined();expect(await f.title()).toBe('Shell Command File Listing');
},15000);
it.each(['custom','same'] as const)('starts and finishes the run before title resolution, uses defer, and preserves %s rename',async rename=>{
 const f=await fixture();let release!:(value:string)=>void;const pending=new Promise<string>(r=>release=r);let titleStarted=false,runFinished=false;const deferred:Promise<unknown>[]=[];
 f.service.defer=work=>{deferred.push(work);};
 f.service.driver={title:async()=>{titleStarted=true;return pending;},start:async(u,r)=>{await f.service.emit(u,r.id,{type:'run.finished',outcome:'completed'});runFinished=true;},resume:async()=>{}};
 const run=await f.service.start('local-user',StartRunSchema.parse({type:'run.start',chatId:f.chat.id,text:'Run a shell command that lists files'}));
 expect(titleStarted).toBe(true);expect(deferred).toHaveLength(2);
 await deferred[0];expect(runFinished).toBe(true);expect((await f.service.require<any>('local-user','run',run.id)).status).toBe('completed');
 const current=await f.service.require<any>('local-user','chat',f.chat.id);expect(current.title).toBe('Shell Command Lists Files');
 const wanted=rename==='same'?current.title:'My Manual Title';await f.req('/v1/chats/'+f.chat.id,{type:'chat.patch',title:wanted},'PATCH');release('Late Provider Title');await f.service.drain();
 expect((await f.service.require<any>('local-user','chat',f.chat.id)).title).toBe(wanted);
});
it('applies background titles without losing simultaneous settings changes or resurrecting a deleted chat',async()=>{
 const f=await fixture();let release!:(value:string)=>void;f.service.driver={title:()=>new Promise<string>(r=>release=r),start:async()=>{},resume:async()=>{}};
 await f.service.start('local-user',StartRunSchema.parse({type:'run.start',chatId:f.chat.id,text:'Write a concise editorial note'}));await f.req('/v1/chats/'+f.chat.id,{type:'chat.patch',pinned:true},'PATCH');release('Editorial Note Drafting');await f.service.drain();expect(await f.service.require('local-user','chat',f.chat.id)).toMatchObject({title:'Editorial Note Drafting',pinned:true});
});
it.each([
 ['Run a shell command that lists files','Shell Command Lists Files'],
 ['Start an elicitation form to clarify deployment parameters','Elicitation Form Clarify Deployment Parameters'],
 ['Write a concise editorial note','Concise Editorial Note'],
 ['Can you please show me how to run a shell command that lists files','Shell Command Lists Files'],
])('keyword fallback: %s', (input,expected)=>{expect(makeTitle(input,[])).toBe(expected.slice(0,42));expect(makeTitle(input,[])).not.toBe(input.split(' ').slice(0,5).join(' '));});

it('records bounded provider error codes and keeps the keyword fallback when both models fail',async()=>{
 const f=await fixture('error');const title=f.service.driver!.title!.bind(f.service.driver);f.service.driver={title,start:async(u,r)=>{await f.service.emit(u,r.id,{type:'run.finished',outcome:'completed'});},resume:async()=>{}};
 await f.service.start('local-user',StartRunSchema.parse({type:'run.start',chatId:f.chat.id,text:'Run a shell command that lists files'}));await f.service.drain();expect((await f.service.require<any>('local-user','chat',f.chat.id)).title).toBe('Shell Command Lists Files');const metric=await f.metric();expect(metric.attempts).toHaveLength(2);expect(metric.reason).toBe('provider_error: 503');expect(JSON.stringify(metric)).not.toContain('SYNTHETIC-KEY');
});
it('a late title cannot resurrect a deleted chat',async()=>{
 const f=await fixture();let release!:(value:string)=>void;f.service.driver={title:()=>new Promise<string>(r=>release=r),start:async()=>{},resume:async()=>{}};
 await f.service.start('local-user',StartRunSchema.parse({type:'run.start',chatId:f.chat.id,text:'Write a concise editorial note'}));await f.service.adapters.store.delete('local-user','chat',f.chat.id);release('Late Title');await f.service.drain();expect((await f.service.adapters.store.get('local-user','chat',f.chat.id))?.deleted).toBe(true);
});

it('prefers small instruct families before price, then sorts eligible small models by price',()=>{
 const base={type:'model' as const,providerId:'p',displayName:'M',capabilities:CapabilitiesSchema.parse({}),reasoningEfforts:[],pinned:false,favorite:false};
 const candidates=[{...base,id:'large-cheap',pricing:{prompt:0.0001,completion:0.0001}},{...base,id:'flash-lite',pricing:{prompt:0.01,completion:0.01}},{...base,id:'nano',pricing:{prompt:0.001,completion:0.001}},{...base,id:'mini:free'},{...base,id:'zero',pricing:{prompt:0,completion:0}}];
 expect(titleModels(candidates).map(m=>m.id)).toEqual(['nano','flash-lite','large-cheap']);
});

it('a user rename to the placeholder before the first turn suppresses title generation',async()=>{
 const f=await fixture();let called=false;f.service.driver={title:async()=>{called=true;return 'Generated';},start:async()=>{},resume:async()=>{}};
 await f.req('/v1/chats/'+f.chat.id,{type:'chat.patch',title:'New chat'},'PATCH');await f.service.start('local-user',StartRunSchema.parse({type:'run.start',chatId:f.chat.id,text:'Run a shell command that lists files'}));await f.service.drain();expect(called).toBe(false);expect((await f.service.require<any>('local-user','chat',f.chat.id)).title).toBe('New chat');
});
