import { randomUUID } from 'node:crypto';
import { ChatSchema,PROTOCOL_VERSION,RunSchema,type Bootstrap,type Chat,type JsonObject,type Message,type Run,type RunEventPayload,type RunSnapshot,type StartRun } from '@praxis/protocol';
import type { AdapterBundle } from './contracts.js';
import type {ApiProviders} from './providers.js';
import {foldSnapshot,initialSnapshot} from './snapshot.js';
export class ApiError extends Error{constructor(public status:number,public code:string,message:string){super(message);}}
export type RunDecision={type:'approval.decision';approvalId:string;decision:'allowOnce'|'allowAlways'|'deny'}|{type:'elicitation.response';elicitationId:string;action:'accept'|'decline'|'cancel';content?:JsonObject};
export interface ExecutionDriver{
 validate?(userId:string,chat:Chat,input:StartRun):Promise<void>;
 /** Context notes (mode/effort, new skills) for the new user turn; see conversation.ts. */
 notes?(userId:string,chat:Chat,input:StartRun,previous:Message[]):Promise<string[]>;
 start(userId:string,run:Run,chat:Chat,messages:Message[],request:StartRun):Promise<void>;
 resume(userId:string,runId:string,decision:RunDecision):Promise<void>;
 cancel?(userId:string,runId:string):Promise<void>;
}
export class ApiService{
 driver?:ExecutionDriver;
 providers?:ApiProviders;
 private locks=new Map<string,Promise<unknown>>();
 private work=new Set<Promise<unknown>>();
 constructor(public adapters:AdapterBundle,public local:boolean){}
 now(){return new Date().toISOString();}
 async require<T>(userId:string,kind:string,id:string):Promise<T>{const r=await this.adapters.store.get(userId,kind,id);if(!r||r.deleted)throw new ApiError(404,'not_found',`${kind} not found`);return r.value as T;}
 async list<T>(userId:string,kind:string,parentId?:string):Promise<T[]>{return (await this.adapters.store.list(userId,kind,parentId===undefined?undefined:{parentId})).filter(x=>!x.deleted).map(r=>r.value as T);}
 async put(userId:string,kind:string,id:string,value:unknown){const json=JSON.parse(JSON.stringify(value)) as JsonObject;const parentId=kind!=='chat'&&typeof json.chatId==='string'?json.chatId:undefined;await this.adapters.store.put(userId,kind,id,json,parentId===undefined?undefined:{parentId});await this.adapters.kv.del(`bootstrap:${userId}`);}
 async changed(userId:string,entity:string,id:string,operation:'upsert'|'delete',value?:unknown){
  await this.adapters.events.append(userId,'user',{type:'user.change',createdAt:this.now(),entity,entityId:id,operation,...(value===undefined?{}:{value:JSON.parse(JSON.stringify(value))})});
 }
 async write(userId:string,kind:string,id:string,value:unknown,entity=kind){await this.put(userId,kind,id,value);await this.changed(userId,entity,id,'upsert',value);}
 async remove(userId:string,kind:string,id:string){await this.require(userId,kind,id);await this.adapters.store.delete(userId,kind,id);await this.adapters.kv.del(`bootstrap:${userId}`);await this.changed(userId,kind,id,'delete');}
 async exclusive<T>(key:string,fn:()=>Promise<T>):Promise<T>{const prior=this.locks.get(key)??Promise.resolve();const next=prior.catch(()=>{}).then(fn);this.locks.set(key,next);try{return await next;}finally{if(this.locks.get(key)===next)this.locks.delete(key);}}
 async seed(userId:string){
  if(!this.local)return;
  await this.exclusive(`seed:${userId}`,async()=>{
   if(await this.adapters.store.get(userId,'seed','v1'))return;
   const now=this.now();const capabilities={type:'capabilities',tools:true,parallelToolCalls:true,vision:true,documents:true,imagesInToolResults:true,reasoningEffort:true,streamUsage:true,explicitPromptCaching:false,serverWebSearch:false,midConversationSystem:false,serverCompaction:false,toolSearch:false};
   await this.put(userId,'provider','scripted',{type:'provider',id:'scripted',name:'Local scripted',flavor:'openAIChat',baseUrl:'http://localhost:8787/scripted',maskedKey:'local (no key)',capabilities,updatedAt:now});
   for(const [id,name] of [['scripted','Praxis Scripted'],['scripted-vision','Praxis Vision']])await this.put(userId,'model',`scripted:${id}`,{type:'model',id,providerId:'scripted',displayName:name,capabilities,reasoningEfforts:['low','medium','high','max'],pinned:true,favorite:false,supportsImages:true,tagline:'Deterministic local development',speed:5,intelligence:3});
   const chat=ChatSchema.parse({type:'chat',id:'welcome',title:'Welcome to Praxis Cloud',mode:'build',providerId:'scripted',modelId:'scripted',createdAt:now,updatedAt:now});await this.put(userId,'chat',chat.id,chat);
   await this.put(userId,'preferences','current',{type:'preferences',vision:{type:'vision.preferences',enabled:true,providerId:'scripted',modelId:'scripted-vision'},voice:{type:'voice.preferences',model:'whisper-large-v3-turbo',configured:true},updatedAt:now});
   await this.put(userId,'seed','v1',{version:1});
  });
 }
 async bootstrap(userId:string):Promise<Bootstrap>{
  const cached=await this.adapters.kv.get<Bootstrap>(`bootstrap:${userId}`);if(cached)return cached;
  const [chats,providers,models,connectors,skills,runs,consents,registries,preferences,changes]=await Promise.all([this.list<any>(userId,'chat'),this.list<any>(userId,'provider'),this.list<any>(userId,'model'),this.list<any>(userId,'connector'),this.list<any>(userId,'skill'),this.list<Run>(userId,'run'),this.list<any>(userId,'consent'),this.list<any>(userId,'registry'),this.adapters.store.get(userId,'preferences','current'),this.adapters.store.changes(userId,0,1)]);
  const result:Bootstrap={type:'bootstrap',protocolVersion:PROTOCOL_VERSION,user:{type:'user',id:userId,name:this.local?'Local developer':'Praxis user'},chats:chats.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,50),providers,models:models.slice(0,50),connectors,skills,activeRuns:runs.filter(r=>!this.terminal(r)),consents,registries,preferences:preferences?.value as any,syncCursor:String(changes.cursor),syncRoot:'',serverTime:this.now()};
  await this.adapters.kv.set(`bootstrap:${userId}`,result,10);return result;
 }
 terminal(run:Run){return ['completed','cancelled','failed'].includes(run.status);}
 async start(userId:string,input:StartRun):Promise<Run>{return this.exclusive(`${userId}:${input.chatId}`,async()=>{
  const chat=await this.require<Chat>(userId,'chat',input.chatId);
  const key=input.idempotencyKey??input.clientTurnId;
  if(key){const prior=await this.adapters.store.get(userId,'idempotency',`${chat.id}:${key}`);if(prior){if(prior.value.body!==JSON.stringify(input))throw new ApiError(409,'idempotency_conflict','This turn ID was used with different content');return this.require<Run>(userId,'run',String(prior.value.runId));}}
  if((await this.list<Run>(userId,'run',chat.id)).some(r=>!this.terminal(r)))throw new ApiError(409,'run_active','A run is already active in this chat');
  if(!this.driver)throw new ApiError(503,'runner_unavailable','Run executor is not configured');
  for(const id of input.attachmentIds)await this.require(userId,'attachment',id);
  await this.driver.validate?.(userId,chat,input);
  const now=this.now();const run=RunSchema.parse({type:'run',id:randomUUID(),chatId:chat.id,status:'queued',createdAt:now,updatedAt:now,lastEventId:0,clientTurnId:input.clientTurnId??key});
  await this.put(userId,'run',run.id,run);await this.put(userId,'snapshot',run.id,initialSnapshot(run));
  if(key)await this.put(userId,'idempotency',`${chat.id}:${key}`,{body:JSON.stringify(input),runId:run.id});
  const messages=(await this.list<Message>(userId,'message',chat.id)).sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.createdAt.localeCompare(b.createdAt));
  const notes=(await this.driver.notes?.(userId,chat,input,messages))??[];
  const message:Message={type:'message',id:randomUUID(),chatId:chat.id,runId:run.id,clientTurnId:run.clientTurnId,sequence:messages.length+1,role:'user',parts:[...notes.map(text=>({type:'note' as const,text})),...input.attachmentIds.map(attachmentId=>({type:'image' as const,attachmentId})),...(input.text?[{type:'text' as const,text:input.text}]:[])],createdAt:now,updatedAt:now};
  await this.emit(userId,run.id,{type:'messages.committed',messages:[message]});messages.push(message);
  chat.activeRunId=run.id;chat.updatedAt=now;await this.write(userId,'chat',chat.id,chat);
  this.enqueue(userId,run.id,()=>this.driver!.start(userId,run,chat,messages,input));return run;
 });}
 enqueue(userId:string,runId:string,task:()=>Promise<void>){
  const work=Promise.resolve().then(task).catch(async()=>{const run=await this.require<Run>(userId,'run',runId).catch(()=>null);if(run&&!this.terminal(run)){run.status='failed';run.outcome='failed';run.error='Run execution failed';await this.put(userId,'run',runId,run);await this.emit(userId,runId,{type:'run.finished',outcome:'failed',message:'Run execution failed'});}}).finally(()=>this.work.delete(work));this.work.add(work);
 }
 async drain(){await Promise.all([...this.work]);}
 async emit(userId:string,runId:string,event:RunEventPayload){
  return this.exclusive(`event:${userId}:${runId}`,async()=>{
   const run=await this.require<Run>(userId,'run',runId);run.updatedAt=this.now();
   if(event.type==='run.started')run.status='running';
   if(event.type==='approval.requested')run.status='awaitingApproval';
   if(event.type==='elicitation.requested')run.status='awaitingElicitation';
   if(event.type==='run.finished'){run.status=event.outcome==='failed'?'failed':event.outcome==='cancelled'?'cancelled':'completed';run.outcome=event.outcome;}
   if(event.type==='messages.committed'){let count=(await this.list<Message>(userId,'message',run.chatId)).length;for(const m of event.messages){const before=await this.adapters.store.get(userId,'message',m.id);m.sequence=(before?.value.sequence as number|undefined)??m.sequence??++count;m.clientTurnId??=run.clientTurnId;await this.write(userId,'message',m.id,m);}}
   const record=await this.adapters.events.append(userId,`run:${runId}`,{event,createdAt:this.now(),chatId:run.chatId});run.lastEventId=record.id;
   await this.put(userId,'run',runId,run);
   const current=await this.require<RunSnapshot>(userId,'snapshot',runId);await this.put(userId,'snapshot',runId,foldSnapshot(current,event,record.id,run));
   if(this.terminal(run)){const chat=await this.require<Chat>(userId,'chat',run.chatId).catch(()=>null);if(chat){delete chat.activeRunId;chat.updatedAt=this.now();await this.write(userId,'chat',chat.id,chat);}await this.changed(userId,'run',runId,'upsert',run);}
   return record.id;
  });
 }
 async decision(userId:string,runId:string,decision:RunDecision):Promise<Run>{return this.exclusive(`decision:${userId}:${runId}`,async()=>{
  const run=await this.require<Run>(userId,'run',runId);
  const id=decision.type==='approval.decision'?decision.approvalId:decision.elicitationId;
  const prior=await this.adapters.store.get(userId,'decision',`${runId}:${id}`);if(prior){if(JSON.stringify(prior.value)!==JSON.stringify(decision))throw new ApiError(409,'decision_conflict','Decision already resolved');return run;}
  const snapshot=await this.require<RunSnapshot>(userId,'snapshot',runId);
  const exists=decision.type==='approval.decision'?snapshot.pendingApprovals.some(x=>x.id===id):snapshot.pendingElicitations.some(x=>x.id===id);
  if(!exists||this.terminal(run))throw new ApiError(409,'decision_stale','Pending request no longer exists');
  await this.put(userId,'decision',`${runId}:${id}`,decision);run.status='running';await this.put(userId,'run',runId,run);this.enqueue(userId,runId,()=>this.driver!.resume(userId,runId,decision));return run;
 });}
 async truncate(userId:string,chatId:string,clientTurnId:string){return this.exclusive(`${userId}:${chatId}`,async()=>{
  const chat=await this.require<Chat>(userId,'chat',chatId);
  const messages=(await this.list<Message>(userId,'message',chatId)).sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.createdAt.localeCompare(b.createdAt));
  const turns=await this.list<Run>(userId,'run',chatId);const targetRuns=turns.filter(r=>r.chatId===chatId&&r.clientTurnId===clientTurnId);
  const cut=messages.findIndex(m=>m.clientTurnId===clientTurnId||(m.runId&&targetRuns.some(r=>r.id===m.runId)));
  if(cut<0)throw new ApiError(404,'turn_not_found','Turn to truncate was not found');
  const removed=messages.slice(cut);const runIds=new Set(removed.flatMap(m=>m.runId?[m.runId]:[]));for(const r of targetRuns)runIds.add(r.id);
  for(const id of runIds){const run=turns.find(r=>r.id===id);if(run&&!this.terminal(run))await this.cancel(userId,id);}
  for(const m of removed)await this.remove(userId,'message',m.id);
  for(const id of runIds){for(const kind of ['run','snapshot','checkpoint','runRequest'])await this.adapters.store.delete(userId,kind,id);await this.changed(userId,'run',id,'delete');}
  for(const r of await this.adapters.store.list(userId,'idempotency'))if(runIds.has(String(r.value.runId)))await this.adapters.store.delete(userId,'idempotency',r.id);
  for(const r of await this.adapters.store.list(userId,'output'))if(runIds.has(String(r.value.runId)))await this.adapters.store.delete(userId,'output',r.id);
  delete chat.activeRunId;chat.updatedAt=this.now();await this.write(userId,'chat',chatId,chat);
  return {type:'chat.truncated',chat,removedRunIds:[...runIds],removedMessageIds:removed.map(m=>m.id)};
 });}
 async cancel(userId:string,runId:string){const run=await this.require<Run>(userId,'run',runId);if(this.terminal(run))return run;await this.adapters.kv.set(`cancel:${userId}:${runId}`,true,86400);await this.driver?.cancel?.(userId,runId);if(!this.terminal(await this.require<Run>(userId,'run',runId))&&(run.status==='awaitingApproval'||run.status==='awaitingElicitation'||run.status==='queued'))await this.emit(userId,runId,{type:'run.finished',outcome:'cancelled'});return this.require<Run>(userId,'run',runId);}
}
