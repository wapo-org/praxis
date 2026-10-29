import {it,expect} from 'vitest';
import {CapabilitiesSchema,type JsonValue,type ToolSpec} from '@praxis/protocol';
import {AgentRunner,textResult,type AgentTool,type AgentCheckpoint,type ModelProvider,type RunInput} from './index.js';
const time='2026-10-29T00:00:00.000Z';
function input():RunInput{return {userId:'u',run:{type:'run',id:'r',chatId:'c',status:'queued',lastEventId:0,createdAt:time,updatedAt:time},chat:{type:'chat',id:'c',title:'Test',pinned:false,mode:'auto',connectorIds:[],disabledConnectorIds:[],createdAt:time,updatedAt:time},messages:[{type:'message',id:'m',chatId:'c',role:'user',parts:[{type:'text',text:'Save skill'}],createdAt:time,updatedAt:time}]};}
function fixture(args:JsonValue,classification:()=>{traits:ToolSpec['traits'];policyKey?:string}) {
  let ran=0;const tool:AgentTool={spec:{type:'tool.spec',name:'save_skill',description:'Save skill',source:{type:'skill'},traits:[],inputSchema:{type:'object'}},classify:classification,execute:async()=>{ran++;return textResult('saved');}};
  const provider:ModelProvider={flavor:'openAIChat',capabilities:CapabilitiesSchema.parse({}),async *stream(request){yield {type:'completed',response:{parts:request.messages.some(m=>m.parts.some(p=>p.type==='toolResult'))?[{type:'text',text:'Done'}]:[{type:'toolCall',callId:'call',name:'save_skill',arguments:JSON.stringify(args)}],stop:'endTurn',usage:{type:'usage',inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0}}};}};
  const runner=new AgentRunner({provider,tools:[tool],ports:{save:async()=>{},emit:async()=>{},isCancelled:async()=>false}});
  return {runner,tool,get ran(){return ran;}};
}
it('classifies skill creation separately from replacement while preserving the frozen catalog',async()=>{
  const f=fixture({replace:false},()=>({traits:[],policyKey:'create'}));const created=await f.runner.run(input());expect(created.run.status).toBe('completed');expect(f.ran).toBe(1);expect(created.setup.tools[0]?.traits).toEqual([]);
  const r=fixture({replace:true},()=>({traits:['destructive'],policyKey:'replace'}));const parked=await r.runner.run(input());expect(parked.run.status).toBe('awaitingApproval');expect(r.ran).toBe(0);expect(parked.setup.tools[0]?.traits).toEqual([]);
});
it('binds alwaysAllow to the classified policyKey and frozen schema',async()=>{
  const a=fixture({},()=>({traits:['destructive'],policyKey:'skill:a'})),cp=await a.runner.run(input());
  const allowed=await a.runner.resume(cp,{type:'approval.decision',approvalId:cp.approval!.id,decision:'allowAlways'});expect(allowed.policy.alwaysAllow).toHaveLength(1);
  const b=fixture({},()=>({traits:['destructive'],policyKey:'skill:b'}));const i=input();i.policy=allowed.policy;expect((await b.runner.run(i)).run.status).toBe('awaitingApproval');
  const same=fixture({},()=>({traits:['destructive'],policyKey:'skill:a'}));expect((await same.runner.run(i)).run.status).toBe('completed');
});
it('requires fresh approval if classification changes while parked',async()=>{
  let key='first';const f=fixture({},()=>({traits:['destructive'],policyKey:key})),cp=await f.runner.run(input());key='second';
  const changed=await f.runner.resume(cp,{type:'approval.decision',approvalId:cp.approval!.id,decision:'allowOnce'});expect(changed.run.status).toBe('awaitingApproval');expect(changed.approval?.id).not.toBe(cp.approval!.id);expect(f.ran).toBe(0);
});
it('fails closed when a classifier throws',async()=>{
  const f=fixture({},()=>{throw new Error('Cannot resolve target');});const cp=await f.runner.run(input());expect(f.ran).toBe(0);expect(cp.run.status).toBe('completed');expect(JSON.stringify(cp.messages)).toContain('classification failed');
});
