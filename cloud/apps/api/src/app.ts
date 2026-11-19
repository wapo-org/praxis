import {JsonValueSchema} from '@praxis/protocol';
import {protectAnswer,secretMetadata,savedValues,querySavedValues,saveVariable,saveSecret} from './saved-secrets.js';
import { searchChats } from './search.js';
import {registerAccountDeletion} from './account-routes.js';
import {platformVoice} from './features/tools/transcribe.js';
import {ACCOUNT_DELETE_PATH, AccountDeleteSchema} from '@praxis/protocol';
import {randomUUID} from 'node:crypto';
import {Hono,type Context} from 'hono';
import {cors} from 'hono/cors';
import {streamSSE} from 'hono/streaming';
import {getCookie,setCookie,deleteCookie} from 'hono/cookie';
import {z} from 'zod';
import {
 ApprovalDecisionSchema,ChatTruncateSchema,ChatInputSchema,ChatPatchSchema,ChatSchema,ConsentSchema,ElicitationResponseSchema,PageQuerySchema,PreferencesInputSchema,PreferencesSchema,RunEventSchema,RunSnapshotSchema,StartRunSchema,
 type Chat,type JsonObject,type Message,type Run,type User,
} from '@praxis/protocol';
import {ApiError,ApiService} from './service.js';
import {seal} from './secrets.js';
import {OpenRouterModels} from './openrouter/index.js';
import {registerModelRoutes} from './openrouter/routes.js';
import {body,page} from './route-helpers.js';
import type {FeatureContext} from './contracts.js';
import {featureContext} from './features.js';
import {registerSyncRoutes} from './sync-routes.js';
type Env={Variables:{userId:string;requestId:string}};
export interface AppOptions {
 /** dev:local only: a fresh dev sign-in recreates an erased user as a clean account. */
 reopenDevUser?:(userId:string)=>Promise<void>;
 accountDeletion?:{confirm?(request:Request,password?:string):Promise<{userId:string;sessionId:string}|null>;purge(userId:string,sessionId:string):Promise<void>};
 service:ApiService;encryptionKey?:string;
 /** Outbound fetch for OpenRouter (the guarded fetch in production). */
 fetcher?:typeof fetch;
 /** Test hook for the catalogue's one-hour cache. */
 clock?:()=>number;
 resolveSession?:(request:Request)=>Promise<{user:User;expiresAt:string}|null>;
 allowedOrigins?:string[];
 log?:(record:{requestId:string;method:string;path:string;status:number;durationMs:number})=>void;
 /** Per-key limiter using user:<id> after auth and ip:<addr> before it. */
 rateLimit?:(key:string)=>Promise<{ok:boolean;retryAfterSeconds?:number}>;
 /** Mount feature routers under /v1 after auth with owner-scoped context. */
 mount?:(app:Hono<Env>,contextFor:(request:Request)=>Promise<FeatureContext>)=>void;
 /** /v1 paths (exact or trailing-'/' prefix) exempt from session auth. */
 publicPaths?:string[];
}
export function createApp(options:AppOptions){
 const {service}=options;const app=new Hono<Env>();
 const models=service.models=new OpenRouterModels(service,options.encryptionKey,options.fetcher,options.clock);
 if(service.local&&(process.env.NODE_ENV==='production'||process.env.VERCEL))throw new Error('Local adapters and auth are forbidden in production');
 const allowed=options.allowedOrigins??[];const originOk=(origin:string)=>allowed.includes(origin)||(service.local&&/^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(origin));
 if(service.local)app.use('/v1/uploads/content/*',cors({origin:origin=>originOk(origin)?origin:'',credentials:true,allowHeaders:['Content-Type','Authorization'],allowMethods:['PUT','POST','OPTIONS']}));
 app.use('*',cors({origin:origin=>originOk(origin)?origin:'',credentials:true,allowHeaders:['Content-Type','Authorization','Last-Event-ID','Idempotency-Key'],allowMethods:['GET','POST','PATCH','DELETE','OPTIONS'],exposeHeaders:['X-Request-ID']}));
 app.use('*',async(c,next)=>{const started=Date.now();c.set('requestId',randomUUID());c.header('X-Request-ID',c.get('requestId'));c.header('X-Content-Type-Options','nosniff');await next();options.log?.({requestId:c.get('requestId'),method:c.req.method,path:new URL(c.req.url).pathname,status:c.res.status,durationMs:Date.now()-started});});
 app.onError((e,c)=>{if(e instanceof ApiError){if(e.status===429)c.header('Retry-After','1');return c.json({type:'error',code:e.code,message:e.message,requestId:c.get('requestId')},e.status as 400);}if(e instanceof z.ZodError)return c.json({type:'error',code:'validation_error',message:'Request does not match the protocol',requestId:c.get('requestId')},400);return c.json({type:'error',code:'internal_error',message:'Request could not be completed',requestId:c.get('requestId')},500);});
 app.notFound(c=>c.json({type:'error',code:'not_found',message:'Endpoint not found'},404));
 app.get('/health',c=>c.json({type:'health',ok:true,mode:service.local?'local':'production'}));
 const devCreated=new Map<string,number>();
 const devTokens=new Map<string,string>([['dev-local','local-user']]);
 async function session(request:Request){
  if(options.resolveSession)return options.resolveSession(request);
  if(service.local){const token=request.headers.get('authorization')?.replace(/^Bearer /i,'')??request.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith('praxis_session='))?.slice('praxis_session='.length);const id=token?devTokens.get(token):undefined;if(id)return {user:{type:'user' as const,id,name:'Local developer'},expiresAt:new Date(Date.now()+86400000).toISOString()};return null;}
  throw new ApiError(503,'auth_unconfigured','Production authentication is not configured');
 }
 app.post('/v1/auth/dev',async c=>{
  if(!service.local)throw new ApiError(404,'not_found','Endpoint not found');
  const input=await body(c,z.object({type:z.literal('auth.dev'),userId:z.string().min(1).max(100).optional()}));const userId=input.userId??'local-user';const token=userId==='local-user'?'dev-local':randomUUID();await options.reopenDevUser?.(userId);await service.seed(userId);devTokens.set(token,userId);devCreated.set(token,Date.now());setCookie(c,'praxis_session',token,{httpOnly:true,sameSite:'Lax',path:'/',maxAge:86400});return c.json({type:'session',user:{type:'user',id:userId,name:'Local developer'},bearerToken:token,expiresAt:new Date(Date.now()+86400000).toISOString()});
 });
 const publicPaths=['/v1/connectors/oauth/callback','/v1/oauth/client-metadata.json',...(options.publicPaths??[])];
 const requestOwners=new WeakMap<Request,string>();
 const limited=async(key:string)=>{if(!options.rateLimit)return;const r=await options.rateLimit(key);if(!r.ok)throw new ApiError(429,'rate_limited',`Too many requests; retry in ${r.retryAfterSeconds??1}s`);};
 app.use('/v1/*',async(c,next)=>{if(publicPaths.some(p=>c.req.path===p||(p.endsWith('/')&&c.req.path.startsWith(p))||c.req.path.startsWith(`${p}?`))){await limited(`ip:${c.req.header('x-forwarded-for')?.split(',')[0]?.trim()??'unknown'}`);await next();return;}const auth=await session(c.req.raw);if(!auth)throw new ApiError(401,'unauthorized','Sign in to continue');c.set('userId',auth.user.id);requestOwners.set(c.req.raw,auth.user.id);await limited(`user:${auth.user.id}`);if(!(c.req.method==='DELETE'&&c.req.path===ACCOUNT_DELETE_PATH))await service.seed(auth.user.id);if(c.req.method!=='GET'&&c.req.method!=='HEAD'){const origin=c.req.header('origin');if(origin&&!originOk(origin))throw new ApiError(403,'origin_rejected','Origin is not allowed');}await next();});
 registerAccountDeletion(app,{config:options.accountDeletion,local:service.local,devTokens,devCreated,limited,hasLimiter:!!options.rateLimit,parse:c=>body(c,AccountDeleteSchema,true)});
 app.get('/v1/auth/session',async c=>{const auth=await session(c.req.raw);return c.json({type:'session',...auth});});
 if (service.local) {
  app.post('/v1/auth/sign-out', c => {
   const token = c.req.header('authorization')?.replace(/^Bearer /i, '') ?? getCookie(c, 'praxis_session');
   if (token) {
    devTokens.delete(token);
    devCreated.delete(token);
   }
   deleteCookie(c, 'praxis_session', {path: '/'});
   return c.json({type: 'ok'});
  });
 }
 app.get('/v1/bootstrap',async c=>{c.header('Cache-Control','private, no-store');return c.json(await service.bootstrap(c.get('userId')));});
 app.get('/v1/chats',async c=>{const query=PageQuerySchema.parse(c.req.query());let rows=await service.list<Chat>(c.get('userId'),'chat');if(query.q)rows=rows.filter(x=>x.title.toLowerCase().includes(query.q!.toLowerCase()));rows.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));return c.json(page(rows,query,`chats:${query.q??''}`));});
 app.post('/v1/chats',async c=>{const input=await body(c,ChatInputSchema);const now=service.now();const id=input.id??randomUUID();if(await service.adapters.store.get(c.get('userId'),'chat',id))throw new ApiError(409,'exists','Chat ID already exists');const chat=ChatSchema.parse({...input,type:'chat',id,createdAt:now,updatedAt:now});await service.write(c.get('userId'),'chat',id,chat);return c.json(chat,201);});
 app.get('/v1/search',async c=>{const query=PageQuerySchema.parse(c.req.query());c.header('Cache-Control','private, no-store');return c.json(page(await searchChats(service,c.get('userId'),query.q??''),query,`search:${query.q??''}`));});
 app.get('/v1/chats/:id',async c=>c.json(await service.require<Chat>(c.get('userId'),'chat',c.req.param('id'))));
 app.patch('/v1/chats/:id',async c=>{const id=c.req.param('id');await service.require<Chat>(c.get('userId'),'chat',id);const input=await body(c,ChatPatchSchema);const result=await service.updateChat(c.get('userId'),id,chat=>ChatSchema.parse({...chat,...input,...(input.title!==undefined?{titleRevision:crypto.randomUUID()}:{}),type:'chat',id,updatedAt:service.now()}));return c.json(result);});
 app.delete('/v1/chats/:id',async c=>{const user=c.get('userId'),id=c.req.param('id');const chat=await service.require<Chat>(user,'chat',id);if(chat.activeRunId)await service.cancel(user,chat.activeRunId);await service.remove(user,'chat',id);for(const m of await service.list<Message>(user,'message',id))await service.remove(user,'message',m.id);return c.json({type:'ok'});});
 app.get('/v1/chats/:id/messages',async c=>{const id=c.req.param('id'),user=c.get('userId');await service.require(user,'chat',id);const rows=(await service.list<Message>(user,'message',id)).sort((a,b)=>(a.sequence??0)-(b.sequence??0)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));return c.json(page(rows,PageQuerySchema.parse(c.req.query()),`messages:${id}`));});
 app.post('/v1/runs',async c=>{const input=await body(c,StartRunSchema);input.idempotencyKey??=c.req.header('Idempotency-Key');if(!service.local&&input.script)throw new ApiError(400,'local_only','Scripted runs are local only');return c.json(await service.start(c.get('userId'),input),202);});
 app.get('/v1/runs/:id',async c=>c.json(await service.require<Run>(c.get('userId'),'run',c.req.param('id'))));
 app.get('/v1/runs/:id/snapshot',async c=>c.json(RunSnapshotSchema.parse(await service.require(c.get('userId'),'snapshot',c.req.param('id')))));
 app.post('/v1/runs/:id/cancel',async c=>{await body(c,z.object({type:z.literal('run.cancel')}));return c.json(await service.cancel(c.get('userId'),c.req.param('id')),202);});
 app.post('/v1/runs/:id/approvals',async c=>c.json(await service.decision(c.get('userId'),c.req.param('id'),await body(c,ApprovalDecisionSchema)),202));
 const savedContext=(user:string)=>featureContext(service,user,{encryptionKey:options.encryptionKey});
 app.get('/v1/saved-values',async c=>{c.header('Cache-Control','private, no-store');const q=z.object({query:z.string().max(500).optional(),kind:z.enum(['secret','variable']).optional(),since:z.iso.datetime({offset:true}).optional(),cursor:z.string().max(4000).optional(),limit:z.coerce.number().int().min(1).max(200).default(50)}).parse(c.req.query());return c.json(await querySavedValues(savedContext(c.get('userId')),q));});
 app.post('/v1/saved-values',async c=>{
  const user=c.get('userId'),input=await body(c,z.object({name:z.string().trim().min(1).max(100),kind:z.enum(['secret','variable']),value:JsonValueSchema}).strict());
  const ctx=savedContext(user);
  if(input.kind==='secret'){
   if(typeof input.value!=='string'||!input.value)throw new ApiError(400,'invalid_value','Enter a secret value.');
   const reference=await saveSecret(ctx,input.name,input.value,true,'');
   return c.json((await savedValues(ctx)).find(v=>v.id===reference.slice(9,-2)),201);
  }
  const id=await saveVariable(ctx,input.name,input.value);return c.json((await savedValues(ctx)).find(v=>v.id===id),201);
 });
 app.patch('/v1/saved-values/:id',async c=>{
  const user=c.get('userId'),id=c.req.param('id'),input=await body(c,z.object({name:z.string().trim().min(1).max(100).optional(),value:JsonValueSchema.optional()}).strict().refine(v=>v.name!==undefined||v.value!==undefined));
  const secret=await service.adapters.store.get(user,'savedSecret',id);
  const kind=secret&&!secret.deleted&&secret.value.saved===true?'savedSecret':'savedVariable';
  const row=await service.require<JsonObject>(user,kind,id);
  if(input.value!==undefined){
   if(Buffer.byteLength(JSON.stringify(input.value))>64_000)throw new ApiError(413,'value_too_large','Saved values must be smaller than 64 KB.');
   if(kind==='savedSecret'){
    if(typeof input.value!=='string'||!input.value)throw new ApiError(400,'invalid_value','Enter a secret value.');
    await service.adapters.store.put(user,'savedSecretValue',id,{cipher:seal(input.value,user,'saved:'+id,options.encryptionKey)});
   }else row.value=input.value;
  }
  if(input.name!==undefined)row.name=input.name;
  await service.write(user,kind,id,row);return c.json({type:'ok'});
 });
 app.delete('/v1/saved-values/:id',async c=>{
  const user=c.get('userId'),id=c.req.param('id'),secret=await service.adapters.store.get(user,'savedSecret',id);
  const kind=secret&&!secret.deleted&&secret.value.saved===true?'savedSecret':'savedVariable';
  await service.remove(user,kind,id);if(kind==='savedSecret')await service.adapters.store.delete(user,'savedSecretValue',id);return c.json({type:'ok'});
 });
 app.get('/v1/saved-secrets',async c=>c.json({items:await secretMetadata(featureContext(service,c.get('userId'),{encryptionKey:options.encryptionKey}))}));
 app.patch('/v1/saved-secrets/:id',async c=>{const u=c.get('userId'),id=c.req.param('id'),row=await service.require<JsonObject>(u,'savedSecret',id);const input=await body(c,z.object({name:z.string().trim().min(1).max(100)}));await service.write(u,'savedSecret',id,{...row,name:input.name});return c.json({type:'ok'});});
 app.delete('/v1/saved-secrets/:id',async c=>{const u=c.get('userId'),id=c.req.param('id');await service.remove(u,'savedSecret',id);await service.adapters.store.delete(u,'savedSecretValue',id);return c.json({type:'ok'});});
 app.post('/v1/runs/:id/elicitations',async c=>{
  const user=c.get('userId'),id=c.req.param('id'),answer=await body(c,ElicitationResponseSchema);
  if(answer.action==='accept'&&answer.content){
   const snapshot=await service.require<import('@praxis/protocol').RunSnapshot>(user,'snapshot',id);
   const pending=snapshot.pendingElicitations.find(e=>e.id===answer.elicitationId);
   if(pending)answer.content=await protectAnswer(featureContext(service,user,{encryptionKey:options.encryptionKey}),snapshot.run.chatId,pending.schema,answer.content);
  }
  return c.json(await service.decision(user,id,answer),202);
 });
 app.get('/v1/runs/:id/events',async c=>{
  const user=c.get('userId'),runId=c.req.param('id');await service.require<Run>(user,'run',runId);let after=eventCursor(c);
  const first=await service.adapters.events.read(user,`run:${runId}`,after,100);if(first.length&&first[0]!.id>after+1)throw new ApiError(409,'cursor_expired','Fetch the run snapshot before reconnecting');
  c.header('Cache-Control','no-cache, no-transform');c.header('X-Accel-Buffering','no');return streamSSE(c,async stream=>{
   let heartbeat=Date.now();while(!stream.aborted){const records=await service.adapters.events.read(user,`run:${runId}`,after,100);for(const r of records){const payload=RunEventSchema.parse({type:'run.event',id:r.id,runId,chatId:r.payload.chatId,createdAt:r.payload.createdAt,event:r.payload.event});await stream.writeSSE({id:String(r.id),event:'run.event',data:JSON.stringify(payload)});after=r.id;if(payload.event.type==='run.finished')return;}
    const current=await service.require<Run>(user,'run',runId);if(service.terminal(current)&&after>=current.lastEventId)return;
    if(Date.now()-heartbeat>15000){await stream.write(': keepalive\n\n');heartbeat=Date.now();}await stream.sleep(30);
   }
  },async()=>{});
 });
 app.get('/v1/events',async c=>{const user=c.get('userId');let after=eventCursor(c);c.header('Cache-Control','no-cache, no-transform');c.header('X-Accel-Buffering','no');return streamSSE(c,async stream=>{let heartbeat=Date.now();while(!stream.aborted){for(const e of await service.adapters.events.read(user,'user',after,100)){await stream.writeSSE({id:String(e.id),event:'user.event',data:JSON.stringify({type:'user.event',id:e.id,...e.payload,syncCursor:String(e.id),...(e.payload.type?{type:'user.event'}:{})})});after=e.id;}if(Date.now()-heartbeat>15000){await stream.write(': keepalive\n\n');heartbeat=Date.now();}await stream.sleep(100);}},async()=>{});});
 registerModelRoutes(app,models);
 app.post('/v1/chats/:id/truncate',async c=>{const input=await body(c,ChatTruncateSchema);return c.json(await service.truncate(c.get('userId'),c.req.param('id'),input.clientTurnId));});
 app.get('/v1/consents',async c=>c.json(page(await service.list(c.get('userId'),'consent'),PageQuerySchema.parse(c.req.query()),'consents')));
 app.post('/v1/consents',async c=>{const input=await body(c,ConsentSchema);const consent={...input,host:input.host.toLowerCase(),updatedAt:service.now()};await service.write(c.get('userId'),'consent',consent.host,consent);return c.json(consent);});
 app.get('/v1/preferences',async c=>c.json(await preferences(c.get('userId'))));
 app.patch('/v1/preferences',async c=>{const user=c.get('userId'),input=await body(c,PreferencesInputSchema);const current=await preferences(user);if(input.vision)current.vision={...current.vision,...input.vision};if(input.voice){const {apiKey,...publicPrefs}=input.voice;current.voice={...current.voice,...publicPrefs};if(apiKey){await service.put(user,'voiceSecret','current',{key:seal(apiKey,user,'voice',options.encryptionKey)});current.voice.configured=true;}}current.updatedAt=service.now();await service.write(user,'preferences','current',current,'consent');return c.json(current);});
 async function preferences(user:string){const existing=await service.adapters.store.get(user,'preferences','current');return PreferencesSchema.parse(existing?.value??{type:'preferences',vision:{},voice:{configured:platformVoice().pool.slots.length>0},updatedAt:service.now()});}
 app.get('/v1/runs/:runId/outputs/:id',async c=>{await service.require(c.get('userId'),'run',c.req.param('runId'));const output=await service.require<JsonObject>(c.get('userId'),'output',c.req.param('id'));if(output.runId!==c.req.param('runId'))throw new ApiError(404,'not_found','Output not found');const offset=z.coerce.number().int().nonnegative().parse(c.req.query('offset')??0),limit=z.coerce.number().int().min(1).max(100000).parse(c.req.query('limit')??16000);const text=String(output.text??'');return c.json({type:'tool.output',id:c.req.param('id'),text:text.slice(offset,offset+limit),offset,nextOffset:offset+limit<text.length?offset+limit:null});});
 registerSyncRoutes(app,service);
 options.mount?.(app,async request=>{const owner=requestOwners.get(request);const pathname=new URL(request.url).pathname;if(!owner&&!publicPaths.includes(pathname))throw new ApiError(401,'unauthorized','Sign in to continue');return featureContext(service,owner??'',{...(owner?{}:{unpinned:true}),...(options.fetcher?{fetch:options.fetcher}:{}),...(options.encryptionKey?{encryptionKey:options.encryptionKey}:{})});});
 return {app,session};
}
function eventCursor(c:Context){const raw=c.req.header('Last-Event-ID')??c.req.query('after')??'0';if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))throw new ApiError(400,'invalid_cursor','Invalid event cursor');return Number(raw);}
