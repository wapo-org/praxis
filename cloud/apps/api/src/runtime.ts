import {AgentRunner,CheckpointSchema,createScriptedProvider,scriptedTools,type AgentCheckpoint,type AgentPorts,type ModelProvider} from '@praxis/agent';
import type {Chat,Message,Run,StartRun} from '@praxis/protocol';
import {ApiService,type ExecutionDriver,type RunDecision} from './service.js';
export function localDriver(service:ApiService):ExecutionDriver{
 const ports:AgentPorts={
  save:async(userId,cp)=>{
   await service.put(userId,'checkpoint',cp.run.id,cp);
   const current=await service.require<Run>(userId,'run',cp.run.id);cp.run.lastEventId=Math.max(cp.run.lastEventId,current.lastEventId);await service.put(userId,'run',cp.run.id,cp.run);
   const chat=await service.require<Chat>(userId,'chat',cp.chat.id).catch(()=>null);if(chat&&!chat.setup){chat.setup=cp.setup;await service.write(userId,'chat',chat.id,chat);}
  },
  emit:async(userId,runId,event)=>service.emit(userId,runId,event),
  isCancelled:async(userId,runId)=>!!await service.adapters.kv.get(`cancel:${userId}:${runId}`),
  spill:async(userId,runId,callId,text)=>{const id=crypto.randomUUID();await service.put(userId,'output',id,{type:'tool.output',id,runId,callId,text});return id;},
  summarize:async req=>`Earlier conversation: ${req.messages.map(m=>m.parts.map(p=>p.text??p.type).join(' ')).join('\n').slice(-2000)}`,
 };
 function runner(script:StartRun['script']='text'){
  const base=createScriptedProvider(script);const provider:ModelProvider=script!=='long'?base:{...base,async *stream(request,signal){for await(const event of base.stream(request,signal)){if(event.type==='text')await new Promise(resolve=>setTimeout(resolve,12));yield event;}}};
  return new AgentRunner({ports,provider,tools:scriptedTools(),...(script==='compaction'?{contextWindow:1024}:{})});
 }
 async function advance(cp:AgentCheckpoint,script:StartRun['script']){while(cp.run.status==='continuing'){await new Promise(resolve=>setTimeout(resolve,0));cp=await runner(script).advance(cp,4);}}
 return {
  async start(userId:string,run:Run,chat:Chat,messages:Message[],request:StartRun){
   await service.put(userId,'runRequest',run.id,request);const script=request.script??'text';
   const cp=await runner(script).run({userId,run,chat:{...chat,mode:request.mode??chat.mode},messages,modelId:request.modelId??chat.modelId,effort:request.effort??chat.effort,webSearch:request.webSearch},4);await advance(cp,script);
  },
  async resume(userId:string,runId:string,decision:RunDecision){const cp=CheckpointSchema.parse(await service.require(userId,'checkpoint',runId));const request=await service.require<StartRun>(userId,'runRequest',runId);await advance(await runner(request.script).resume(cp,decision,4),request.script);},
  async cancel(userId:string,runId:string){const value=await service.adapters.store.get(userId,'checkpoint',runId);if(!value)return;const cp=CheckpointSchema.parse(value.value);if(cp.run.status==='awaitingApproval'||cp.run.status==='awaitingElicitation')await runner().cancel(cp);},
 };
}
