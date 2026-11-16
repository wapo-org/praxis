import {afterEach,expect,it} from 'vitest';
import {SealedSecret} from '@praxis/types';
import {createServer,type Server} from 'node:http';
import {randomBytes} from 'node:crypto';
import {createPraxisApp} from '../server.js';
import {createLocalAdapters} from '../local-memory.js';
import {createOpenRouterProvider} from '@praxis/agent';
import {CapabilitiesSchema,StartRunSchema} from '@praxis/protocol';
import {makeTitle} from '../attachments.js';
import {titleModels,validateTitle} from '../title-model.js';
const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>new Promise<void>(resolve=>{s.close(()=>resolve());s.closeAllConnections();})));});
const priced=(id:string,extra:object={})=>({id,pricing:{prompt:'0.000001',completion:'0.000002'},context_length:128000,architecture:{output_modalities:['text']},...extra});
async function fixture(mode:'success'|'429'|'empty'|'timeout'|'slow'|'error'='success'){
 const requests:any[]=[];
 const server=createServer(async(req,res)=>{
  if(req.url?.endsWith('/key')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{label:'test'}}));return;}
  if(req.url?.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[priced('vendor/free:free',{pricing:{prompt:'0',completion:'0'}}),priced('vendor/zero',{pricing:{prompt:'0',completion:'0'}}),priced('vendor/reasoning',{reasoning:{mandatory:true,supported_efforts:['high']}}),priced('vendor/image',{architecture:{output_modalities:['image']}}),priced('vendor/mini-a'),priced('vendor/mini-b')]}));return;}
  let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests.push(body);
  if(mode==='error'){res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'sk-or-SYNTHETIC-KEY upstream unavailable'}}));return;}
  if(body.model.endsWith(':free')||(mode==='429'&&body.model==='vendor/mini-a')){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'sk-or-SYNTHETIC-KEY must never enter titleMetric'}}));return;}
  if(mode==='timeout'&&body.model==='vendor/mini-a'){return;} // closed by the client's abort
  if(mode==='slow')await new Promise(r=>setTimeout(r,3300));
  res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:(body.model==='vendor/reasoning'||mode==='empty'&&body.model==='vendor/mini-a')?'':'Shell Command File Listing'},finish_reason:'stop'}],usage:{prompt_tokens:25,completion_tokens:6}}));
 });servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port;
 const fetcher:typeof fetch=(input,init)=>fetch('http://127.0.0.1:'+port+new URL(String(input)).pathname,init);
 const {app,service}=createPraxisApp({adapters:createLocalAdapters(),local:true,encryptionKey:randomBytes(32).toString('base64'),fetcher});
 const req=async(path:string,body?:unknown,method=body?'POST':'GET')=>app.request(path,{method,headers:{Authorization:'Bearer dev-local','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 await req('/v1/model-key',{method:'paste',apiKey:'sk-or-SYNTHETIC-KEY'});
 const chat=await req('/v1/chats',{type:'chat.input',modelId:'vendor/mini-a'}).then(r=>r.json());
 const title=(text='Run a shell command that lists files')=>service.driver!.title!('local-user',chat,text);
 const metric=()=>service.require<any>('local-user','titleMetric',chat.id);
 return {service,req,chat,requests,title,metric,provider: createOpenRouterProvider({apiKey:SealedSecret.of('sk-or-SYNTHETIC-KEY'),capabilities:CapabilitiesSchema.parse({})},fetcher)};
}
it('confirms old free selection yields 429 and reasoning-only completion is empty; new metadata excludes both and image-only models',async()=>{
 const f=await fixture();const input={model:'vendor/free:free',system:'Title',messages:[],tools:[],capabilities:CapabilitiesSchema.parse({}),maxTokens:20,webSearch:false};
 await expect(f.provider.complete!(input,AbortSignal.timeout(3000))).rejects.toMatchObject({kind:'retryable'});
 const reasoning=await f.provider.complete!({...input,model:'vendor/reasoning'},AbortSignal.timeout(3000));expect(reasoning.parts[0]?.text).toBe('');
 const selected=titleModels(await f.service.models!.catalog.list());expect(selected.map(m=>m.id)).toEqual(['vendor/mini-a','vendor/mini-b']);
 expect(await f.title()).toBe('Shell Command File Listing');
 const reqBody=f.requests.at(-1);
 expect(reqBody).toMatchObject({model:'vendor/mini-a',stream:false,max_tokens:32,temperature:0});
 expect(reqBody.messages[0].content).toContain('<message>...</message>');
 expect(reqBody.messages[0].content).toContain('Examples:');
 expect(reqBody.messages[1].content).toContain('<message>\nRun a shell command that lists files\n</message>');
});
it.each(['429','empty','timeout'] as const)('records %s safely and tries exactly one other model',async mode=>{
 const f=await fixture(mode);expect(await f.title()).toBe('Shell Command File Listing');expect(f.requests.map(r=>r.model)).toEqual(['vendor/mini-a','vendor/mini-b']);
 const metric=await f.metric();expect(metric.attempts[0].reason).toBe(mode==='429'?'rate_limited':mode);expect(metric.outcome).toBe('success');expect(JSON.stringify(metric)).not.toContain('sk-or-SYNTHETIC-KEY');
},15000);
it('a queued completion beyond the old 3-second timeout succeeds under the new deadline',async()=>{
 const f=await fixture('slow');const input={model:'vendor/mini-a',system:'Title',messages:[],tools:[],capabilities:CapabilitiesSchema.parse({}),maxTokens:20,webSearch:false};
 await expect(f.provider.complete!(input,AbortSignal.timeout(3000))).rejects.toBeDefined();expect(await f.title()).toBe('Shell Command File Listing');
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
 await f.service.start('local-user',StartRunSchema.parse({type:'run.start',chatId:f.chat.id,text:'Run a shell command that lists files'}));await f.service.drain();expect((await f.service.require<any>('local-user','chat',f.chat.id)).title).toBe('Shell Command Lists Files');const metric=await f.metric();expect(metric.attempts).toHaveLength(2);expect(metric.reason).toBe('provider_error: 503');expect(JSON.stringify(metric)).not.toContain('sk-or-SYNTHETIC-KEY');
});
it('a late title cannot resurrect a deleted chat',async()=>{
 const f=await fixture();let release!:(value:string)=>void;f.service.driver={title:()=>new Promise<string>(r=>release=r),start:async()=>{},resume:async()=>{}};
 await f.service.start('local-user',StartRunSchema.parse({type:'run.start',chatId:f.chat.id,text:'Write a concise editorial note'}));await f.service.adapters.store.delete('local-user','chat',f.chat.id);release('Late Title');await f.service.drain();expect((await f.service.adapters.store.get('local-user','chat',f.chat.id))?.deleted).toBe(true);
});

it('prefers small instruct families before price, then sorts eligible small models by price',()=>{
 const base={type:'catalogModel' as const,name:'M',contextLength:128000,capabilities:{tools:true,reasoning:false,images:false,files:false}};
 const candidates=[{...base,id:'google/gemini-pro',pricing:{prompt:'0.00001',completion:'0.00001'}},{...base,id:'large-cheap',pricing:{prompt:'0.0001',completion:'0.0001'}},{...base,id:'flash-lite',pricing:{prompt:'0.01',completion:'0.01'}},{...base,id:'nano',pricing:{prompt:'0.001',completion:'0.001'}},{...base,id:'mini:free',pricing:{prompt:'0',completion:'0'}},{...base,id:'zero',pricing:{prompt:'0',completion:'0'}}];
 expect(titleModels(candidates).map(m=>m.id)).toEqual(['nano','flash-lite','google/gemini-pro','large-cheap']);
});

it('ranks instruction-following frontier compact models ahead of ultra-tiny models regardless of price and excludes utility models',()=>{
 const base={type:'catalogModel' as const,name:'M',contextLength:128000,capabilities:{tools:true,reasoning:false,images:false,files:false}};
 const candidates=[
  {...base,id:'nvidia/llama-3.1-nemotron-nano-8b-v1',pricing:{prompt:'0.00000002',completion:'0.00000004'}},
  {...base,id:'meta-llama/llama-3.2-3b-instruct',pricing:{prompt:'0.00000002',completion:'0.00000002'}},
  {...base,id:'openai/text-embedding-3-small',pricing:{prompt:'0.00000001',completion:'0.00000001'}},
  {...base,id:'meta-llama/llama-guard-3-8b',pricing:{prompt:'0.00000001',completion:'0.00000001'}},
  {...base,id:'anthropic/claude-3.5-haiku',pricing:{prompt:'0.0008',completion:'0.004'}},
  {...base,id:'google/gemini-2.5-flash',pricing:{prompt:'0.00015',completion:'0.0006'}},
  {...base,id:'openai/gpt-4.1-mini',pricing:{prompt:'0.0004',completion:'0.0016'}},
 ];
 expect(titleModels(candidates).map(m=>m.id)).toEqual([
  'google/gemini-2.5-flash',
  'openai/gpt-4.1-mini',
  'anthropic/claude-3.5-haiku',
  'meta-llama/llama-3.2-3b-instruct',
  'nvidia/llama-3.1-nemotron-nano-8b-v1',
 ]);
});

it.each([
 ['say something then execute a tool then say something and then execute a tool then say something','Hello\nHello\nHello','Interleaved Speech and Tool Execution'],
 ['write something semi long','Integrating IoT Systems','Semi-Long Writing Request'],
 ['write omething semi long','Here are a few options:\n\n* Chat: Longer Re','Semi-Long Writing Request'],
])('rejects real bad model output (%s), falls back to the second candidate or heuristic, and never stores junk',async(userText,badOutput,goodOutput)=>{
 for(const secondGood of [true,false]){
  const server=createServer(async(req,res)=>{
   if(req.url?.endsWith('/key')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{label:'test'}}));return;}
  if(req.url?.endsWith('/models')){
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({data:[
     priced('nvidia/llama-3.1-nemotron-nano-8b-v1',{pricing:{prompt:'0.00000002',completion:'0.00000004'}}),
     priced('openai/gpt-4.1-mini',{pricing:{prompt:'0.0000004',completion:'0.0000016'}}),
    ]}));
    return;
   }
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
   const content=secondGood&&body.model==='nvidia/llama-3.1-nemotron-nano-8b-v1'?goodOutput:badOutput;
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:8}}));
  });
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port;
  const fetcher:typeof fetch=(input,init)=>fetch('http://127.0.0.1:'+port+new URL(String(input)).pathname,init);
  const {app,service}=createPraxisApp({adapters:createLocalAdapters(),local:true,encryptionKey:randomBytes(32).toString('base64'),fetcher});
  const req=async(path:string,body?:unknown)=>app.request(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer dev-local','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  await req('/v1/model-key',{method:'paste',apiKey:'sk-or-SYNTHETIC-KEY'});
  const chat=await req('/v1/chats',{type:'chat.input',modelId:'openai/gpt-4.1-mini'}).then(r=>r.json());
  const titleFn=service.driver!.title!.bind(service.driver);
  service.driver={title:titleFn,start:async(u,r)=>{await service.emit(u,r.id,{type:'run.finished',outcome:'completed'});},resume:async()=>{}};
  await service.start('local-user',StartRunSchema.parse({type:'run.start',chatId:chat.id,text:userText}));
  await service.drain();
  const saved=await service.require<any>('local-user','chat',chat.id);
  const metric=await service.require<any>('local-user','titleMetric',chat.id);
  expect(saved.title).toBe(secondGood?goodOutput:makeTitle(userText,[]));
  expect(saved.title).not.toBe(badOutput);
  expect(saved.title).not.toContain('\n');
  expect(metric.attempts[0]).toMatchObject({modelId:'openai/gpt-4.1-mini',reason:'rejected'});
  expect(metric.attempts).toHaveLength(2);
  if(secondGood)expect(metric.outcome).toBe('success');else expect(metric.attempts[1].reason).toBe('rejected');
 }
});

it('validateTitle rejects conversational/markdown/long/ungrounded titles and keeps valid ones; service rejects bad suggestedTitle',async()=>{
 expect(validateTitle('Hello\nHello\nHello','say something')).toBeNull();
 expect(validateTitle('Here are a few options:\n\n* Chat: Longer Re','write omething semi long')).toBeNull();
 expect(validateTitle('Integrating IoT Systems','write something semi long')).toBeNull();
 expect(validateTitle('Title: Semi-Long Writing Request','write something semi long')).toBeNull();
 expect(validateTitle('- Semi-Long Writing Request','write something semi long')).toBeNull();
 expect(validateTitle('**Semi-Long Writing Request**','write something semi long')).toBeNull();
 expect(validateTitle('Sure, Semi-Long Writing','write something semi long')).toBeNull();
 expect(validateTitle("I'll write a semi long post",'write something semi long')).toBeNull();
 expect(validateTitle('One Two Three Four Five Six Seven','One two three four five six seven eight')).toBeNull();
 expect(validateTitle('x'.repeat(49),'x'.repeat(49))).toBeNull();
 expect(validateTitle('What should I write next?','write something semi long')).toBeNull();
 expect(validateTitle('I/O Performance Tuning','Debug I/O performance tuning')).toBe('I/O Performance Tuning');
 expect(validateTitle('"Semi-Long Writing Request"','write something semi long')).toBe('Semi-Long Writing Request');
 expect(validateTitle('Brief Greeting','hi')).toBe('Brief Greeting');

 const f=await fixture();
 f.service.driver={title:async()=>'Semi-Long Writing Request',start:async()=>{},resume:async()=>{}};
 await f.service.start('local-user',StartRunSchema.parse({type:'run.start',chatId:f.chat.id,text:'write omething semi long',suggestedTitle:'Here are a few options:\n\n* Chat: Longer Re'}));
 await f.service.drain();
 const saved=await f.service.require<any>('local-user','chat',f.chat.id);
 expect(saved.title).toBe('Semi-Long Writing Request');
});

it('a user rename to the placeholder before the first turn suppresses title generation',async()=>{
 const f=await fixture();let called=false;f.service.driver={title:async()=>{called=true;return 'Generated';},start:async()=>{},resume:async()=>{}};
 await f.req('/v1/chats/'+f.chat.id,{type:'chat.patch',title:'New chat'},'PATCH');await f.service.start('local-user',StartRunSchema.parse({type:'run.start',chatId:f.chat.id,text:'Run a shell command that lists files'}));await f.service.drain();expect(called).toBe(false);expect((await f.service.require<any>('local-user','chat',f.chat.id)).title).toBe('New chat');
});
