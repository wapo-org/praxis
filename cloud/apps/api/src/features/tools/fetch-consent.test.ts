import {it,expect,vi} from 'vitest';
import {runSandbox} from './sandbox.js';
import {toolsState} from './state.js';
import {createLocalAdapters} from '../../local-memory.js';
import type {FeatureContext} from '../../contracts.js';
it('fetches Hacker News after inline consent and propagates durable parking instead of a JS error',async()=>{
 const ctx:FeatureContext={...createLocalAdapters(),local:true,userId:'u',fetch,egress:vi.fn(async()=>Response.json([1,2,3]))};
 const files={list:async()=>[],read:async()=>new Uint8Array()};const args={code:"const r=await fetch('https://hacker-news.firebaseio.com/v0/newstories.json');return await r.json();"};
 const parked=new Error('durable park');const run={chatId:'c',runId:'r',mode:'build' as const,elicit:vi.fn(async()=>{throw parked;})};
 await expect(runSandbox(args,ctx,run,files,[],toolsState(ctx))).rejects.toBe(parked);expect(ctx.egress).not.toHaveBeenCalled();
 const elicit=vi.fn(async()=>({type:'elicitation.response' as const,elicitationId:'e',action:'accept' as const,content:{allow:true}}));
 expect(await runSandbox(args,ctx,{...run,elicit},files,[],toolsState(ctx))).toMatchObject({result:[1,2,3]});expect(elicit).toHaveBeenCalledOnce();
});
it('restores a serialized JavaScript fetch checkpoint after consent without tool approval in Execute',async()=>{
 const {AgentRunner,createScriptedProvider,textResult}=await import('@praxis/agent');const {ChatSchema,RunSchema}=await import('@praxis/protocol');
 const ctx:FeatureContext={...createLocalAdapters(),local:true,userId:'u',fetch,egress:vi.fn(async()=>Response.json([42]))};
 const tools=[{spec:{type:'tool.spec' as const,name:'local_echo',description:'Consent fetch',inputSchema:{type:'object'},source:{type:'javascript' as const},traits:['sandboxed' as const]},execute:async(_args:unknown,run:import('@praxis/agent').ToolContext)=>textResult(JSON.stringify(await runSandbox({code:"return await (await fetch('https://hacker-news.firebaseio.com/v0/newstories.json')).json()"},ctx,{chatId:run.chatId,runId:run.runId,mode:run.mode,signal:run.signal,elicit:request=>run.elicit(request)},{list:async()=>[],read:async()=>new Uint8Array()},[],toolsState(ctx))))}];
 let events=0;const options={provider:createScriptedProvider('tools'),tools,ports:{save:async()=>{},emit:async()=>++events,isCancelled:async()=>false}};
 const parked=await new AgentRunner(options).run({userId:'u',run:RunSchema.parse({type:'run',id:'r',chatId:'c',status:'queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lastEventId:0}),chat:ChatSchema.parse({type:'chat',id:'c',title:'C',mode:'build',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}),messages:[]});
 expect(parked.run.status).toBe('awaitingElicitation');expect(parked.approval).toBeUndefined();
 const finished=await new AgentRunner(options).resume(JSON.parse(JSON.stringify(parked)),{type:'elicitation.response',elicitationId:parked.elicitation!.id,action:'accept',content:{allow:true}});
 expect(finished.run.status).toBe('completed');expect(ctx.egress).toHaveBeenCalledOnce();expect(JSON.stringify(finished.messages)).toContain('42');
});
