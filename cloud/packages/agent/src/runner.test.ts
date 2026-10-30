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
  it('yields for continuation when shouldYield flips after 2 steps',async()=>{
    const h=harness();let checks=0;
    const runner=new AgentRunner({ports:h.ports,provider:createScriptedProvider('tools'),tools:scriptedTools(),shouldYield:()=>++checks>=2});
    const cp=await runner.run(input());
    expect(cp.run.status).toBe('continuing');expect(cp.phase).toBe('model');expect(cp.iteration).toBe(1);
    expect(h.events.at(-1)).toEqual({type:'run.parked',reason:'continuation'});
    const done=await new AgentRunner({ports:h.ports,provider:createScriptedProvider('tools'),tools:scriptedTools()}).advance(cp);
    expect(done.run.outcome).toBe('completed');
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

describe('durability and provider fallback regressions',()=>{
  it('persists assistant messages with the phase that consumes them',async()=>{
    const h=harness(),snapshots:AgentCheckpoint[]=[];
    const cp=await new AgentRunner({provider:createScriptedProvider('tools'),tools:scriptedTools(),ports:{...h.ports,save:async(user,cp)=>{await h.ports.save(user,cp);snapshots.push(cp);}}}).run(input());
    expect(cp.run.outcome).toBe('completed');
    for(const saved of snapshots){const last=saved.messages.at(-1);if(last?.role==='assistant'&&last.parts.some(p=>p.type==='toolCall'))expect(saved.phase).toBe('tools');if(last?.role==='assistant'&&last.parts.some(p=>p.type==='text'))expect(saved.run.status).toBe('completed');}
  });
  it('does not repeat a completed nested side effect after parking',async()=>{
    const h=harness(),tools=scriptedTools();let count=0;tools[0]!.execute=async()=>{count++;return textResult('first nested');};
    tools[2]!.execute=async(_,ctx)=>{await ctx.callTool('local_echo',{});return ctx.callTool('local_write',{});};
    const options={ports:h.ports,provider:createScriptedProvider('nestedApproval'),tools};
    const cp=await new AgentRunner(options).run(input());expect(count).toBe(1);const done=await new AgentRunner(options).resume(cp,{type:'approval.decision',approvalId:cp.approval!.id,decision:'allowOnce'});
    expect(count).toBe(1);expect(done.run.status).toBe('completed');
  });
  it('validates tool JSON Schema before approval or execution',async()=>{
    const h=harness(),tools=scriptedTools();let executed=false;tools[0]!.spec.inputSchema={type:'object',properties:{required:{type:'string'}},required:['required'],additionalProperties:false};tools[0]!.execute=async()=>{executed=true;return textResult('bad');};
    const cp=await new AgentRunner({ports:h.ports,provider:createScriptedProvider('tools'),tools}).run(input());expect(executed).toBe(false);expect(JSON.stringify(cp.messages)).toContain('frozen input schema');expect(cp.run.status).toBe('completed');
  });
  it('validates accepted elicitation content before consuming pending input',async()=>{
    const h=harness(),runner=createScriptedRunner(h.ports,'elicitation'),cp=await runner.run(input());
    await expect(runner.resume(cp,{type:'elicitation.response',elicitationId:cp.elicitation!.id,action:'accept',content:{name:123}})).rejects.toThrow();expect(cp.elicitation).toBeDefined();
  });
  it('uses a real provider to summarize when no summarize port was injected',async()=>{
    const h=harness(),base=createScriptedProvider(),i=input();i.maxTokens=100;i.messages.unshift({...i.messages[0]!,id:'history',parts:[{type:'text',text:'Past context '.repeat(300)}]});let summaries=0;
    const provider=custom(async function*(r,s){if(r.system.startsWith('Summarize')){summaries++;yield {type:'completed',response:{parts:[{type:'text',text:'Provider summary'}],stop:'endTurn',usage:{type:'usage',inputTokens:10,outputTokens:4,cacheReadTokens:0,cacheWriteTokens:0}}};}else yield* base.stream(r,s);});
    const cp=await new AgentRunner({ports:h.ports,provider,contextWindow:1000}).run(i);expect(summaries).toBeGreaterThan(0);expect(cp.compaction?.summary).toBe('Provider summary');expect(cp.messages[0]).toEqual(i.messages[0]);
  });
  it('learns effort options from a rejection then retries with a supported effort',async()=>{
    const h=harness(),i=input();i.effort='max';const requests:ProviderRequest[]=[];const base=createScriptedProvider();
    const provider=custom(async function*(r,s){requests.push(structuredClone(r));if(requests.length===1)throw new ProviderFailure("Unsupported reasoning_effort 'max'. Supported: low, medium, high.",'effort');yield* base.stream(r,s);});
    const cp=await new AgentRunner({ports:h.ports,provider}).run(i);expect(cp.run.status).toBe('completed');expect(requests[1]?.effort).toBe('high');expect(cp.supportedEfforts).toEqual(['low','medium','high']);
  });
  it('discards truncated calls, retries within the model maximum, and never executes partial arguments',async()=>{
    const h=harness(),tools=scriptedTools(),requests:ProviderRequest[]=[];let ran=0;tools[0]!.execute=async()=>{ran++;return textResult('ran');};const base=createScriptedProvider('tools');
    const provider=custom(async function*(r,s){requests.push(structuredClone(r));if(requests.length===1){yield {type:'text',index:0,text:'partial'};yield {type:'tool',index:1,id:'cut',name:'local_echo'};yield {type:'completed',response:{parts:[{type:'toolCall',callId:'cut',name:'local_echo',arguments:'{"x":'}],stop:'maxTokens',usage:{type:'usage',inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}};}else yield* base.stream(r,s);});
    const i=input();i.maxTokens=1000;i.modelMaxTokens=1500;const cp=await new AgentRunner({ports:h.ports,provider,tools}).run(i);expect(cp.run.status).toBe('completed');expect(requests[1]?.maxTokens).toBe(1500);expect(ran).toBe(1);expect(JSON.stringify(cp.messages)).not.toContain('"callId":"cut"');expect(h.events.some(e=>e.type==='attempt.discarded'&&e.toolCallIds.includes('cut'))).toBe(true);
  });
  it('strips partial tool calls without retry once already at model max',async()=>{
    const h=harness();const i=input();i.maxTokens=100;i.modelMaxTokens=100;let count=0;const provider=custom(async function*(){count++;yield {type:'completed',response:{parts:[{type:'text',text:'Partial text'},{type:'toolCall',callId:'cut',name:'local_echo',arguments:'{"x":'}],stop:'maxTokens',usage:{type:'usage',inputTokens:1,outputTokens:1,cacheReadTokens:0,cacheWriteTokens:0}}};});
    const cp=await new AgentRunner({ports:h.ports,provider,tools:scriptedTools()}).run(i);expect(count).toBe(1);expect(cp.run.outcome).toBe('truncated');expect(cp.messages.at(-1)?.parts).toEqual([{type:'text',text:'Partial text'}]);
  });
  it('emits matching reasoning finished events and carries client turn ids',async()=>{
    const h=harness(),i=input();i.run.clientTurnId='client-turn';const cp=await createScriptedRunner(h.ports).run(i);const started=h.events.find(e=>e.type==='reasoning.delta');expect(started).toBeDefined();expect(h.events).toContainEqual({type:'reasoning.finished',blockId:started&&'blockId' in started?started.blockId:''});expect(cp.messages.at(-1)?.clientTurnId).toBe('client-turn');
  });
});
