import {cancellationKey} from './run-keys.js';
import {ensureBuiltins} from './features/mcp/builtins.js';
import { randomUUID } from 'node:crypto';
import { APPROVAL_RECORD_KIND,ChatSchema,RunErrorCodeSchema,ModelKeySchema,ModelPreferenceRecordSchema,PROTOCOL_VERSION,RunSchema,type ApprovalDecision,type Bootstrap,type Chat,type JsonObject,type Message,type Run,type RunEventPayload,type RunSnapshot,type StartRun } from '@praxis/protocol';
import type { AdapterBundle } from './contracts.js';
import type {OpenRouterModels} from './openrouter/index.js';
import {foldSnapshot,initialSnapshot} from './snapshot.js';
import {attachmentParts,makeTitle,wantsTitle,type AttachmentRow} from './attachments.js';
import type {SearchIndexer} from './search-index.js';
import {validateTitle} from './title-model.js';
import {currentRunTiming,registerRunTiming,RunTimingTracker,timedStep,withRunTiming} from './timing.js';
import {decideApproval} from './approvals.js';
const attachmentRow=(id:string,v:JsonObject):AttachmentRow=>({id,name:String(v.name??'file'),mediaType:String(v.mediaType??'application/octet-stream'),size:Number(v.size??0),hiddenFromCode:v.hiddenFromCode===true});
export class ApiError extends Error{constructor(public status:number,public code:string,message:string){super(message);}}
export type RunDecision=ApprovalDecision|{type:'elicitation.response';elicitationId:string;action:'accept'|'decline'|'cancel';content?:JsonObject};
export interface ExecutionDriver{
 title?(userId:string,chat:Chat,text:string):Promise<string|undefined>;
 validate?(userId:string,chat:Chat,input:StartRun):Promise<void>;
 /** Generates extra context notes for the next user turn. */
 notes?(userId:string,chat:Chat,input:StartRun,previous:Message[]):Promise<string[]>;
 start(userId:string,run:Run,chat:Chat,messages:Message[],request:StartRun):Promise<void>;
 resume(userId:string,runId:string,decision:RunDecision):Promise<void>;
 scheduleApprovalResume?(userId: string, runId: string): Promise<void>;
 cancel?(userId:string,runId:string):Promise<void>;
}
export class ApiService{
 driver?:ExecutionDriver;
 /** OpenRouter with each user's own key (set by createApp). */
 models?:OpenRouterModels;
 /** Keeps background work alive past HTTP response (Vercel waitUntil). */
 defer?:(work:Promise<unknown>)=>void;
 private locks=new Map<string,Promise<unknown>>();
 private work=new Set<Promise<unknown>>();
 constructor(public adapters:AdapterBundle,public local:boolean){}
 now(){return new Date().toISOString();}
 async require<T>(userId:string,kind:string,id:string):Promise<T>{const r=await this.adapters.store.get(userId,kind,id);if(!r||r.deleted)throw new ApiError(404,'not_found',`${kind} not found`);return r.value as T;}
 async list<T>(userId:string,kind:string,parentId?:string):Promise<T[]>{return (await this.adapters.store.list(userId,kind,parentId===undefined?undefined:{parentId})).filter(x=>!x.deleted).map(r=>r.value as T);}
 async put(userId:string,kind:string,id:string,value:unknown){const json=JSON.parse(JSON.stringify(value)) as JsonObject;const parentId=kind!=='chat'&&typeof json.chatId==='string'?json.chatId:undefined;await Promise.all([this.adapters.store.put(userId,kind,id,json,parentId===undefined?undefined:{parentId}),this.adapters.kv.del(`bootstrap:${userId}`)]);this.indexed(userId,kind,id,parentId);}
 /** Semantic search index (search-index.ts); absent = lexical search only. */
 search?:SearchIndexer;
 /** A chat or message changed: its chat is reindexed once the writes settle. */
 private indexed(userId:string,kind:string,id:string,parentId?:string){if(!this.search)return;if(kind==='chat')this.search.touch(userId,id);else if(kind==='message'&&parentId)this.search.touch(userId,parentId);}
 async changed(userId:string,entity:string,id:string,operation:'upsert'|'delete',value?:unknown){
  await this.adapters.events.append(userId,'user',{type:'user.change',createdAt:this.now(),entity,entityId:id,operation,...(value===undefined?{}:{value:JSON.parse(JSON.stringify(value))})});
 }
 async write(userId:string,kind:string,id:string,value:unknown,entity=kind){await this.put(userId,kind,id,value);await this.changed(userId,entity,id,'upsert',value);}
 async remove(userId:string,kind:string,id:string){const prior=await this.require<{chatId?:unknown}>(userId,kind,id);await Promise.all([this.adapters.store.delete(userId,kind,id),this.adapters.kv.del(`bootstrap:${userId}`)]);await this.changed(userId,kind,id,'delete');this.indexed(userId,kind,id,typeof prior.chatId==='string'?prior.chatId:undefined);}
 async exclusive<T>(key:string,fn:()=>Promise<T>):Promise<T>{const prior=this.locks.get(key)??Promise.resolve();const next=prior.catch(()=>{}).then(fn);this.locks.set(key,next);try{return await next;}finally{if(this.locks.get(key)===next)this.locks.delete(key);}}
 async seed(userId:string){
  await ensureBuiltins(this.adapters.store,userId);
  if(!this.local)return;
  await this.exclusive(`seed:${userId}`,async()=>{
   if(await this.adapters.store.get(userId,'seed','v1'))return;
   const now=this.now();
   const chat=ChatSchema.parse({type:'chat',id:'welcome',title:'Welcome to Praxis Cloud',mode:'build',modelId:'scripted',createdAt:now,updatedAt:now});await this.put(userId,'chat',chat.id,chat);
   await this.put(userId,'preferences','current',{type:'preferences',vision:{type:'vision.preferences',enabled:true,modelId:'scripted-vision'},voice:{type:'voice.preferences',model:'whisper-large-v3-turbo',configured:true},updatedAt:now});
   await this.put(userId,'seed','v1',{version:1});
  });
 }
 async bootstrap(userId:string):Promise<Bootstrap>{
  const cached=await this.adapters.kv.get<Bootstrap>(`bootstrap:${userId}`);if(cached)return cached;
  const [chats,modelKey,modelPreferences,connectors,skills,runs,consents,registries,preferences,changes]=await Promise.all([this.list<any>(userId,'chat'),this.adapters.store.get(userId,'modelKey','current'),this.list<unknown>(userId,'modelPreference'),this.list<any>(userId,'connector'),this.list<any>(userId,'skill'),this.list<Run>(userId,'run'),this.list<any>(userId,'consent'),this.list<any>(userId,'registry'),this.adapters.store.get(userId,'preferences','current'),this.adapters.store.head(userId)]);
  const eventCursor=await this.adapters.events.latest?.(userId,'user');
  const result:Bootstrap={type:'bootstrap',protocolVersion:PROTOCOL_VERSION,user:{type:'user',id:userId,name:this.local?'Local developer':'Praxis user'},chats:chats.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,50),
   // Parsing drops the sealed key: only the masked record ever leaves the server.
   ...(modelKey&&!modelKey.deleted?{modelKey:ModelKeySchema.parse(modelKey.value)}:{}),modelPreferences:modelPreferences.flatMap(p=>{const r=ModelPreferenceRecordSchema.safeParse(p);return r.success?[r.data]:[];}),connectors,skills,activeRuns:runs.filter(r=>!this.terminal(r)),consents,registries,preferences:preferences?.value as any,syncCursor:String(changes),syncRoot:'',serverTime:this.now(),...(eventCursor===undefined?{}:{eventCursor})};
  await this.adapters.kv.set(`bootstrap:${userId}`,result,10,userId);return result;
 }
 terminal(run:Run){return ['completed','cancelled','failed'].includes(run.status);}
 trackWork(work:Promise<unknown>){
  const tracked=Promise.resolve(work).catch(()=>{}).finally(()=>this.work.delete(tracked));
  this.work.add(tracked);this.defer?.(tracked);
 }
 async start(userId:string,input:StartRun):Promise<Run>{const tracker=new RunTimingTracker('pending',input.chatId,work=>this.trackWork(work));return this.exclusive(`${userId}:${input.chatId}`,()=>withRunTiming(tracker,async()=>{
  const pre=await timedStep('prechecks',async()=>{
   const key=input.idempotencyKey??input.clientTurnId;
   const [chat,prior,runs,...attachmentObjs]=await Promise.all([
    this.require<Chat>(userId,'chat',input.chatId).catch(()=>{throw new ApiError(404,'chat_missing','This chat was removed or the server restarted. Refresh and start a new chat.');}),
    key?this.adapters.store.get(userId,'idempotency',`${input.chatId}:${key}`):Promise.resolve(null),
    this.list<Run>(userId,'run',input.chatId),
    ...input.attachmentIds.map(id=>this.require<JsonObject>(userId,'attachment',id).then(v=>attachmentRow(id,v))),
   ]);
   if(prior){if(prior.value.body!==JSON.stringify(input))throw new ApiError(409,'idempotency_conflict','This turn ID was used with different content');return {chat,key,attachments:[] as AttachmentRow[],existingRun:await this.require<Run>(userId,'run',String(prior.value.runId))};}
   if(runs.some(r=>!this.terminal(r)))throw new ApiError(409,'run_active','A run is already active in this chat');
   if(!this.driver)throw new ApiError(503,'runner_unavailable','Run executor is not configured');
   return {chat,key,attachments:attachmentObjs,existingRun:undefined as Run|undefined};
  });
  if(pre.existingRun)return pre.existingRun;
  const {chat,key,attachments}=pre;
  let [,messages]=await Promise.all([
   timedStep('validate',()=>this.driver!.validate?.(userId,chat,input)??Promise.resolve()),
   timedStep('history',async()=>(await this.list<Message>(userId,'message',chat.id)).sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.createdAt.localeCompare(b.createdAt))),
  ]);
  let regenerationUserAt=-1;
  if(input.regenerateMessageId){
   const at=messages.findIndex(m=>m.id===input.regenerateMessageId&&m.role==='assistant');
   regenerationUserAt=at-1;
   while(regenerationUserAt>=0&&(messages[regenerationUserAt]!.role!=='user'||messages[regenerationUserAt]!.parts.every(p=>p.type==='toolResult')))regenerationUserAt--;
   if(at<0||regenerationUserAt<0)throw new ApiError(404,'message_missing','Reply to regenerate not found');
  }
  const now=this.now();const run=RunSchema.parse({type:'run',id:randomUUID(),chatId:chat.id,status:'queued',createdAt:now,updatedAt:now,lastEventId:0,clientTurnId:input.clientTurnId??key});
  if(input.regenerateMessageId) run.promptStartedAt=now;
  tracker.runId=run.id;registerRunTiming(tracker);
  const persistRun=()=>timedStep('persistRun',()=>Promise.all([
   this.put(userId,'run',run.id,run),
   this.put(userId,'snapshot',run.id,initialSnapshot(run)),
   ...(key?[this.put(userId,'idempotency',`${chat.id}:${key}`,{body:JSON.stringify(input),runId:run.id})]:[]),
  ]));
  let title:string|undefined;
  let titleText=input.text;
  if(input.regenerateMessageId){
   await persistRun();
   const userAt=regenerationUserAt;
   // Discard the previous attempt and later branch. The original user turn is retained once.
   const removed=messages.slice(userAt+1);
   const oldRunIds=new Set(removed.flatMap(m=>m.runId?[m.runId]:[]));
   await Promise.all([
    ...removed.map(m=>this.remove(userId,'message',m.id)),
    ...[...oldRunIds].flatMap(id=>[this.adapters.store.delete(userId,'snapshot',id),this.changed(userId,'run',id,'delete')]),
   ]);
   messages=messages.slice(0,userAt+1);
   run.clientTurnId=messages[userAt]!.clientTurnId;
   await Promise.all([this.put(userId,'run',run.id,run),this.put(userId,'snapshot',run.id,initialSnapshot(run))]);
   input={...input,text:messages[userAt]!.parts.filter(p=>p.type==='text').map(p=>p.text??'').join(' ')};
   titleText=input.text;
   title=await timedStep('titleFor',()=>this.titleFor(userId,chat,titleText,attachments,messages.slice(0,-1)));
  }else{
   const previousMessages=messages;
   const [,notes,resolvedTitle]=await Promise.all([
    persistRun(),
    timedStep('notes',()=>this.driver!.notes?.(userId,chat,input,previousMessages)??Promise.resolve([])),
    timedStep('titleFor',()=>this.titleFor(userId,chat,input.text,attachments,previousMessages)),
   ]);
   title=resolvedTitle;
   const message:Message={type:'message',id:randomUUID(),chatId:chat.id,runId:run.id,clientTurnId:run.clientTurnId,role:'user',parts:[...(notes??[]).map(text=>({type:'note' as const,text})),...attachmentParts(attachments,input.text)],createdAt:now,updatedAt:now};
   messages=[...previousMessages,message];
   const rawSuggested=input.suggestedTitle?.trim();
   const suggested=rawSuggested?validateTitle(rawSuggested,input.text)??undefined:undefined;
   const [,updated]=await Promise.all([
    timedStep('commitUser',()=>this.emit(userId,run.id,{type:'messages.committed',messages:[message]})),
    timedStep('chatUpdate',()=>this.updateChat(userId,chat.id,live=>({...live,...(title&&live.title===chat.title&&live.titleRevision===chat.titleRevision?{title:suggested||title}:{}),activeRunId:run.id,updatedAt:now}))),
   ]);
   const runChat=updated??chat;
   this.enqueue(userId,run.id,()=>withRunTiming(tracker,async()=>{tracker.mark('queueWaitMs');return this.driver!.start(userId,run,runChat,messages,input);}));
   if(title&&!suggested&&runChat.title===title&&this.driver?.title){
    const expected=runChat.title,revision=runChat.titleRevision;
    const work=Promise.resolve().then(()=>withRunTiming(tracker,async()=>{
     const generated=await timedStep('titleGeneration',()=>this.driver!.title!(userId,runChat,input.text));if(!generated)return;
     await this.updateChat(userId,chat.id,live=>live.title===expected&&live.titleRevision===revision?{...live,title:generated,updatedAt:this.now()}:undefined);
    })).catch(()=>this.put(userId,'titleMetric',chat.id,{reason:'provider_error: unknown'})).catch(()=>{}).finally(()=>this.work.delete(work));
    this.work.add(work);this.defer?.(work);
   }
   tracker.mark('postResponseMs');
   return run;
  }
  const rawSuggested=input.suggestedTitle?.trim();
  const suggested=rawSuggested?validateTitle(rawSuggested,titleText)??undefined:undefined;
  const updated=await timedStep('chatUpdate',()=>this.updateChat(userId,chat.id,live=>({...live,...(title&&live.title===chat.title&&live.titleRevision===chat.titleRevision?{title:suggested||title}:{}),activeRunId:run.id,updatedAt:now})));
  const runChat=updated??chat;
  this.enqueue(userId,run.id,()=>withRunTiming(tracker,async()=>{tracker.mark('queueWaitMs');return this.driver!.start(userId,run,runChat,messages,input);}));
  if(title&&!suggested&&runChat.title===title&&this.driver?.title){
   const expected=runChat.title,revision=runChat.titleRevision;
   const work=Promise.resolve().then(()=>withRunTiming(tracker,async()=>{
    const generated=await timedStep('titleGeneration',()=>this.driver!.title!(userId,runChat,titleText));if(!generated)return;
    await this.updateChat(userId,chat.id,live=>live.title===expected&&live.titleRevision===revision?{...live,title:generated,updatedAt:this.now()}:undefined);
   })).catch(()=>this.put(userId,'titleMetric',chat.id,{reason:'provider_error: unknown'})).catch(()=>{}).finally(()=>this.work.delete(work));
   this.work.add(work);this.defer?.(work);
  }
  tracker.mark('postResponseMs');
  return run;
 }));}
 /** CAS preserves renames and unrelated chat updates across background invocations. */
 async updateChat(userId:string,id:string,update:(chat:Chat)=>Chat|undefined):Promise<Chat|undefined>{
  for(let attempt=0;attempt<20;attempt++){
   const row=await this.adapters.store.get(userId,'chat',id);if(!row||row.deleted)return;
   const next=update(ChatSchema.parse(row.value));if(!next)return;
   const saved=await this.adapters.store.putIfRevision(userId,'chat',id,JSON.parse(JSON.stringify(next)),row.revision);
   if(saved){await this.adapters.kv.del(`bootstrap:${userId}`);this.indexed(userId,'chat',id);await this.changed(userId,'chat',id,'upsert',next);return next;}
  }
  throw new ApiError(409,'chat_conflict','Chat changed; try again');
 }
 /** Port of the app's ConversationTitle: the first message names the chat (or its attachments do, until words arrive). */
 private async titleFor(userId:string,chat:Chat,text:string,attachments:AttachmentRow[],previous:Message[]){
  if(chat.titleRevision)return undefined;
  const first=previous.find(m=>m.role==='user');let firstTurn:{text:string;attachments:AttachmentRow[]}|undefined;
  if(first){const ids=first.parts.flatMap(p=>p.attachmentId?[p.attachmentId]:[]);const recs=await Promise.all(ids.map(id=>this.adapters.store.get(userId,'attachment',id)));const rows:AttachmentRow[]=recs.flatMap((r,i)=>r&&!r.deleted?[attachmentRow(ids[i]!,r.value)]:[]);firstTurn={text:first.parts.filter(p=>p.type==='text').map(p=>p.text??'').join(' ').replace(/\[Attached file[\s\S]*$/,'').trim(),attachments:rows};}
  if(!wantsTitle(chat.title,text,firstTurn))return undefined;return makeTitle(text,attachments);
 }
 enqueue(userId:string,runId:string,task:()=>Promise<void>){
  const work=Promise.resolve().then(task).catch(async(error:unknown)=>{const run=await this.require<Run>(userId,'run',runId).catch(()=>null);if(run&&!this.terminal(run)){
   // A key that disappeared between slices is something the user can fix, so it keeps its typed code.
   const code=error instanceof ApiError?RunErrorCodeSchema.safeParse(error.code).data:undefined,message=code?(error as ApiError).message:'Run execution failed';
   run.status='failed';run.outcome='failed';run.error=message;if(code)run.errorCode=code;await this.put(userId,'run',runId,run);await this.emit(userId,runId,{type:'run.finished',outcome:'failed',message,...(code?{code}:{})});}}).catch(error=>{this.onBackgroundError(runId,error);}).finally(()=>this.work.delete(work));this.work.add(work);this.defer?.(work);
 }
 /** Never leave background rejections unhandled; log failures without payloads. */
 onBackgroundError=(runId:string,error:unknown)=>{console.error(JSON.stringify({type:'background_error',runId,error:error instanceof Error?error.name+': '+error.message.slice(0,300):'unknown'}));};
 async drain(){await Promise.all(this.work);}
 async emit(userId:string,runId:string,event:RunEventPayload){
  return this.exclusive(`event:${userId}:${runId}`,async()=>{
   if(event.type==='run.started')currentRunTiming()?.mark('runStartedMs');
   const [run,current]=await Promise.all([
    this.require<Run>(userId,'run',runId),
    this.require<RunSnapshot>(userId,'snapshot',runId),
   ]);
   run.updatedAt=this.now();
   if(event.type==='run.started')run.status='running';
   if(event.type==='approval.requested')run.status='awaitingApproval';
   if(event.type==='elicitation.requested')run.status='awaitingElicitation';
   if(event.type==='run.finished'){run.status=event.outcome==='failed'?'failed':event.outcome==='cancelled'?'cancelled':'completed';run.outcome=event.outcome;}
   if (event.type === 'messages.committed') {
    await this.commitMessages(userId, run, event.messages);
   }
   const eventKey = event.type === 'messages.committed' ? `messages:${JSON.stringify(event.messages.map(m => m.id))}`
    : event.type === 'approval.requested' ? `approval.requested:${event.approval.id}`
    : event.type === 'approval.resolved' ? `approval.resolved:${event.approvalId}` : undefined;
   const record=await this.adapters.events.append(userId,`run:${runId}`,{event,createdAt:this.now(),chatId:run.chatId},eventKey);run.lastEventId=Math.max(run.lastEventId,record.id);
   await Promise.all([
    this.put(userId,'run',runId,run),
    this.put(userId,'snapshot',runId,foldSnapshot(current,event,record.id,run)),
   ]);
   if(this.terminal(run)){await this.updateChat(userId,run.chatId,chat=>{if(chat.activeRunId===run.id)delete chat.activeRunId;chat.updatedAt=this.now();return chat;});await this.changed(userId,'run',runId,'upsert',run);}
   return record.id;
  });
 }
 private async commitMessages(userId: string, run: Run, messages: Message[]) {
  if (!messages.length) return;
  for (const message of messages) {
   message.clientTurnId ??= run.clientTurnId;
   message.promptStartedAt ??= run.promptStartedAt;
  }
  const store = this.adapters.store;
  if (store.commitMessages) {
   const committed = await store.commitMessages(userId, run.chatId, messages);
   await this.adapters.kv.del(`bootstrap:${userId}`);
   this.indexed(userId, 'message', '', run.chatId);
   for (const [index, message] of committed.entries()) {
    Object.assign(messages[index]!, message);
    await this.changed(userId, 'message', message.id, 'upsert', message);
   }
   return;
  }
  const [existing, prior] = await Promise.all([
   this.list<Message>(userId, 'message', run.chatId),
   Promise.all(messages.map(message => store.get(userId, 'message', message.id))),
  ]);
  let sequence = existing.reduce((last, message) => Math.max(last, message.sequence ?? 0), 0);
  for (const [index, message] of messages.entries()) {
   const before = prior[index]?.value.sequence;
   message.sequence = typeof before === 'number' ? before : ++sequence;
   await this.write(userId, 'message', message.id, message);
  }
 }
 async decision(userId: string, runId: string, decision: RunDecision): Promise<Run> {
  return this.exclusive(`decision:${userId}:${runId}`, async () => {
   const run = await this.require<Run>(userId, 'run', runId);
   if (decision.type === 'approval.decision') {
    const driver = this.driver;
    if (!driver?.scheduleApprovalResume) throw new ApiError(503, 'approval_unavailable', 'Approval continuation unavailable');
    const snapshot = await this.require<RunSnapshot>(userId, 'snapshot', runId);
    const pending = !this.terminal(run) && snapshot.pendingApprovals.some(approval => approval.id === decision.approvalId);
    await decideApproval(this.adapters.store, userId, runId, decision, pending);
    if (pending) await driver.scheduleApprovalResume(userId, runId);
    return run;
   }
   const id = decision.elicitationId;
   const prior = await this.adapters.store.get(userId, 'decision', `${runId}:${id}`);
   if (prior) {
    if (JSON.stringify(prior.value) !== JSON.stringify(decision)) throw new ApiError(409, 'decision_conflict', 'Decision already resolved');
    return run;
   }
   const snapshot = await this.require<RunSnapshot>(userId, 'snapshot', runId);
   if (this.terminal(run) || !snapshot.pendingElicitations.some(elicitation => elicitation.id === id)) {
    throw new ApiError(409, 'decision_stale', 'Pending request no longer exists');
   }
   await this.put(userId, 'decision', `${runId}:${id}`, decision);
   run.status = 'running';
   await this.put(userId, 'run', runId, run);
   await this.emit(userId, runId, {type:'elicitation.resolved', elicitationId:id, action:decision.action});
   this.enqueue(userId, runId, () => this.driver!.resume(userId, runId, decision));
   return run;
  });
 }
 async truncate(userId:string,chatId:string,clientTurnId:string){return this.exclusive(`${userId}:${chatId}`,async()=>{
  const chat=await this.require<Chat>(userId,'chat',chatId);
  const messages=(await this.list<Message>(userId,'message',chatId)).sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.createdAt.localeCompare(b.createdAt));
  const turns=await this.list<Run>(userId,'run',chatId);const targetRuns=turns.filter(r=>r.chatId===chatId&&r.clientTurnId===clientTurnId);
  const cut=messages.findIndex(m=>m.clientTurnId===clientTurnId||(m.runId&&targetRuns.some(r=>r.id===m.runId)));
  if(cut<0)throw new ApiError(404,'turn_not_found','Turn to truncate was not found');
  const removed=messages.slice(cut);const runIds=new Set(removed.flatMap(m=>m.runId?[m.runId]:[]));for(const r of targetRuns)runIds.add(r.id);
  for(const id of runIds){const run=turns.find(r=>r.id===id);if(run&&!this.terminal(run))await this.cancel(userId,id);}
  for(const m of removed)await this.remove(userId,'message',m.id);
  for (const id of runIds) {
   const approvals = await this.adapters.store.list(userId, APPROVAL_RECORD_KIND, {parentId: id});
   for (const approval of approvals) await this.adapters.store.delete(userId, APPROVAL_RECORD_KIND, approval.id);
   for (const kind of ['run', 'snapshot', 'checkpoint', 'runRequest']) await this.adapters.store.delete(userId, kind, id);
   await this.changed(userId, 'run', id, 'delete');
  }
  for(const r of await this.adapters.store.list(userId,'idempotency'))if(runIds.has(String(r.value.runId)))await this.adapters.store.delete(userId,'idempotency',r.id);
  for(const r of await this.adapters.store.list(userId,'output'))if(runIds.has(String(r.value.runId)))await this.adapters.store.delete(userId,'output',r.id);
  delete chat.activeRunId;chat.updatedAt=this.now();await this.write(userId,'chat',chatId,chat);
  return {type:'chat.truncated',chat,removedRunIds:[...runIds],removedMessageIds:removed.map(m=>m.id)};
 });}
 async cancel(userId: string, runId: string) {
  const run = await this.require<Run>(userId, 'run', runId);
  if (this.terminal(run)) return run;
  await this.adapters.kv.set(cancellationKey(userId, runId), true, 86400, userId);
  await this.driver?.cancel?.(userId, runId);
  const current = await this.require<Run>(userId, 'run', runId);
  if (!this.terminal(current) &&
      (run.status === 'awaitingApproval' || run.status === 'awaitingElicitation' || run.status === 'queued')) {
   await this.emit(userId, runId, {type: 'run.finished', outcome: 'cancelled'});
  }
  return this.require<Run>(userId, 'run', runId);
 }
}
