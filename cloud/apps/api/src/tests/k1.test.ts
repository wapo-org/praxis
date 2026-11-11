import {expect,it} from 'vitest';
import {randomBytes} from 'node:crypto';
import {createLocalAdapters} from '../local-memory.js';
import {featureContext} from '../features.js';
import {ApiService} from '../service.js';
import {selectRunTools,briefTokenEstimate} from '../tool-selection.js';
import {protectAnswer,executionSecrets} from '../saved-secrets.js';
import {toolDisplay} from '../../../../packages/agent/src/tool-display.js';
import type {FeatureTool} from '../contracts.js';
import {ChatSchema} from '@praxis/protocol';
import {TOOL_BRIEFS} from '../tool-briefs.js';

it('selects account frequency, semantic matches, and conversation sticky tools',async()=>{
 const service=new ApiService(createLocalAdapters(),true),ctx=featureContext(service,'u');
 const chat=ChatSchema.parse({type:'chat',id:'c',title:'New chat',mode:'build',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 const tools:FeatureTool[]=Array.from({length:40},(_,i)=>({name:'t'+i,description:i===39?'Search scrape Firecrawl websites':'Unrelated '+i,inputSchema:{type:'object'},source:{type:'mcp',serverId:'s',serverName:'Service'},traits:['readOnly'],execute:async()=>null}));
 await service.put('u','message','m',{chatId:'other',role:'assistant',parts:[{type:'toolCall',name:'t0'}]});
 await service.put('u','message','n',{chatId:'c',role:'assistant',parts:[{type:'toolCall',name:'t38'}]});
 await service.put('u','message','q',{chatId:'c',role:'user',parts:[{type:'text',text:'Search Firecrawl websites'}],sequence:3});
 const selected=await selectRunTools(ctx,chat,tools);
 for(const name of ['t0','t38','t39'])expect(selected.find(t=>t.name===name)?.hidden).toBe(false);
 expect(selected.some(t=>t.hidden)).toBe(true);
 expect(briefTokenEstimate(selected)).toBeLessThan(1500);
});
it('display never contains qualified hashes and truncates query detail',()=>{
 const display=toolDisplay('mcp__firecrawl__firecrawl_search_bbc9571288db',{type:'tool.spec',name:'mcp__firecrawl__firecrawl_search_bbc9571288db',originalName:'firecrawl_search',description:'',source:{type:'mcp',serverId:'builtin-firecrawl',serverName:'Firecrawl'},traits:[],inputSchema:{}},{query:'a'.repeat(100)});
 expect(display.title).toBe('Firecrawl search');expect(display.detail).toHaveLength(60);
 for(const [id,entries] of Object.entries(TOOL_BRIEFS))for(const name of Object.keys(entries)){
  const d=toolDisplay(name,{type:'tool.spec',name,originalName:name,description:'',source:{type:'mcp',serverId:id,serverName:id.replace('builtin-','')},traits:[],inputSchema:{}});
  expect(d.title).not.toMatch(/mcp__|[a-f0-9]{12}/);
 }
 expect(toolDisplay('mcp__generic__list_records_abcdef123456').title).not.toContain('abcdef');
});
it('stores only encrypted sensitive answers; references resolve only at execution and outputs redact',async()=>{
 const service=new ApiService(createLocalAdapters(),true),ctx=featureContext(service,'u',{encryptionKey:randomBytes(32).toString('base64')});
 const answer=await protectAnswer(ctx,'c',{properties:{token:{type:'string',format:'password'}}},{token:'FAKE-SECRET-K1',__save_token:true});
 expect(answer.token).toMatch(/^\{\{secret:/);
 const secrets=await executionSecrets(ctx,'c');
 expect(secrets.resolve(answer.token!)).toBe('FAKE-SECRET-K1');
 expect(secrets.redact({result:'echo FAKE-SECRET-K1',error:'FAKE-SECRET-K1'})).toEqual({result:'echo '+answer.token,error:answer.token});
 const all=JSON.stringify(await ctx.store.changes('u',0,100));
 expect(all).not.toContain('FAKE-SECRET-K1');
 const other=await executionSecrets(featureContext(service,'other',{encryptionKey:ctx.encryptionKey}),'c');
 expect(()=>other.resolve(answer.token!)).toThrow();
});

it('calls Firecrawl directly on the first model turn and exposes ask_user in Execute',async()=>{
 const {setup,toolCall}=await import('./harness.js');
 const {createExecutionDriver}=await import('../execution.js');
 const {skillTools}=await import('../features/tools/builtin.js');
 const name='mcp__firecrawl__firecrawl_search_bbc9571288db';
 const f=setup([toolCall(name,{query:'Praxis news'})]);
 const chat=await f.chat();
 const ctx=featureContext(f.service,'local-user');
 const tools=skillTools(ctx);
 expect(tools.find(t=>t.name==='ask_user')).toBeDefined();
 let calls=0;
 f.service.driver=createExecutionDriver({service:f.service,fetcher:f.fake.fetcher,features:{tools:async()=>[...tools,{name,originalName:'firecrawl_search',description:'Find current sources; query, limit. Credits apply.',source:{type:'mcp',serverId:'builtin-firecrawl',serverName:'Firecrawl'},inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query']},traits:['readOnly'],execute:async()=>{calls++;return 'Source found';}}]}});
 const snap=await f.run(chat.id,'Search Firecrawl for Praxis news');
 expect(snap.run.status).toBe('completed');expect(calls).toBe(1);
 expect(f.fake.requests[0].tools.some((t:any)=>t.function.name===name)).toBe(true);
 expect(f.fake.requests[0].tools.some((t:any)=>t.function.name==='ask_user')).toBe(true);
});
it('titles use one non-streaming 20-token provider request and never replace a rename',async()=>{
 const {setup}=await import('./harness.js');
 const f=setup(),chat=await f.chat();
 await f.run(chat.id,'Please help plan a trip to Lisbon');
 expect(f.fake.titleRequests).toHaveLength(1);
 expect(f.fake.titleRequests[0].stream).toBe(false);
 expect(f.fake.titleRequests[0].max_tokens??f.fake.titleRequests[0].max_completion_tokens).toBe(20);
 await f.req('/v1/chats/'+chat.id,{type:'chat.patch',title:'My own title'},'PATCH');
 await f.run(chat.id,'Second message');
 expect((await f.req('/v1/chats/'+chat.id).then(r=>r.json())).title).toBe('My own title');
 expect(f.fake.titleRequests).toHaveLength(1);
});
it('redacts execution outputs, progress and errors before the agent can checkpoint or emit them',async()=>{
 const {adaptTool}=await import('../execution.js');
 const {saveSecret}=await import('../saved-secrets.js');
 const service=new ApiService(createLocalAdapters(),true),ctx=featureContext(service,'u',{encryptionKey:randomBytes(32).toString('base64')});
 const reference=await saveSecret(ctx,'token','SYNTHETIC-K1-CREDENTIAL',false,'c');
 const events:unknown[]=[];
 const tool=adaptTool({name:'echo_env',description:'Fake env fixture',inputSchema:{type:'object'},source:{type:'builtin'},traits:['readOnly'],execute:async(args,run)=>{
  const env=(args as any).env;
  expect(env.TOKEN).toBe('SYNTHETIC-K1-CREDENTIAL');
  await run.emit?.({type:'tool.progress',callId:'test',kind:'status',text:env.TOKEN});
  return {content:[{type:'text',text:env.TOKEN}]};
 }},ctx);
 const context={userId:'u',chatId:'c',runId:'r',mode:'build' as const,callId:'test',signal:new AbortController().signal,elicit:async()=>{throw new Error('unused')},callTool:async()=>{throw new Error('unused')},emit:async(e:any)=>{events.push(e)}};
 const result=await tool.execute({env:{TOKEN:reference}},context);
 expect(JSON.stringify({result,events})).not.toContain('SYNTHETIC-K1-CREDENTIAL');
 expect(JSON.stringify(result)).toContain(reference);
});
it('accepts a sensitive answer over HTTP without exposing it in decisions, checkpoints, events, transcript or model requests',async()=>{
 const {setup,toolCall}=await import('./harness.js');
 const {createExecutionDriver}=await import('../execution.js');
 const {skillTools}=await import('../features/tools/builtin.js');
 const f=setup([toolCall('ask_user',{message:'Provide a token',schema:{type:'object',properties:{token:{type:'string',format:'password'}},required:['token']}})]);
 const chat=await f.chat();
 f.service.driver=createExecutionDriver({service:f.service,fetcher:f.fake.fetcher,features:{tools:async()=>skillTools(featureContext(f.service,'local-user'))}});
 const parked=await f.run(chat.id,'Connect');
 expect(parked.run.status).toBe('awaitingElicitation');
 const id=parked.pendingElicitations[0]!.id;
 const response=await f.req('/v1/runs/'+parked.run.id+'/elicitations',{type:'elicitation.response',elicitationId:id,action:'accept',content:{token:'SYNTHETIC-HTTP-K1',__save_token:true}});
 expect(response.status).toBe(202);await f.service.drain();
 const rows=await f.service.adapters.store.changes('local-user',0,1000);
 const events=await f.service.adapters.events.read('local-user','run:'+parked.run.id,0,1000);
 expect(JSON.stringify({rows,events,requests:f.fake.requests})).not.toContain('SYNTHETIC-HTTP-K1');
 const metadata=await f.req('/v1/saved-secrets').then(r=>r.json());
 expect(metadata.items[0].name).toBe('token');
 expect(JSON.stringify(metadata)).not.toMatch(/cipher|SYNTHETIC-HTTP-K1/);
});
