import {describe,it,expect} from 'vitest';
import {CapabilitiesSchema,RunEventPayloadSchema,type RunEventPayload,type ToolSpec,type Message} from '@praxis/protocol';
import {AgentRunner,createScriptedRunner,createScriptedProvider,scriptedTools,alwaysAllowKey,decideTool,textResult,ProviderFailure,CheckpointSchema,type AgentCheckpoint,type AgentPorts,type RunInput,type ModelProvider,type ProviderRequest} from './index.js';
const time='2026-10-29T12:00:00.000Z';
function input():RunInput{return {userId:'u',run:{type:'run',id:'r',chatId:'c',status:'queued',createdAt:time,updatedAt:time,lastEventId:0},chat:{type:'chat',id:'c',title:'Chat',pinned:false,mode:'build',connectorIds:[],disabledConnectorIds:[],createdAt:time,updatedAt:time},messages:[{type:'message',id:'m',chatId:'c',runId:'r',role:'user',parts:[{type:'text',text:'Hello'}],createdAt:time,updatedAt:time}]};}
function harness(){let saved:AgentCheckpoint|undefined,cancel=false,id=0;const events:RunEventPayload[]=[];const ports:AgentPorts={save:async(user,cp)=>{expect(user).toBe('u');saved=structuredClone(cp);},emit:async(user,run,e)=>{expect(user).toBe('u');expect(run).toBe('r');RunEventPayloadSchema.parse(e);events.push(structuredClone(e));return events.length;},isCancelled:async()=>cancel,now:()=>time,id:()=>`id-${++id}`,sleep:async()=>{}};return {ports,events,get saved(){return saved;},cancel(){cancel=true;}};}
const custom=(stream:ModelProvider['stream']):ModelProvider=>({flavor:'openAIChat',capabilities:CapabilitiesSchema.parse({}),stream});
describe('scripted durable loop',()=>{
  it.each(['text','tools','long','vision'] as const)('runs %s, preserves the input prefix and emits terminal',async script=>{
    const h=harness(),i=input();const cp=await createScriptedRunner(h.ports,script).run(i);
    expect(cp.run.outcome).toBe('completed');expect(cp.messages[0]).toEqual(i.messages[0]);expect(cp.messages.filter(m=>m.id==='m')).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({type:'run.finished',outcome:'completed'});expect(h.saved?.run.status).toBe('completed');
  });
  it.each(['allowOnce','allowAlways','deny'] as const)('parks approvals and resumes %s from JSON',async decision=>{
    const h=harness();let runner=createScriptedRunner(h.ports,'approval');const cp=await runner.run(input());
    expect(cp.run.status).toBe('awaitingApproval');expect(cp.approval).toBeDefined();
    runner=createScriptedRunner(h.ports,'approval');const done=await runner.resume(JSON.parse(JSON.stringify(cp)),{type:'approval.decision',approvalId:cp.approval!.id,decision});
    expect(done.run.status).toBe('completed');expect(h.events.some(e=>e.type==='tool.finished'&&e.completion.status===(decision==='deny'?'denied':'succeeded'))).toBe(true);
    expect(done.policy.alwaysAllow.length).toBe(decision==='allowAlways'?1:0);
    expect((await runner.resume(done,{type:'approval.decision',approvalId:cp.approval!.id,decision})).messages).toEqual(done.messages);
    await expect(runner.resume(done,{type:'approval.decision',approvalId:cp.approval!.id,decision:decision==='deny'?'allowOnce':'deny'})).rejects.toThrow('Conflicting');
  });
  it.each(['allowOnce','deny'] as const)('resumes nested %s without a held stack',async decision=>{
    const h=harness(),runner=createScriptedRunner(h.ports,'nestedApproval');const cp=await runner.run(input());expect(cp.approval?.parentCallId).toBeDefined();
    const done=await createScriptedRunner(h.ports,'nestedApproval').resume(cp,{type:'approval.decision',approvalId:cp.approval!.id,decision});expect(done.run.outcome).toBe('completed');
    expect(Object.values(done.calls).filter(c=>c.result)).toHaveLength(2);
  });
  it('parks and restores elicitation',async()=>{
    const h=harness(),runner=createScriptedRunner(h.ports,'elicitation');const cp=await runner.run(input());expect(cp.run.status).toBe('awaitingElicitation');
    const done=await createScriptedRunner(h.ports,'elicitation').resume(cp,{type:'elicitation.response',elicitationId:cp.elicitation!.id,action:'accept',content:{name:'Ada'}});
    expect(done.run.status).toBe('completed');expect(JSON.stringify(done.messages)).toContain('Ada');
  });
  it('rejects stale and invalid resumes',async()=>{
    const h=harness(),runner=createScriptedRunner(h.ports,'approval'),cp=await runner.run(input());
    await expect(runner.resume(cp,{type:'approval.decision',approvalId:'other',decision:'deny'})).rejects.toThrow('no longer pending');
    await expect(runner.resume(cp,{type:'approval.decision',approvalId:'other',decision:'invalid'})).rejects.toThrow();
  });
  it('hands off and continues a JSON checkpoint',async()=>{
    const h=harness(),runner=createScriptedRunner(h.ports,'tools'),cp=await runner.run(input(),1);expect(cp.run.status).toBe('continuing');
    const done=await runner.advance(CheckpointSchema.parse(JSON.parse(JSON.stringify(cp))));expect(done.run.outcome).toBe('completed');
  });
  it('cancel before provider and while parked is terminal',async()=>{
    const h=harness();h.cancel();const runner=createScriptedRunner(h.ports);const cp=await runner.run(input());expect(cp.run.outcome).toBe('cancelled');expect(cp.messages).toHaveLength(1);
    const h2=harness(),r2=createScriptedRunner(h2.ports,'approval'),park=await r2.run(input());expect((await r2.cancel(park)).run.status).toBe('cancelled');
  });
  it('cancel during silent stream aborts promptly',async()=>{
    const h=harness();let aborted=false;const runner=new AgentRunner({ports:h.ports,provider:custom(async function*(_,signal){signal.addEventListener('abort',()=>{aborted=true;});yield {type:'text',index:0,text:'partial'};await new Promise(()=>{});})});
    const timer=setTimeout(()=>h.cancel(),30);const cp=await runner.run(input());clearTimeout(timer);expect(cp.run.status).toBe('cancelled');expect(aborted).toBe(true);expect(cp.messages).toHaveLength(1);
  });
  it('cancel during tool does not commit late results',async()=>{
    const h=harness(),tools=scriptedTools();tools[0]!.execute=async()=>{h.cancel();return textResult('late');};
    const cp=await new AgentRunner({ports:h.ports,tools,provider:createScriptedProvider('tools')}).run(input());expect(cp.run.status).toBe('cancelled');expect(cp.messages).toHaveLength(2);
  });
  it('times out a noncooperative tool',async()=>{
    const h=harness(),tools=scriptedTools();tools[0]!.execute=async()=>new Promise(()=>{});
    const cp=await new AgentRunner({ports:h.ports,tools,provider:createScriptedProvider('tools'),toolTimeoutMs:10}).run(input());expect(cp.run.outcome).toBe('completed');expect(JSON.stringify(cp.messages)).toContain('timed out');
  });
  it('repairs dangling calls by append only',async()=>{
    const h=harness(),i=input();i.messages.unshift({...i.messages[0]!,id:'old',role:'assistant',parts:[{type:'toolCall',callId:'dangling',name:'gone',arguments:'{}'}]});
    const before=structuredClone(i.messages);const cp=await createScriptedRunner(h.ports).run(i);expect(cp.messages.slice(0,2)).toEqual(before);expect(JSON.stringify(cp.messages[2])).toContain('interrupted');
  });
  it('keeps frozen setup after live tool descriptions drift',async()=>{
    const h=harness(),i=input(),tools=scriptedTools();i.chat.setup={type:'conversation.setup',system:'Frozen',tools:[{...tools[0]!.spec,description:'Frozen tool'}],skillCatalog:'Frozen skills',connectorIds:[],createdAt:time};
    const requests:ProviderRequest[]=[];const base=createScriptedProvider('tools');const provider={...base,stream:(req:ProviderRequest,s:AbortSignal)=>{requests.push(structuredClone(req));return base.stream(req,s);}};
    const cp=await new AgentRunner({ports:h.ports,tools,provider}).run(i);expect(cp.setup).toEqual(i.chat.setup);expect(requests[0]?.tools[0]?.description).toBe('Frozen tool');expect(requests[0]?.system).toContain('Frozen skills');
  });
  it('compaction transforms requests without rewriting messages',async()=>{
    const h=harness(),i=input();i.messages.unshift({...i.messages[0]!,id:'old',parts:[{type:'text',text:'history '.repeat(2000)}]});const before=structuredClone(i.messages);
    const requests:ProviderRequest[]=[];const base=createScriptedProvider();const provider={...base,stream:(r:ProviderRequest,s:AbortSignal)=>{requests.push(r);return base.stream(r,s);}};
    const cp=await new AgentRunner({ports:{...h.ports,summarize:async()=> 'Summary'},provider,contextWindow:1000}).run(i);expect(cp.messages.slice(0,2)).toEqual(before);expect(cp.compaction?.summary).toBe('Summary');expect(JSON.stringify(requests[0]?.messages)).toContain('Summary');expect(JSON.stringify(requests[0]?.messages)).not.toContain('history history');
  });
  it('falls back by capability after rejection and retries transient failures',async()=>{
    const h=harness();let n=0;const base=createScriptedProvider();const requests:ProviderRequest[]=[];
    const provider=custom(async function*(r,s){requests.push(structuredClone(r));if(n++===0)throw new ProviderFailure('Unsupported tools','tools');if(n===2)throw new ProviderFailure('Retry','retryable');yield* base.stream(r,s);});
    const cp=await new AgentRunner({ports:h.ports,provider,tools:scriptedTools()}).run(input());expect(cp.run.status).toBe('completed');expect(requests[1]?.capabilities.tools).toBe(false);expect(h.events.filter(e=>e.type==='retrying')).toHaveLength(2);
  });
  it('spills large output with a user-scoped ref',async()=>{
    const h=harness(),tools=scriptedTools();let spilled='';tools[0]!.execute=async()=>textResult('x'.repeat(200));
    const cp=await new AgentRunner({ports:{...h.ports,spill:async(user,run,id,text)=>{expect([user,run]).toEqual(['u','r']);spilled=text;return 'output-ref';}},tools,provider:createScriptedProvider('tools'),maxResultCharacters:20}).run(input());
    expect(spilled).toHaveLength(200);expect(cp.messages[2]?.parts[0]?.outputRef).toBe('output-ref');
  });
});
describe('Swift policy matrix',()=>{
  const policy={trustedSources:['mcp:x'],alwaysAllow:[]};
  const spec:ToolSpec={type:'tool.spec',name:'t',description:'Tool',inputSchema:{type:'object'},source:{type:'mcp',serverId:'x'},traits:[]};
  it.each([
    ['ask',['readOnly'],'refuse'],['plan',['readOnly'],'allow'],['plan',[],'refuse'],['build',['readOnly'],'allow'],['build',[],'ask'],['auto',[],'allow'],['auto',['destructive'],'ask'],['plan',['readOnly','destructive'],'refuse'],
  ] as const)('%s %j -> %s',(mode,traits,want)=>{expect(decideTool({...spec,traits:[...traits]},mode,policy,'key').decision).toBe(want);});
  it('does not trust remote traits by default or bypass plan refusal',()=>{expect(decideTool({...spec,traits:['readOnly']},'plan',{trustedSources:[],alwaysAllow:['key']},'key').decision).toBe('refuse');});
  it('always allow fingerprint changes with schema or description, never key order',async()=>{const a=await alwaysAllowKey(spec);expect(await alwaysAllowKey({...spec,description:'changed'})).not.toBe(a);expect(await alwaysAllowKey({...spec,inputSchema:{properties:{x:{type:'string'}},type:'object'}})).not.toBe(a);});
  it('sandboxed JS is refused in ask, skills that write use mode policy',()=>{expect(decideTool({...spec,source:{type:'javascript'},traits:['sandboxed']},'ask',policy,'key').decision).toBe('refuse');expect(decideTool({...spec,source:{type:'skill'}},'plan',policy,'key').decision).toBe('refuse');});
});
